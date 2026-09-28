/** Provider-neutral AI orchestration. This module performs no credential discovery. */
export type JSONValue =
	| null
	| boolean
	| number
	| string
	| JSONValue[]
	| { [key: string]: JSONValue };

export type AIContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string; name?: string };
export interface AIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | AIContentBlock[];
	toolCallId?: string;
	toolCalls?: AIToolCall[];
}
export interface AITool {
	name: string;
	description?: string;
	inputSchema: Record<string, JSONValue>;
}
export interface AIToolCall {
	id: string;
	name: string;
	arguments: Record<string, JSONValue>;
}
export type AIStreamEvent =
	| { type: "text"; text: string }
	| { type: "tool-call"; call: AIToolCall }
	| { type: "done"; finishReason?: string };

export interface AIProviderCapabilities {
	streaming: boolean;
	tools?: boolean;
	imageMimeTypes?: readonly string[];
	maxAttachmentBytes?: number;
	maxContextChars?: number;
}
export interface AITransportRequest {
	messages: AIMessage[];
	tools?: AITool[];
	signal: AbortSignal;
}
export interface AITransport {
	capabilities: AIProviderCapabilities;
	stream(request: AITransportRequest): AsyncIterable<AIStreamEvent>;
}
export interface ToolExecutor {
	call(
		name: string,
		args: Record<string, JSONValue>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface ToolApprovalRequest {
	callId: string;
	name: string;
	arguments: Readonly<Record<string, JSONValue>>;
}
export type Approval = (
	request: ToolApprovalRequest,
) => boolean | Promise<boolean>;
export interface RunAIOptions {
	transport: AITransport;
	messages: AIMessage[];
	tools?: AITool[];
	toolExecutor?: ToolExecutor;
	approveToolCall?: Approval;
	signal?: AbortSignal;
	maxToolRounds?: number;
	onEvent?: (event: AIStreamEvent) => void;
}
export interface RunAIResult {
	text: string;
	messages: AIMessage[];
	toolCalls: AIToolCall[];
}

/** Source links must originate in tool output, never a guessed model citation. */
export function extractToolSources(
	value: unknown,
): Array<{ url: string; title?: string }> {
	const found = new Map<string, { url: string; title?: string }>();
	let visited = 0;
	const walk = (input: any, depth: number) => {
		if (depth > 8 || found.size >= 30 || ++visited > 2000 || !input) return;
		if (Array.isArray(input)) {
			input.slice(0, 100).forEach((item) => walk(item, depth + 1));
		} else if (typeof input === "object") {
			// Microsoft Learn returns contentUrl; other search tools commonly use url.
			const candidate = input.url ?? input.contentUrl;
			if (typeof candidate === "string") {
				try {
					const url: any = new URL(candidate);
					if (
						["http:", "https:"].includes(url.protocol) &&
						!url.username &&
						!url.password
					)
						found.set(url.href, {
							url: url.href,
							title: typeof input.title === "string" ? input.title : undefined,
						});
				} catch {}
			}
			Object.values(input).forEach((item) => walk(item, depth + 1));
		} else if (typeof input === "string" && input.length < 1_048_576) {
			try {
				walk(JSON.parse(input), depth + 1);
			} catch {}
		}
	};
	walk(value, 0);
	return [...found.values()];
}

export class AIEngineError extends Error {
	constructor(
		public readonly code:
			| "INVALID_CONTEXT"
			| "UNSUPPORTED_CAPABILITY"
			| "APPROVAL_DENIED"
			| "CANCELLED"
			| "LIMIT_EXCEEDED"
			| "PROTOCOL_ERROR",
		message: string,
	) {
		super(message);
		this.name = "AIEngineError";
	}
}

const abortError = () =>
	new AIEngineError("CANCELLED", "AI request was cancelled");
const cloneJSON = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const assertRecord = (value: unknown): value is Record<string, JSONValue> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const freezeJSON = (value: JSONValue): void => {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freezeJSON);
		Object.freeze(value);
	}
};

export function validateMessages(
	messages: AIMessage[],
	capabilities: AIProviderCapabilities,
): void {
	if (!Array.isArray(messages) || messages.length === 0)
		throw new AIEngineError(
			"INVALID_CONTEXT",
			"At least one message is required",
		);
	let chars = 0;
	for (const message of messages) {
		if (!["system", "user", "assistant", "tool"].includes(message.role))
			throw new AIEngineError("INVALID_CONTEXT", "Invalid message role");
		if (message.role === "tool" && !message.toolCallId)
			throw new AIEngineError(
				"INVALID_CONTEXT",
				"Tool messages require toolCallId",
			);
		const blocks =
			typeof message.content === "string"
				? [{ type: "text" as const, text: message.content }]
				: message.content;
		if (
			(!Array.isArray(blocks) || blocks.length === 0) &&
			!(message.role === "assistant" && message.toolCalls?.length)
		)
			throw new AIEngineError(
				"INVALID_CONTEXT",
				"Message content cannot be empty",
			);
		for (const block of blocks) {
			if (block.type === "text") chars += block.text.length;
			else if (block.type === "image") {
				if (!capabilities.imageMimeTypes?.includes(block.mimeType))
					throw new AIEngineError(
						"UNSUPPORTED_CAPABILITY",
						`Image attachment ${block.mimeType} is not supported`,
					);
				const bytes = Math.floor((block.data.length * 3) / 4);
				if (bytes > (capabilities.maxAttachmentBytes ?? 0))
					throw new AIEngineError(
						"LIMIT_EXCEEDED",
						"Attachment exceeds provider limit",
					);
			} else
				throw new AIEngineError("INVALID_CONTEXT", "Unknown content block");
		}
	}
	if (chars > (capabilities.maxContextChars ?? Number.MAX_SAFE_INTEGER))
		throw new AIEngineError("LIMIT_EXCEEDED", "Context exceeds provider limit");
}

