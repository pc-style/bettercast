import { solNative } from "./SolNative";
import {
	UTF8StreamDecoder,
	type AIStreamEvent,
	type AITransport,
} from "./ai-engine";

export const requestID = () =>
	`job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** Bounded event queue shared by native HTTP and process streaming. No helper is started until called. */
export function nativeStream(
	request: Record<string, unknown>,
	signal: AbortSignal,
) {
	const id = requestID();
	const chunks: Uint8Array[] = [];
	let bytes = 0,
		done = false,
		error: unknown,
		wake = () => {};
	let resolveHeaders: (value: any) => void = () => {},
		rejectHeaders: (error: unknown) => void = () => {};
	const headers = new Promise<any>((resolve, reject) => {
		resolveHeaders = resolve;
		rejectHeaders = reject;
	});
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		subscription.remove();
		signal.removeEventListener("abort", abort);
	};
	// Processes have no HTTP header event.
	if (request.op !== "http") resolveHeaders({ status: 200, headers: {} });
	const abort = () => {
		if (done) return;
		error = new Error("Cancelled");
		done = true;
		void solNative.workspaceRequest({ op: "cancel", id });
		rejectHeaders(error);
		wake();
		cleanup();
	};
	const subscription = solNative.addListener("workspaceChunk", (event: any) => {
		if (event.id !== id || done) return;
		if (event.headers) {
			resolveHeaders(event);
			return;
		}
		if (event.bytes) {
			bytes += event.bytes.length;
			if (bytes > 16_777_216) {
				abort();
				return;
			}
			chunks.push(Uint8Array.from(event.bytes));
			wake();
		}
	});
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	else
		void solNative.workspaceRequest({ ...request, id }).then(
			() => {
				done = true;
				wake();
				resolveHeaders({ status: 200, headers: {} });
				cleanup();
			},
			(failure) => {
				error = failure;
				done = true;
				rejectHeaders(failure);
				wake();
				cleanup();
			},
		);
	const generator = (async function* () {
		try {
			while (!done || chunks.length) {
				if (error) throw error;
				const chunk = chunks.shift();
				if (chunk) {
					bytes -= chunk.length;
					yield chunk;
				} else
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
			}
			if (error) throw error;
		} finally {
			if (!done) abort();
			cleanup();
		}
	})();
	const iterator: AsyncGenerator<Uint8Array, void, unknown> = {
		next: (value?: unknown) => generator.next(value),
		return: async () => {
			if (!done) abort();
			return generator.return(undefined);
		},
		throw: (failure?: unknown) => generator.throw(failure),
		[Symbol.asyncIterator]() {
			return this;
		},
		[Symbol.asyncDispose]: async () => {
			await iterator.return(undefined);
		},
	};
	return { headers, iterator };
}
export function nativeFetch(account?: string): typeof fetch {
	return (async (endpoint: any, options: any) => {
		const signal = options.signal ?? new AbortController().signal;
		const stream = nativeStream(
			{
				op: "http",
				endpoint: String(endpoint),
				body: options.body,
				headers: options.headers,
				...(account ? { account } : {}),
			},
			signal,
		);
		const response = await stream.headers;
		const iterator = stream.iterator;
		return {
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			headers: {
				get: (name: string) => response.headers[name.toLowerCase()] ?? null,
			},
			body: {
				[Symbol.asyncIterator]: () => iterator,
				getReader: () => ({
					read: () => iterator.next(),
					cancel: () => iterator.return(undefined),
				}),
			},
			json: async () => {
				const decoder = new UTF8StreamDecoder();
				let text = "";
				for await (const chunk of iterator) text += decoder.decode(chunk);
				return JSON.parse(text + decoder.finish());
			},
		};
	}) as unknown as typeof fetch;
}
export function claudeTransport(): AITransport {
	return {
		capabilities: { streaming: true, maxContextChars: 120_000 },
		async *stream({ messages, signal }) {
			if (messages.some((message) => typeof message.content !== "string"))
				throw new Error("Installed Claude adapter accepts text context only");
			const prompt = messages
				.map((message) => `${message.role.toUpperCase()}: ${message.content}`)
				.join("\n\n");
			const stream = nativeStream({ op: "claude", prompt }, signal);
			await stream.headers;
			const decoder = new UTF8StreamDecoder();
			let buffer = "",
				finished = false;
			const parse = (line: string) => {
				if (!line.trim()) return null;
				const packet = JSON.parse(line);
				if (
					packet.type === "stream_event" &&
					packet.event?.type === "content_block_delta" &&
					packet.event.delta?.type === "text_delta"
				)
					return {
						type: "text",
						text: packet.event.delta.text,
					} as AIStreamEvent;
				if (packet.type === "result") {
					if (packet.is_error) throw new Error("Claude CLI returned an error");
					finished = true;
					return { type: "done" } as AIStreamEvent;
				}
				return null;
			};
			for await (const chunk of stream.iterator) {
				buffer += decoder.decode(chunk);
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					const event = parse(line);
					if (event) yield event;
				}
			}
			buffer += decoder.finish();
			const trailing = parse(buffer);
			if (trailing) yield trailing;
			if (!finished)
				throw new Error(
					"Claude streaming result incomplete. Verify installed CLI supports stream-json and partial messages.",
				);
		},
	};
}
