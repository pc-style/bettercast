import { makeAutoObservable, runInAction, toJS } from "mobx";
import type { IRootStore } from "../store";
import type {
	McpContract,
	McpServerInfo,
	Grant,
	ToolSideEffect,
} from "../contracts/ai";
import { MCPClient, MCPHTTPTransport, type MCPTool } from "../lib/mcp-client";
import type { AITool, JSONValue } from "../lib/ai-engine";
import { solNative } from "../lib/SolNative";
import { nativeFetch } from "../lib/native-stream";

type Server = McpServerInfo & {
	args?: string[];
	account?: string;
	definitions?: MCPTool[];
};
export type McpStore = ReturnType<typeof createMcpStore>;
export type RegisteredTool = {
	definition: AITool;
	source: string;
	name: string;
	destination: string;
	sideEffects: ToolSideEffect[];
	call(args: Record<string, JSONValue>, signal: AbortSignal): Promise<unknown>;
};
export function createMcpStore(root: IRootStore) {
	const clients = new Map<string, MCPClient>();
	let loaded = false;
	const persist = () =>
		solNative.workspaceRequest({
			op: "writeDocument",
			id: "mcp",
			value: JSON.stringify({
				version: 1,
				servers: toJS(store.servers).map((server) => ({
					...server,
					status: "stopped",
					error: undefined,
				})),
			}),
		});
	async function connect(server: Server, signal: AbortSignal) {
		if (!server.enabled) throw new Error("Server is disabled");
		const existing = clients.get(server.id);
		if (existing) return existing;
		let client: MCPClient;
		if (server.transport === "http")
			client = new MCPClient({
				transport: new MCPHTTPTransport({
					endpoint: server.target,
					approvedEndpoints: [server.target],
					fetch: nativeFetch(server.account),
				}),
			});
		else {
			await solNative.workspaceRequest({
				op: "stdioOpen",
				id: server.id,
				executable: server.target,
				arguments: server.args ?? [],
			});
			client = new MCPClient({
				transport: {
					async send(message, options) {
						const cancel = () => {
							void solNative.workspaceRequest({
								op: "stdioClose",
								id: server.id,
							});
						};
						options.signal.addEventListener("abort", cancel, { once: true });
						try {
							if (options.signal.aborted) throw new Error("Cancelled");
							const response = await solNative.workspaceRequest({
								op: "stdioSend",
								id: server.id,
								body: JSON.stringify(message),
							});
							return { message: response };
						} finally {
							options.signal.removeEventListener("abort", cancel);
						}
					},
					close: () =>
						solNative.workspaceRequest({ op: "stdioClose", id: server.id }),
				},
			});
		}
		clients.set(server.id, client);
		try {
			const info = await client.initialize(signal);
			runInAction(() => {
				server.protocolVersion = info.protocolVersion;
				server.status = "ready";
			});
			return client;
		} catch (error) {
			clients.delete(server.id);
			await client.close();
			throw error;
		}
	}
	const store = makeAutoObservable({
		servers: [] as Server[],
		grants: [] as Grant[],
		error: null as string | null,
		async initialize() {
			if (loaded) return;
			const raw = await solNative.workspaceRequest({
				op: "readDocument",
				id: "mcp",
			});
			if (raw) {
				const saved = JSON.parse(raw);
				if (saved.version !== 1 || !Array.isArray(saved.servers))
					throw new Error("Invalid MCP state");
				runInAction(() => {
					store.servers = saved.servers.map((server: Server) => ({
						...server,
						status: "stopped",
					}));
				});
			}
			loaded = true;
		},
		async addServer(input: {
			id: string;
			name: string;
			transport: "http" | "stdio";
			target: string;
			args?: string[];
			apiKey?: string;
		}) {
			await store.initialize();
			if (!/^[a-z][a-z0-9-]{0,40}$/.test(input.id) || !input.name.trim())
				throw new Error("Use a short server id and name");
			if (input.transport === "http")
				new MCPHTTPTransport({
					endpoint: input.target,
					approvedEndpoints: [input.target],
				});
			else if (!input.target.startsWith("/"))
				throw new Error("Local server requires an absolute executable path");
			if (store.servers.some((server) => server.id === input.id))
				throw new Error("Server id already exists");
			const account = input.apiKey ? `mcp-${input.id}` : undefined;
			if (input.apiKey)
				await solNative.workspaceRequest({
					op: "saveKey",
					account,
					value: input.apiKey,
				});
			const server: Server = {
				id: input.id,
				name: input.name,
				transport: input.transport,
				target: input.target,
				args: input.args,
				account,
				enabled: false,
				status: "stopped",
				tools: [],
			};
			runInAction(() => {
				store.servers.push(server);
			});
			await persist();
		},
		async setServerEnabled(id: string, enabled: boolean) {
			const server = store.servers.find((item) => item.id === id);
			if (!server) return;
			server.enabled = enabled;
			if (!enabled) {
				await clients.get(id)?.close();
				clients.delete(id);
				server.status = "stopped";
				await persist();
				return;
			}
			server.status = "starting";
			server.error = undefined;
			try {
				const client = await connect(server, new AbortController().signal);
				const definitions = await client.listTools();
				runInAction(() => {
					server.definitions = definitions;
					server.tools = definitions.map((tool) => ({
						name: tool.name,
						description: tool.description,
						enabled: false,
						sideEffects:
							server.transport === "http" ? ["network"] : ["read", "write"],
					}));
					server.status = "ready";
				});
				await persist();
			} catch (error) {
				runInAction(() => {
					server.status = "error";
					server.error = String(error);
				});
			} finally {
				await clients.get(id)?.close();
				clients.delete(id);
			}
		},
		setToolEnabled(id: string, name: string, enabled: boolean) {
			const server = store.servers.find((item) => item.id === id);
			const tool = server?.tools.find((item) => item.name === name);
			if (tool) tool.enabled = enabled;
			void persist().catch((error) =>
				runInAction(() => {
					store.error = String(error);
				}),
			);
		},
		revokeGrant(_id: string) {
			store.grants = [];
			store.stopAll();
		},
		stopAll() {
			root.ai?.cancel();
			void store.closeClients();
		},
		async closeClients() {
			await Promise.all([...clients.values()].map((client) => client.close()));
			clients.clear();
			runInAction(() => {
				for (const server of store.servers)
					if (server.status === "ready") server.status = "stopped";
			});
		},
		get registeredTools(): RegisteredTool[] {
			return store.servers
				.filter((server) => server.enabled)
				.flatMap((server) =>
					(server.definitions ?? [])
						.filter((tool) =>
							server.tools.some(
								(item) => item.name === tool.name && item.enabled,
							),
						)
						.map((tool, index) => ({
							definition: {
								name: `mcp_${server.id.replace(/-/g, "_")}_${index}`,
								description: `${server.name}: ${tool.description ?? tool.name}`,
								inputSchema: tool.inputSchema,
							},
							source: `mcp:${server.id}`,
							name: tool.name,
							destination: server.target,
							sideEffects: (server.transport === "http"
								? ["network"]
								: ["read", "write"]) as ToolSideEffect[],
							async call(args, signal) {
								if (
									!server.enabled ||
									!server.tools.some(
										(item) => item.name === tool.name && item.enabled,
									)
								)
									throw new Error("Tool permission was revoked");
								const client = await connect(server, signal);
								const result = await client.call(tool.name, args, signal);
								if (result.isError)
									throw new Error(
										`Tool failed: ${JSON.stringify(result.content).slice(0, 4000)}`,
									);
								return result;
							},
						})),
				);
		},
	});
	const contract: McpContract = store;
	void contract;
	return store;
}
