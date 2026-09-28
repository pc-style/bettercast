import { afterAll, describe, expect, test } from "bun:test";
import { MCPClient, MCPError, MCPHTTPTransport } from "./mcp-client.ts";

const requests = [];
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const rpc = await request.json();
		requests.push({ rpc, headers: Object.fromEntries(request.headers) });
		if (rpc.method === "notifications/initialized")
			return new Response(null, { status: 202 });
		const result =
			rpc.method === "initialize"
				? {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "synthetic", version: "1" },
					}
				: rpc.method === "tools/list"
					? {
							tools: [
								{
									name: "search",
									description: "Returns actual configured results",
									inputSchema: { type: "object" },
								},
							],
						}
					: {
							content: [{ type: "text", text: "https://example.test/source" }],
							structuredContent: { provenance: "synthetic test server" },
						};
		const response = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
		if (rpc.method === "tools/list") {
			const encoded = new TextEncoder().encode(
				`event: message\ndata: ${response}\n\n`,
			);
			return new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(encoded.slice(0, 13));
						c.enqueue(encoded.slice(13));
						c.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		return Response.json(JSON.parse(response), {
			headers:
				rpc.method === "initialize" ? { "Mcp-Session-Id": "test-session" } : {},
		});
	},
});
afterAll(() => server.stop(true));

describe("MCP client", () => {
	test("performs initialize, initialized, tools/list SSE, and tools/call over HTTP JSON-RPC", async () => {
		requests.length = 0;
		const endpoint = `http://127.0.0.1:${server.port}/mcp`;
		const client = new MCPClient({
			transport: new MCPHTTPTransport({
				endpoint,
				approvedEndpoints: [endpoint],
			}),
		});
		await client.initialize();
		expect((await client.listTools())[0].name).toBe("search");
		const result = await client.call("search", { q: "news" });
		expect(result.structuredContent.provenance).toBe("synthetic test server");
		expect(requests.map((r) => r.rpc.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/list",
			"tools/call",
		]);
		expect(requests[2].headers["mcp-protocol-version"]).toBe("2025-06-18");
		expect(requests[2].headers["mcp-session-id"]).toBe("test-session");
	});

	test("rejects endpoints absent from the exact allowlist", () => {
		expect(
			() =>
				new MCPHTTPTransport({
					endpoint: "https://unapproved.invalid/mcp",
					approvedEndpoints: [],
				}),
		).toThrow(MCPError);
	});

	test("requires initialization and respects cancellation", async () => {
		const client = new MCPClient({
			transport: {
				async send(_message, { signal }) {
					await new Promise((resolve, reject) => {
						signal.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					});
				},
			},
			timeoutMs: 1000,
		});
		await expect(client.listTools()).rejects.toMatchObject({
			code: "NOT_INITIALIZED",
		});
		const controller = new AbortController();
		const pending = client.initialize(controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test("already cancelled calls never reach transport", async () => {
		let requests = 0;
		const client = new MCPClient({
			transport: {
				async send() {
					requests++;
					throw new Error("should not run");
				},
			},
		});
		const controller = new AbortController();
		controller.abort();
		await expect(client.initialize(controller.signal)).rejects.toMatchObject({
			code: "CANCELLED",
		});
		expect(requests).toBe(0);
	});

	test("discovery rejects a repeating cursor rather than looping", async () => {
		let pages = 0;
		const client = new MCPClient({
			transport: {
				async send(message) {
					const result =
						message.method === "initialize"
							? {
									protocolVersion: "2025-06-18",
									capabilities: { tools: {} },
									serverInfo: { name: "fixture" },
								}
							: { tools: [], nextCursor: "again" };
					if (message.method === "tools/list") pages++;
					return { message: { jsonrpc: "2.0", id: message.id, result } };
				},
			},
		});
		await client.initialize();
		await expect(client.listTools()).rejects.toThrow("bounded pagination");
		expect(pages).toBe(2);
	});

	test("matching SSE response cancels its open stream", async () => {
		let cancelled = false;
		const transport = new MCPHTTPTransport({
			endpoint: "https://example.test/mcp",
			approvedEndpoints: ["https://example.test/mcp"],
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n',
								),
							);
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		await transport.send(
			{ jsonrpc: "2.0", id: 7, method: "tools/list" },
			{ signal: new AbortController().signal },
		);
		expect(cancelled).toBe(true);
	});
});
