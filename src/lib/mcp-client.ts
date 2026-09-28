import type { JSONValue, ToolExecutor } from "./ai-engine";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export interface MCPTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, JSONValue>;
	annotations?: Record<string, JSONValue>;
}
export interface MCPToolResult {
	content: Array<Record<string, JSONValue>>;
	structuredContent?: Record<string, JSONValue>;
	isError?: boolean;
}
export interface MCPServerInfo {
	name: string;
	version: string;
	title?: string;
}
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: Record<string, JSONValue>;
	serverInfo: MCPServerInfo;
	instructions?: string;
}
export interface MCPTransportResponse {
	message?: unknown;
	sessionId?: string;
}
export interface MCPTransport {
	send(
		message: Record<string, unknown>,
		options: {
			signal: AbortSignal;
			protocolVersion?: string;
			sessionId?: string;
		},
	): Promise<MCPTransportResponse>;
	close?(): Promise<void> | void;
}
export interface MCPClientOptions {
	transport: MCPTransport;
	name?: string;
	version?: string;
	timeoutMs?: number;
}

export class MCPError extends Error {
	constructor(
		public readonly code:
			| "PROTOCOL"
			| "RPC"
			| "TIMEOUT"
			| "CANCELLED"
			| "NOT_INITIALIZED"
			| "UNAPPROVED_ENDPOINT",
		message: string,
		public readonly data?: unknown,
	) {
		super(message);
		this.name = "MCPError";
	}
}

type RPCResponse = {
	jsonrpc: "2.0";
	id: string | number;
	result?: any;
	error?: { code: number; message: string; data?: unknown };
};

export class MCPClient implements ToolExecutor {
	private id = 0;
	private initialized?: MCPInitializeResult;
	private sessionId?: string;
	constructor(private readonly options: MCPClientOptions) {}

	async initialize(signal?: AbortSignal): Promise<MCPInitializeResult> {
		if (this.initialized) return this.initialized;
		const result = (await this.request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: {
					name: this.options.name ?? "bettercast",
					version: this.options.version ?? "1",
				},
			},
			signal,
			false,
		)) as MCPInitializeResult;
		if (result.protocolVersion !== MCP_PROTOCOL_VERSION)
			throw new MCPError(
				"PROTOCOL",
				`Unsupported negotiated MCP version: ${result.protocolVersion}`,
			);
		if (!result.serverInfo?.name || typeof result.capabilities !== "object")
			throw new MCPError("PROTOCOL", "Invalid initialize result");
		this.initialized = result;
		await this.notify("notifications/initialized", undefined, signal);
		return result;
	}

	async listTools(signal?: AbortSignal): Promise<MCPTool[]> {
		this.requireTools();
		const tools: MCPTool[] = [];
		let cursor: string | undefined;
		const cursors = new Set<string>();
		do {
			const result = (await this.request(
				"tools/list",
				cursor ? { cursor } : {},
				signal,
			)) as { tools?: MCPTool[]; nextCursor?: string };
			if (!Array.isArray(result.tools))
				throw new MCPError("PROTOCOL", "Invalid tools/list result");
			for (const tool of result.tools)
				if (
					tool &&
					typeof tool.name === "string" &&
					tool.inputSchema?.type === "object"
				)
					tools.push(tool);
				else throw new MCPError("PROTOCOL", "Invalid MCP tool definition");
			cursor = result.nextCursor;
			if (
				tools.length > 1000 ||
				(cursor &&
					(typeof cursor !== "string" ||
						cursors.has(cursor) ||
						cursors.size >= 100))
			)
				throw new MCPError(
					"PROTOCOL",
					"Tool discovery exceeded bounded pagination",
				);
			if (cursor) cursors.add(cursor);
		} while (cursor);
		return tools;
	}

	async call(
		name: string,
		args: Record<string, JSONValue>,
		signal: AbortSignal = new AbortController().signal,
	): Promise<MCPToolResult> {
		this.requireTools();
		if (!name || !args || Array.isArray(args))
			throw new MCPError("PROTOCOL", "Invalid tool call");
		const result = (await this.request(
			"tools/call",
			{ name, arguments: args },
			signal,
		)) as MCPToolResult;
		if (!Array.isArray(result.content))
			throw new MCPError("PROTOCOL", "Invalid tools/call result");
		return result;
	}

	async close(): Promise<void> {
		this.initialized = undefined;
		this.sessionId = undefined;
		await this.options.transport.close?.();
	}

	private requireTools(): void {
		if (!this.initialized)
			throw new MCPError(
				"NOT_INITIALIZED",
				"Initialize MCP before using tools",
			);
		if (!this.initialized.capabilities.tools)
			throw new MCPError("PROTOCOL", "Server did not advertise tools");
	}
	private async notify(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
	): Promise<void> {
		await this.send(
			{ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
			signal,
		);
	}
	private async request(
		method: string,
		params: unknown,
		signal?: AbortSignal,
		negotiated = true,
	): Promise<unknown> {
		const id = ++this.id;
		const response = await this.send(
			{ jsonrpc: "2.0", id, method, params },
			signal,
			negotiated,
		);
		if (!response || response.jsonrpc !== "2.0" || response.id !== id)
			throw new MCPError("PROTOCOL", `Invalid JSON-RPC response to ${method}`);
		if (response.error)
			throw new MCPError("RPC", response.error.message, response.error.data);
		if (!Object.prototype.hasOwnProperty.call(response, "result"))
			throw new MCPError("PROTOCOL", `Missing result for ${method}`);
		return response.result;
	}
	private async send(
		message: Record<string, unknown>,
		parentSignal?: AbortSignal,
		negotiated = true,
	): Promise<RPCResponse | undefined> {
		if (parentSignal?.aborted)
			throw new MCPError("CANCELLED", "MCP request cancelled");
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		parentSignal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() => controller.abort(),
			this.options.timeoutMs ?? 30_000,
		);
		try {
			const response = await this.options.transport.send(message, {
				signal: controller.signal,
				protocolVersion: negotiated
					? this.initialized?.protocolVersion
					: undefined,
				sessionId: this.sessionId,
			});
			if (response.sessionId) this.sessionId = response.sessionId;
			return response.message as RPCResponse | undefined;
		} catch (error) {
			if (controller.signal.aborted)
				throw new MCPError(
					parentSignal?.aborted ? "CANCELLED" : "TIMEOUT",
					parentSignal?.aborted
						? "MCP request cancelled"
						: "MCP request timed out",
				);
			throw error;
		} finally {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", onAbort);
		}
	}
}