/** Stable, local-only serialization; suitable for persistence but never sends data. */
export function serializeMessages(messages: AIMessage[]): string {
	validateMessages(messages, {
		streaming: true,
		imageMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
		maxAttachmentBytes: Number.MAX_SAFE_INTEGER,
	});
	return JSON.stringify(messages);
}
export function deserializeMessages(value: string): AIMessage[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new AIEngineError("INVALID_CONTEXT", "Invalid serialized messages");
	}
	validateMessages(parsed as AIMessage[], {
		streaming: true,
		imageMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
		maxAttachmentBytes: Number.MAX_SAFE_INTEGER,
	});
	return parsed as AIMessage[];
}

export async function runAI(options: RunAIOptions): Promise<RunAIResult> {
	const { transport } = options;
	if (!transport.capabilities.streaming)
		throw new AIEngineError(
			"UNSUPPORTED_CAPABILITY",
			"Provider does not advertise streaming",
		);
	if (
		options.tools?.length &&
		(!transport.capabilities.tools ||
			!options.toolExecutor ||
			!options.approveToolCall)
	)
		throw new AIEngineError(
			"UNSUPPORTED_CAPABILITY",
			"Tools require provider support, an executor, and per-call approval",
		);
	validateMessages(options.messages, transport.capabilities);
	const signal = options.signal ?? new AbortController().signal;
	const messages = cloneJSON(options.messages);
	const allCalls: AIToolCall[] = [];
	let completeText = "";
	for (let round = 0; round <= (options.maxToolRounds ?? 8); round++) {
		if (signal.aborted) throw abortError();
		let roundText = "";
		const calls: AIToolCall[] = [];
		try {
			for await (const event of transport.stream({
				messages: cloneJSON(messages),
				tools: options.tools,
				signal,
			})) {
				if (signal.aborted) throw abortError();
				options.onEvent?.(event);
				if (event.type === "text") {
					roundText += event.text;
					completeText += event.text;
					if (completeText.length > 1_048_576)
						throw new AIEngineError(
							"LIMIT_EXCEEDED",
							"Response exceeded 1 MiB",
						);
				} else if (event.type === "tool-call")
					calls.push(cloneJSON(event.call));
			}
		} catch (error) {
			if (signal.aborted) throw abortError();
			throw error;
		}
		if (!calls.length) {
			messages.push({ role: "assistant", content: roundText });
			return { text: completeText, messages, toolCalls: allCalls };
		}
		if (round === (options.maxToolRounds ?? 8))
			throw new AIEngineError("LIMIT_EXCEEDED", "Maximum tool rounds exceeded");
		messages.push({
			role: "assistant",
			content: roundText,
			toolCalls: cloneJSON(calls),
		});
		for (const call of calls) {
			if (
				!options.tools?.some((tool) => tool.name === call.name) ||
				calls.length > 32
			)
				throw new AIEngineError(
					"PROTOCOL_ERROR",
					"Provider requested an unadvertised tool or too many calls",
				);
			if (!assertRecord(call.arguments))
				throw new AIEngineError(
					"PROTOCOL_ERROR",
					"Tool arguments must be an object",
				);
			const bound = cloneJSON(call);
			freezeJSON(bound.arguments);
			const approved = await options.approveToolCall!({
				callId: bound.id,
				name: bound.name,
				arguments: bound.arguments,
			});
			if (!approved)
				throw new AIEngineError(
					"APPROVAL_DENIED",
					`Tool call denied: ${bound.name}`,
				);
			if (signal.aborted) throw abortError();
			// Only the snapshotted arguments shown to approval are executed.
			const result = await options.toolExecutor!.call(
				bound.name,
				cloneJSON(bound.arguments),
				signal,
			);
			if (signal.aborted) throw abortError();
			const serialized = JSON.stringify(result ?? null);
			if (serialized.length > 1_048_576)
				throw new AIEngineError("LIMIT_EXCEEDED", "Tool result exceeded 1 MiB");
			allCalls.push(bound);
			messages.push({
				role: "tool",
				toolCallId: bound.id,
				content: serialized,
			});
		}
	}
	throw new AIEngineError("LIMIT_EXCEEDED", "Maximum tool rounds exceeded");
}

export interface OpenAIEndpointConfig {
	endpoint: string;
	model: string;
	apiKey?: string;
	headers?: Record<string, string>;
	capabilities: AIProviderCapabilities;
	fetch?: typeof globalThis.fetch;
}

