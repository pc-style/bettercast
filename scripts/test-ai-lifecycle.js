// Isolated process: module mocks must not replace other suites' native bridge fixtures.
import { beforeEach, expect, mock, test } from "bun:test";
const documents = new Map();
const listeners = new Set();
let calls = [],
	failRead = false,
	failHTTP = false,
	removeCount = 0;
let beforeWrite;
const native = {
	getAIProviders: async () => [{ provider: "claude", available: true }],
	async clipboardRequest(request) {
		calls.push(request);
		return {
			config: {
				retentionDays: 30,
				capBytes: 1024,
				excludedBundleIds: [],
				skipSensitive: true,
			},
			capture: { status: "private" },
			retention: null,
		};
	},
	addListener(_event, listener) {
		listeners.add(listener);
		return {
			remove() {
				if (listeners.delete(listener)) removeCount++;
			},
		};
	},
	async workspaceRequest(request) {
		calls.push(request);
		if (request.op === "readDocument") {
			if (failRead) throw new Error("Vault unavailable");
			return documents.get(request.id) ?? null;
		}
		if (request.op === "writeDocument") {
			await beforeWrite?.(request);
			documents.set(request.id, request.value);
			return;
		}
		if (request.op === "http" && failHTTP)
			throw new Error("Connection refused before headers");
		if (request.op === "claude") {
			await new Promise((resolve) => setTimeout(resolve, 10));
			const output =
				JSON.stringify({
					type: "stream_event",
					event: {
						type: "content_block_delta",
						delta: { type: "text_delta", text: "synthetic response" },
					},
				}) +
				"\n" +
				JSON.stringify({ type: "result", is_error: false });
			for (const listener of listeners)
				listener({
					id: request.id,
					bytes: [...new TextEncoder().encode(output)],
				});
		}
	},
};
mock.module("../src/lib/SolNative", () => ({ solNative: native }));
mock.module("../src/stores/ui.store", () => ({
	Widget: { CLIPBOARD: "clipboard" },
}));
const { createAIStore } = await import("../src/stores/ai.store");
const { createClipboardStore } = await import("../src/stores/clipboard.store");
const { nativeStream } = await import("../src/lib/native-stream");
const make = () =>
	createAIStore({
		mcp: {
			registeredTools: [],
			initialize: async () => {},
			closeClients: async () => {},
		},
	});
beforeEach(() => {
	documents.clear();
	calls = [];
	listeners.clear();
	failRead = false;
	failHTTP = false;
	removeCount = 0;
	beforeWrite = undefined;
});

test("search preflight preserves draft and does not create a user message or dispatch", async () => {
	const ai = make();
	await ai.initialize();
	ai.setDraft({ text: "keep this draft", webSearch: true });
	await ai.send();
	expect(ai.draft.text).toBe("keep this draft");
	expect(ai.messages).toHaveLength(0);
	expect(ai.error).toContain("real search tool");
	expect(calls.filter((r) => r.op === "claude")).toHaveLength(0);
});
test("concurrent send dispatches once and accepts trailing CLI JSON without newline", async () => {
	const ai = make();
	await ai.initialize();
	ai.setDraft({ text: "synthetic input" });
	await Promise.all([ai.send(), ai.send()]);
	expect(calls.filter((r) => r.op === "claude")).toHaveLength(1);
	expect(ai.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	expect(ai.messages[1].blocks[0].text).toBe("synthetic response");
	expect(ai.messages[1].status).toBe("done");
	expect(ai.busy).toBe(false);
	expect(ai.draft.text).toBe("");
	expect(listeners.size).toBe(0);
});
test("unreadable encrypted state never enables writes or sends", async () => {
	failRead = true;
	const ai = make();
	ai.setDraft({ text: "keep locally" });
	await ai.send();
	expect(ai.initialized).toBe(false);
	expect(ai.draft.text).toBe("keep locally");
	expect(calls.some((r) => r.op === "writeDocument" || r.op === "claude")).toBe(
		false,
	);
});
test("changing endpoint without a new key never reuses the old account", async () => {
	const ai = make();
	await ai.initialize();
	const input = {
		id: "compatible",
		label: "Configured test",
		endpoint: "https://first.example.test/chat/completions",
		modelId: "test-model",
		images: true,
		tools: true,
		apiKey: "synthetic-not-a-real-key",
	};
	await ai.configureProvider(input);
	expect(JSON.parse(documents.get("ai-index")).config.account).toBe(
		"provider-compatible",
	);
	await ai.configureProvider({
		...input,
		endpoint: "https://other.example.test/chat/completions",
		apiKey: undefined,
	});
	expect(JSON.parse(documents.get("ai-index")).config.account).toBeUndefined();
});
test("HTTP header failure removes native listener even before iteration", async () => {
	failHTTP = true;
	const stream = nativeStream({ op: "http" }, new AbortController().signal);
	await expect(stream.headers).rejects.toThrow("Connection refused");
	expect(listeners.size).toBe(0);
	expect(removeCount).toBe(1);
});
test("return before iteration cancels native operation and releases listener", async () => {
	const stream = nativeStream({ op: "claude" }, new AbortController().signal);
	await stream.headers;
	await stream.iterator.return();
	expect(calls.some((r) => r.op === "cancel")).toBe(true);
	expect(listeners.size).toBe(0);
});
test("cancel while persisting never dispatches later or discards the unsent draft", async () => {
	const ai = make();
	await ai.initialize();
	ai.setDraft({ text: "do not dispatch" });
	beforeWrite = () => {
		ai.cancel();
	};
	await ai.send();
	expect(calls.some((r) => r.op === "claude")).toBe(false);
	expect(ai.draft.text).toBe("do not dispatch");
	expect(ai.busy).toBe(false);
});
test("replacement does not pretend an ordinary paste replaced a captured selection", async () => {
	const ai = make();
	await ai.initialize();
	expect((await ai.insert("missing", "replace")).status).toBe("failed");
	expect(calls.some((r) => r.op === "pasteText")).toBe(false);
});
test("resume leaves capture private until explicit confirmation and changes policy atomically", async () => {
	let accept;
	const clipboard = createClipboardStore({
		ui: {
			focusedWidget: "search",
			query: "",
			confirm(_message, callback) {
				accept = callback;
			},
		},
	});
	await Promise.resolve();
	clipboard.resumeCapture();
	expect(calls.filter((request) => request.op === "configure")).toEqual([]);
	accept();
	await Promise.resolve();
	expect(calls.filter((request) => request.op === "configure")).toEqual([
		{
			op: "configure",
			config: { enabled: true, paused: false, pauseUntil: 0, private: false },
		},
	]);
	clipboard.cleanUp();
});
