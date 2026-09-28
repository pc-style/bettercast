// Explicit opt-in integration check. Never run as part of the offline test suite.
// Uses only public documentation and no credentials; this is not a native UI or model test.
import { extractToolSources, runAI } from "../src/lib/ai-engine";
import { MCPClient, MCPHTTPTransport } from "../src/lib/mcp-client";

if (!process.argv.includes("--public-learn")) {
	throw new Error(
		"Pass --public-learn to contact Microsoft's public read-only documentation MCP server",
	);
}
const endpoint = "https://learn.microsoft.com/api/mcp";
const query = "TypeScript strictNullChecks compiler option";
const client = new MCPClient({
	transport: new MCPHTTPTransport({ endpoint, approvedEndpoints: [endpoint] }),
	timeoutMs: 30_000,
});
let invocations = 0;
const executor = {
	async call(name, args, signal) {
		invocations++;
		return client.call(name, args, signal);
	},
};
const modelFixture = () => ({
	capabilities: { streaming: true, tools: true },
	async *stream(request) {
		if (!request.messages.some((message) => message.role === "tool")) {
			yield {
				type: "tool-call",
				call: {
					id: "public-docs-probe",
					name: "microsoft_docs_search",
					arguments: { query },
				},
			};
		}
		yield { type: "done" };
	},
});
try {
	const info = await client.initialize();
	const tools = await client.listTools();
	const tool = tools.find((item) => item.name === "microsoft_docs_search");
	if (!tool)
		throw new Error(
			"Public server no longer advertises the expected search tool",
		);
	const options = {
		messages: [{ role: "user", content: query }],
		tools: [tool],
		toolExecutor: executor,
	};
	try {
		await runAI({
			...options,
			transport: modelFixture(),
			approveToolCall: () => false,
		});
		throw new Error("Denied operation unexpectedly succeeded");
	} catch (error) {
		if (error.code !== "APPROVAL_DENIED" || invocations !== 0) throw error;
	}
	const result = await runAI({
		...options,
		transport: modelFixture(),
		approveToolCall: (request) =>
			request.name === tool.name && request.arguments.query === query,
	});
	const response = result.messages.find((message) => message.role === "tool");
	if (!response || typeof response.content !== "string")
		throw new Error("Missing tool response");
	const payload = JSON.parse(response.content);
	if (payload.isError || invocations !== 1)
		throw new Error("Public tool call failed");
	const sources = extractToolSources(payload);
	if (
		!sources.some(
			(source) => new URL(source.url).hostname === "learn.microsoft.com",
		)
	)
		throw new Error("Search returned no Microsoft Learn source URLs");
	console.log(
		JSON.stringify(
			{
				server: info.serverInfo,
				protocol: info.protocolVersion,
				discoveredTools: tools.map((item) => item.name),
				deniedInvocations: 0,
				approvedInvocations: invocations,
				query,
				sources: sources.slice(0, 5),
				limitation:
					"Actual public MCP HTTP tool call; synthetic model and approval callback. Not native transport, UI approval, or external AI-provider verification.",
			},
			null,
			2,
		),
	);
} finally {
	await client.close();
}