/** OpenAI chat-completions compatible endpoint. Auth is accepted only from explicit config. */
export function createOpenAITransport(
	config: OpenAIEndpointConfig,
): AITransport {
	const fetcher = config.fetch ?? globalThis.fetch;
	return {
		capabilities: config.capabilities,
		async *stream(request) {
			const body = {
				model: config.model,
				stream: true,
				messages: request.messages.map(toOpenAIMessage),
				tools: request.tools?.map((t) => ({
					type: "function",
					function: {
						name: t.name,
						description: t.description,
						parameters: t.inputSchema,
					},
				})),
			};
			const response: any = await fetcher(config.endpoint, {
				method: "POST",
				signal: request.signal,
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					...(config.apiKey
						? { Authorization: `Bearer ${config.apiKey}` }
						: {}),
					...config.headers,
				},
				body: JSON.stringify(body),
			});
			if (!response.ok || !response.body)
				throw new AIEngineError(
					"PROTOCOL_ERROR",
					`Provider HTTP ${response.status}`,
				);
			const decoder = new UTF8StreamDecoder();
			let buffer = "";
			let finished = false;
			const toolParts = new Map<
				number,
				{ id: string; name: string; args: string }
			>();
			const consume = function* (frame: string): Generator<AIStreamEvent> {
				const data = frame
					.split(/\r?\n/)
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trimStart())
					.join("\n");
				if (!data || data === "[DONE]") return;
				let packet: any;
				try {
					packet = JSON.parse(data);
				} catch {
					throw new AIEngineError(
						"PROTOCOL_ERROR",
						"Malformed provider SSE JSON",
					);
				}
				const choice = packet.choices?.[0];
				const delta = choice?.delta ?? {};
				if (typeof delta.content === "string")
					yield { type: "text", text: delta.content };
				for (const part of delta.tool_calls ?? []) {
					const current = toolParts.get(part.index) ?? {
						id: "",
						name: "",
						args: "",
					};
					current.id += part.id ?? "";
					current.name += part.function?.name ?? "";
					current.args += part.function?.arguments ?? "";
					toolParts.set(part.index, current);
				}
				if (choice?.finish_reason === "tool_calls")
					for (const part of [...toolParts.values()]) {
						let args: unknown;
						try {
							args = JSON.parse(part.args || "{}");
						} catch {
							throw new AIEngineError(
								"PROTOCOL_ERROR",
								"Malformed streamed tool arguments",
							);
						}
						if (!assertRecord(args))
							throw new AIEngineError(
								"PROTOCOL_ERROR",
								"Tool arguments must be an object",
							);
						yield {
							type: "tool-call",
							call: { id: part.id, name: part.name, arguments: args },
						};
					}
				if (packet.error)
					throw new AIEngineError(
						"PROTOCOL_ERROR",
						"Provider returned an error",
					);
				if (choice?.finish_reason) {
					finished = true;
					yield { type: "done", finishReason: choice.finish_reason };
				}
			};
			for await (const chunk of response.body as any) {
				buffer += decoder.decode(chunk);
				if (buffer.length > 1_048_576)
					throw new AIEngineError("LIMIT_EXCEEDED", "Provider frame too large");
				let split;
				while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
					const frame = buffer.slice(0, split);
					const match = buffer.slice(split).match(/^\r?\n\r?\n/)![0];
					buffer = buffer.slice(split + match.length);
					yield* consume(frame);
				}
			}
			buffer += decoder.finish();
			if (buffer.trim()) yield* consume(buffer);
			if (!finished)
				throw new AIEngineError(
					"PROTOCOL_ERROR",
					"Provider stream ended before completion",
				);
		},
	};
}

export class UTF8StreamDecoder {
	private pending: number[] = [];
	decode(chunk: Uint8Array): string {
		const bytes = this.pending.concat(Array.from(chunk));
		let lead = bytes.length - 1;
		while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
		const width =
			lead < 0 || bytes[lead] < 0xc0
				? 1
				: bytes[lead] >= 0xf0
					? 4
					: bytes[lead] >= 0xe0
						? 3
						: 2;
		this.pending =
			lead >= 0 && bytes.length - lead < width ? bytes.splice(lead) : [];
		return decodeURIComponent(
			bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
		);
	}
	finish(): string {
		if (!this.pending.length) return "";
		const value = decodeURIComponent(
			this.pending
				.map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
				.join(""),
		);
		this.pending = [];
		return value;
	}
}

function toOpenAIMessage(message: AIMessage): unknown {
	const content =
		typeof message.content === "string"
			? message.content
			: message.content.map((block) =>
					block.type === "text"
						? { type: "text", text: block.text }
						: {
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							},
				);
	return {
		role: message.role,
		content,
		...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
		...(message.toolCalls
			? {
					tool_calls: message.toolCalls.map((call) => ({
						id: call.id,
						type: "function",
						function: {
							name: call.name,
							arguments: JSON.stringify(call.arguments),
						},
					})),
				}
			: {}),
	};
}