export interface MCPHTTPTransportOptions {
	endpoint: string;
	approvedEndpoints: readonly string[];
	headers?: Record<string, string>;
	fetch?: typeof globalThis.fetch;
}

/** Streamable HTTP transport. The endpoint must exactly match a caller-controlled allowlist. */
export class MCPHTTPTransport implements MCPTransport {
	private readonly endpoint: string;
	private readonly fetcher: typeof globalThis.fetch;
	constructor(private readonly options: MCPHTTPTransportOptions) {
		this.endpoint = new URL(options.endpoint).toString();
		if (
			!options.approvedEndpoints
				.map((url) => new URL(url).toString())
				.includes(this.endpoint)
		)
			throw new MCPError("UNAPPROVED_ENDPOINT", "MCP endpoint is not approved");
		if (!/^https?:\/\//i.test(this.endpoint))
			throw new MCPError(
				"UNAPPROVED_ENDPOINT",
				"MCP endpoint must use HTTP(S)",
			);
		const parsed: any = new URL(this.endpoint);
		if (
			/^http:/i.test(this.endpoint) &&
			!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
		)
			throw new MCPError(
				"UNAPPROVED_ENDPOINT",
				"Remote MCP endpoints must use HTTPS",
			);
		this.fetcher = options.fetch ?? globalThis.fetch;
	}
	async send(
		message: Record<string, unknown>,
		context: {
			signal: AbortSignal;
			protocolVersion?: string;
			sessionId?: string;
		},
	): Promise<MCPTransportResponse> {
		const response: any = await this.fetcher(this.endpoint, {
			method: "POST",
			signal: context.signal,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(context.protocolVersion
					? { "MCP-Protocol-Version": context.protocolVersion }
					: {}),
				...(context.sessionId ? { "Mcp-Session-Id": context.sessionId } : {}),
				...this.options.headers,
			},
			body: JSON.stringify(message),
		});
		if (response.status === 202)
			return { sessionId: response.headers.get("Mcp-Session-Id") ?? undefined };
		if (!response.ok)
			throw new MCPError("PROTOCOL", `MCP HTTP ${response.status}`);
		const type = response.headers.get("content-type")?.toLowerCase() ?? "";
		let parsed: unknown;
		if (type.includes("text/event-stream"))
			parsed = await readSSEResponse(response, message.id, context.signal);
		else if (type.includes("application/json")) parsed = await response.json();
		else
			throw new MCPError(
				"PROTOCOL",
				`Unsupported MCP content type: ${type || "missing"}`,
			);
		return {
			message: parsed,
			sessionId: response.headers.get("Mcp-Session-Id") ?? undefined,
		};
	}
}

async function readSSEResponse(
	response: any,
	expectedId: unknown,
	signal: AbortSignal,
): Promise<unknown> {
	if (!response.body) throw new MCPError("PROTOCOL", "Empty MCP SSE response");
	const reader = response.body.getReader();
	let buffer = "";
	let pending: number[] = [];
	let received = 0;
	try {
		while (true) {
			if (signal.aborted)
				throw new MCPError("CANCELLED", "MCP request cancelled");
			const { value, done } = await reader.read();
			if (value) {
				received += value.length;
				if (received > 4_194_304)
					throw new MCPError("PROTOCOL", "MCP response exceeded size limit");
				const bytes = pending.concat(Array.from(value as Uint8Array));
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
				pending =
					lead >= 0 && bytes.length - lead < width ? bytes.splice(lead) : [];
				buffer += decodeURIComponent(
					bytes
						.map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
						.join(""),
				);
			}
			let boundary: number;
			while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
				const frame = buffer.slice(0, boundary);
				const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
				buffer = buffer.slice(boundary + separator.length);
				const data = frame
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data) {
					let value: any;
					try {
						value = JSON.parse(data);
					} catch {
						throw new MCPError("PROTOCOL", "Malformed MCP SSE JSON");
					}
					if (value.id === expectedId) return value;
				}
			}
			if (done) break;
		}
		throw new MCPError("PROTOCOL", "MCP SSE ended without matching response");
	} finally {
		await reader.cancel();
	}
}
