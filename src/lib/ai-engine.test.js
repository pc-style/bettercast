import { describe, expect, test } from "bun:test";
import {
	AIEngineError,
	createOpenAITransport,
	extractToolSources,
	runAI,
	validateMessages,
} from "./ai-engine.ts";

const message = [{ role: "user", content: "hello" }];
const tool = { name: "search", inputSchema: { type: "object" } };
const events = (...rounds) => ({
	capabilities: { streaming: true, tools: true },
	round: 0,
	async *stream() {
		yield* rounds[this.round++];
	},
});

describe("AI engine trust boundary", () => {
	test("source cards accept actual Learn contentUrl output and reject unsafe or invented links", () => {
		const result = {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						results: [
							{
								title: "Compiler reference",
								contentUrl: "https://learn.microsoft.com/typescript/reference",
								content: "See https://invented.example.test in prose",
							},
							{ title: "Other docs", url: "https://example.test/reference" },
							{ title: "Unsafe", url: "javascript:alert(1)" },
							{
								title: "Credentials",
								url: "https://name:password@example.test/",
							},
						],
					}),
				},
			],
		};
		expect(extractToolSources(result)).toEqual([
			{
				title: "Compiler reference",
				url: "https://learn.microsoft.com/typescript/reference",
			},
			{ title: "Other docs", url: "https://example.test/reference" },
		]);
	});
	test("denial never invokes a tool", async () => {
		let invoked = 0;
		const transport = events([
			{
				type: "tool-call",
				call: { id: "1", name: "search", arguments: { q: "real" } },
			},
		]);
		await expect(
			runAI({
				transport,
				messages: message,
				tools: [tool],
				approveToolCall: () => false,
				toolExecutor: {
					async call() {
						invoked++;
					},
				},
			}),
		).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
		expect(invoked).toBe(0);
	});

	test("executes the exact snapshotted arguments and approval can be revoked per call", async () => {
		const seen = [];
		let approvals = 0;
		const transport = events([
			{
				type: "tool-call",
				call: { id: "1", name: "search", arguments: { q: "one" } },
			},
			{
				type: "tool-call",
				call: { id: "2", name: "search", arguments: { q: "two" } },
			},
		]);
		await expect(
			runAI({
				transport,
				messages: message,
				tools: [tool],
				approveToolCall: (request) => {
					approvals++;
					try {
						request.arguments.q = "changed";
					} catch {}
					return approvals === 1;
				},
				toolExecutor: {
					async call(_name, args) {
						seen.push(args);
						return {};
					},
				},
			}),
		).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
		expect(seen).toEqual([{ q: "one" }]);
	});

	test("cancellation is enforced outside model output", async () => {
		const controller = new AbortController();
		const transport = {
			capabilities: { streaming: true },
			async *stream() {
				controller.abort();
				yield { type: "text", text: "ignore" };
			},
		};
		await expect(
			runAI({ transport, messages: message, signal: controller.signal }),
		).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test("rejects unsupported and oversized attachments explicitly", () => {
		expect(() =>
			validateMessages(
				[
					{
						role: "user",
						content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
					},
				],
				{ streaming: true },
			),
		).toThrow(AIEngineError);
		expect(() =>
			validateMessages(
				[
					{
						role: "user",
						content: [
							{ type: "image", mimeType: "image/png", data: "AAAAAAAA" },
						],
					},
				],
				{
					streaming: true,
					imageMimeTypes: ["image/png"],
					maxAttachmentBytes: 2,
				},
			),
		).toThrow(/limit/i);
	});

	test("reassembles fragmented SSE and streamed tool JSON", async () => {
		const payload = [
			'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"sea","arguments":"{\\"q\\":"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"rch","arguments":"\\"web\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		].join("");
		const bytes = new TextEncoder().encode(payload);
		const body = new ReadableStream({
			start(c) {
				for (let i = 0; i < bytes.length; i += 7)
					c.enqueue(bytes.slice(i, i + 7));
				c.close();
			},
		});
		const transport = createOpenAITransport({
			endpoint: "https://configured.invalid/v1/chat/completions",
			model: "configured",
			capabilities: { streaming: true, tools: true },
			fetch: async () =>
				new Response(body, {
					headers: { "content-type": "text/event-stream" },
				}),
		});
		const output = [];
		for await (const event of transport.stream({
			messages: message,
			tools: [tool],
			signal: new AbortController().signal,
		}))
			output.push(event);
		expect(output).toContainEqual({ type: "text", text: "Hi " });
		expect(output).toContainEqual({
			type: "tool-call",
			call: { id: "call_1", name: "search", arguments: { q: "web" } },
		});
	});
});
