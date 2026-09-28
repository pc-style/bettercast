import { makeAutoObservable, runInAction, toJS } from "mobx";
import type { IRootStore } from "../store";
import type {
	AIContract,
	Attachment,
	AttachmentPreview,
	ApprovalScope,
	ConversationSummary,
	Draft,
	Message,
	PendingApproval,
	ProviderInfo,
	ToolCall,
} from "../contracts/ai";
import {
	createOpenAITransport,
	extractToolSources,
	runAI,
	type AIContentBlock,
	type AIMessage,
} from "../lib/ai-engine";
import { claudeTransport, nativeFetch, requestID } from "../lib/native-stream";
import { solNative } from "../lib/SolNative";
import type { DeliveryResult } from "../contracts/clipboard";
import {
	assertAIPreflight,
	attachmentStatusForProvider,
} from "../lib/ai-preflight";

type ProviderConfiguration = {
	id: "compatible";
	label: string;
	endpoint: string;
	modelId: string;
	images: boolean;
	tools: boolean;
	account?: string;
};
type AttachmentContent = {
	kind: "image" | "text" | "pdf" | "other";
	bytes: number;
	mimeType?: string;
	data?: string;
	text?: string;
	unsupported?: string;
};
const emptyDraft = (): Draft => ({
	text: "",
	attachments: [],
	providerId: "claude-cli",
	modelId: "default",
	webSearch: false,
	toolsEnabled: false,
});
export type AIStore = ReturnType<typeof createAIStore>;
export function createAIStore(root: IRootStore) {
	let controller: AbortController | undefined,
		decision: ((allow: boolean) => void) | undefined;
	let config: ProviderConfiguration | undefined,
		history: AIMessage[] = [],
		lastRequest: AIMessage[] = [];
	let attachmentContents: Record<string, AttachmentContent> = {};
	let saving = Promise.resolve();
	let initializing: Promise<void> | undefined;
	let sending = false;
	let cancellationEpoch = 0;
	const selectContents = (ids: Set<string>) =>
		Object.fromEntries(
			Object.entries(attachmentContents).filter(([id]) => ids.has(id)),
		);
	const write = (id: string, value: unknown) =>
		solNative.workspaceRequest({
			op: "writeDocument",
			id,
			value: JSON.stringify(value),
		});
	const persist = () => {
		if (!store.initialized)
			return Promise.reject(new Error("AI storage unavailable"));
		const draftIds = new Set(store.draft.attachments.map((item) => item.id));
		const conversationIds = new Set([
			...draftIds,
			...store.messages.flatMap((message) =>
				(message.attachments ?? []).map((item) => item.id),
			),
		]);
		const snapshot = {
			version: 1,
			draft: toJS(store.draft),
			conversations: toJS(store.conversations),
			config,
			attachmentContents: selectContents(draftIds),
		};
		const conversation = store.conversationId
			? {
					id: store.conversationId,
					value: {
						version: 1,
						messages: toJS(store.messages),
						history,
						lastRequest,
						attachmentContents: selectContents(conversationIds),
					},
				}
			: null;
		const task = saving.then(async () => {
			if (conversation) await write(conversation.id, conversation.value);
			await write("ai-index", snapshot);
		});
		saving = task.catch((error) =>
			runInAction(() => {
				store.error = `Local history could not be saved: ${String(error)}`;
			}),
		);
		return task;
	};
	const updateProviders = async () => {
		const available = await solNative.getAIProviders();
		const providers: ProviderInfo[] = [
			{
				id: "claude-cli",
				label: "Claude CLI",
				accessMethod: "Installed, authenticated Claude CLI; tools disabled",
				available: available.some(
					(item) => item.provider === "claude" && item.available,
				),
				reason:
					"Text-only adapter. Streaming requires CLI stream-json support; images and external tools require a configured compatible provider.",
				models: [{ id: "default", label: "CLI default" }],
				capabilities: {
					streaming: true,
					images: false,
					pdf: false,
					textFiles: true,
					webSearch: false,
					tools: false,
					maxAttachmentBytes: 128_000,
				},
				costNote:
					"Uses your separately configured Claude access. Provider terms and limits apply.",
			},
		];
		if (config)
			providers.push({
				id: config.id,
				label: config.label,
				accessMethod: config.endpoint,
				available: true,
				models: [{ id: config.modelId, label: config.modelId }],
				capabilities: {
					streaming: true,
					images: config.images,
					pdf: false,
					textFiles: true,
					webSearch: config.tools,
					tools: config.tools,
					maxAttachmentBytes: 8_388_608,
				},
				costNote:
					"Your configured endpoint may charge for tokens and tools. Capabilities are user-declared, not automatically verified.",
			});
		runInAction(() => {
			store.providers = providers;
		});
	};
	async function generate(input: AIMessage[]) {
		const provider = store.providers.find(
			(item) => item.id === store.draft.providerId,
		);
		if (!provider?.available)
			throw new Error("Configure an available provider first");
		const availableTools = root.mcp.registeredTools;
		const selectedToolNames = assertAIPreflight({
			provider,
			attachments: [],
			contents: {},
			webSearch: store.draft.webSearch,
			toolsEnabled: store.draft.toolsEnabled,
			availableToolNames: availableTools.map((tool) => tool.name),
		});
		const tools = availableTools.filter((tool) =>
			selectedToolNames.includes(tool.name),
		);
		const transport =
			provider.id === "claude-cli"
				? claudeTransport()
				: createOpenAITransport({
						endpoint: config!.endpoint,
						model: store.draft.modelId ?? config!.modelId,
						capabilities: {
							streaming: true,
							tools: config!.tools,
							imageMimeTypes: config!.images
								? ["image/png", "image/jpeg", "image/gif", "image/webp"]
								: [],
							maxAttachmentBytes: 8_388_608,
							maxContextChars: 200_000,
						},
						fetch: nativeFetch(config!.account),
					});
		controller = new AbortController();
		const signal = controller.signal;
		const assistant: Message = {
			id: requestID(),
			role: "assistant",
			blocks: [],
			createdAt: Date.now(),
			status: "streaming",
			providerId: provider.id,
			modelId: store.draft.modelId ?? undefined,
		};
		runInAction(() => {
			store.busy = true;
			store.error = null;
			store.messages.push(assistant);
		});
		// Work with the observable object MobX created, not the unobserved input.
		const output = store.messages[store.messages.length - 1];
		try {
			const result = await runAI({
				transport,
				messages: input,
				tools: tools.map((tool) => tool.definition),
				signal,
				onEvent: (event) => {
					if (event.type === "text")
						runInAction(() => {
							const last = output.blocks[output.blocks.length - 1];
							if (last?.type === "text") last.text += event.text;
							else output.blocks.push({ type: "text", text: event.text });
						});
				},
				approveToolCall: async (request) => {
					const tool = tools.find(
						(item) => item.definition.name === request.name,
					)!;
					const call: ToolCall = {
						id: request.callId,
						source: tool.source,
						tool: tool.name,
						args: JSON.parse(JSON.stringify(request.arguments)),
						destination: tool.destination,
						sideEffects: tool.sideEffects,
						state: "pending",
					};
					runInAction(() => {
						output.blocks.push({ type: "tool", call });
						store.pendingApproval = { call, allowedScopes: ["once"] };
					});
					return new Promise<boolean>((resolve) => {
						decision = resolve;
					});
				},
				toolExecutor: {
					async call(name, args, callSignal) {
						const tool = tools.find((item) => item.definition.name === name);
						if (!tool) throw new Error("Unknown tool");
						const block = [...output.blocks]
							.reverse()
							.find(
								(block) =>
									block.type === "tool" && block.call.tool === tool.name,
							);
						const call = block?.type === "tool" ? block.call : null;
						runInAction(() => {
							if (call) {
								call.state = "running";
								call.startedAt = Date.now();
							}
						});
						try {
							const result = await tool.call(args, callSignal);
							const sources = extractToolSources(result);
							runInAction(() => {
								if (call) {
									call.state = "done";
									call.result = JSON.stringify(result);
									call.finishedAt = Date.now();
								}
								if (sources.length)
									output.blocks.push({ type: "sources", citations: sources });
							});
							return result;
						} catch (error) {
							runInAction(() => {
								if (call) {
									call.state = callSignal.aborted ? "cancelled" : "failed";
									call.error = String(error);
								}
							});
							throw error;
						}
					},
				},
			});
			history = result.messages;
			runInAction(() => {
				output.status = "done";
			});
		} catch (error) {
			runInAction(() => {
				output.status = signal.aborted ? "cancelled" : "error";
				output.error = String(error);
				store.error = String(error);
			});
		} finally {
			decision?.(false);
			decision = undefined;
			await root.mcp.closeClients();
			runInAction(() => {
				store.busy = false;
				store.pendingApproval = null;
				const summary = store.conversations.find(
					(item) => item.id === store.conversationId,
				);
				if (summary) {
					summary.updatedAt = Date.now();
					summary.messageCount = store.messages.length;
				}
			});
			await persist();
		}
	}
	const store = makeAutoObservable({
		initialized: false,
		providers: [] as ProviderInfo[],
		draft: emptyDraft(),
		conversationId: null as string | null,
		conversations: [] as ConversationSummary[],
		messages: [] as Message[],
		busy: false,
		error: null as string | null,
		pendingApproval: null as PendingApproval | null,
		async initialize() {
			if (store.initialized) return;
			if (initializing) return initializing;
			initializing = (async () => {
				try {
					const raw = await solNative.workspaceRequest({
						op: "readDocument",
						id: "ai-index",
					});
					if (raw) {
						const saved = JSON.parse(raw);
						if (saved.version !== 1)
							throw new Error("Unsupported AI history version");
						config = saved.config;
						attachmentContents = saved.attachmentContents ?? {};
						runInAction(() => {
							store.draft = saved.draft ?? emptyDraft();
							store.conversations = saved.conversations ?? [];
						});
					}
					await updateProviders();
					await root.mcp.initialize();
					runInAction(() => {
						store.initialized = true;
					});
				} catch (error) {
					runInAction(() => {
						store.error = String(error);
					});
				} finally {
					initializing = undefined;
				}
			})();
			return initializing;
		},
		async configureProvider(
			input: Omit<ProviderConfiguration, "account"> & { apiKey?: string },
		) {
			if (sending || store.busy)
				throw new Error("Stop the current request before changing providers");
			await store.initialize();
			if (!store.initialized)
				throw new Error(store.error ?? "AI storage unavailable");
			const url: any = new URL(input.endpoint);
			if (
				url.username ||
				url.password ||
				url.hash ||
				(url.protocol !== "https:" &&
					!(
						url.protocol === "http:" &&
						["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
					))
			)
				throw new Error(
					"Use HTTPS or a loopback HTTP endpoint without credentials",
				);
			if (!input.modelId.trim() || !input.label.trim())
				throw new Error("Provider label and model are required");
			const account = input.apiKey
				? "provider-compatible"
				: config?.endpoint === input.endpoint
					? config.account
					: undefined;
			if (input.apiKey)
				await solNative.workspaceRequest({
					op: "saveKey",
					account,
					value: input.apiKey,
				});
			config = {
				id: "compatible",
				label: input.label,
				endpoint: input.endpoint,
				modelId: input.modelId,
				images: input.images,
				tools: input.tools,
				account,
			};
			await updateProviders();
			runInAction(() => {
				store.draft.providerId = "compatible";
				store.draft.modelId = input.modelId;
				const provider = store.providers.find(
					(item) => item.id === "compatible",
				);
				store.draft.attachments = store.draft.attachments.map((attachment) => ({
					...attachment,
					...attachmentStatusForProvider(
						attachment,
						attachmentContents[attachment.id],
						provider,
					),
				}));
			});
			await persist();
		},
		setDraft(partial: Partial<Draft>) {
			if (store.busy) return;
			store.draft = { ...store.draft, ...partial };
			if (partial.providerId !== undefined) {
				const provider = store.providers.find(
					(item) => item.id === store.draft.providerId,
				);
				store.draft.attachments = store.draft.attachments.map((attachment) => ({
					...attachment,
					...attachmentStatusForProvider(
						attachment,
						attachmentContents[attachment.id],
						provider,
					),
				}));
			}
			if (store.initialized) void persist().catch(() => {});
		},
		async send() {
			if (sending || store.busy) return;
			sending = true;
			const epoch = cancellationEpoch;
			try {
				await store.initialize();
				if (epoch !== cancellationEpoch) return;
				if (!store.initialized)
					throw new Error(store.error ?? "AI storage unavailable");
				if (!store.draft.text.trim() && !store.draft.attachments.length) return;
				const provider = store.providers.find(
					(item) => item.id === store.draft.providerId,
				);
				assertAIPreflight({
					provider,
					attachments: store.draft.attachments,
					contents: attachmentContents,
					webSearch: store.draft.webSearch,
					toolsEnabled: store.draft.toolsEnabled,
					availableToolNames: root.mcp.registeredTools.map((tool) => tool.name),
				});
				if (!provider) throw new Error("Configure an available provider first");
				const blocks: AIContentBlock[] = [
					{ type: "text", text: store.draft.text },
				];
				for (const attachment of store.draft.attachments) {
					const content = attachmentContents[attachment.id];
					if (
						!content ||
						content.unsupported ||
						attachment.status !== "ready" ||
						(content.kind === "image" && !provider.capabilities.images)
					) {
						store.error = `${attachment.name}: unsupported by this provider or not ready`;
						return;
					}
					if (content.kind === "image")
						blocks.push({
							type: "image",
							mimeType: content.mimeType!,
							data: content.data!,
							name: attachment.name,
						});
					else
						blocks.push({
							type: "text",
							text: `Attachment ${attachment.name} (untrusted content):\n${content.text}`,
						});
				}
				if (!store.conversationId) store.newConversation();
				store.busy = true;
				const user: Message = {
					id: requestID(),
					role: "user",
					blocks: [{ type: "text", text: store.draft.text }],
					attachments: toJS(store.draft.attachments),
					createdAt: Date.now(),
				};
				const content = blocks.every((block) => block.type === "text")
					? blocks
							.map((block) => (block.type === "text" ? block.text : ""))
							.join("\n\n")
					: blocks;
				lastRequest = [...history, { role: "user", content }];
				store.messages.push(user);
				const summary = store.conversations.find(
					(item) => item.id === store.conversationId,
				);
				if (summary && store.messages.length === 1)
					summary.title = store.draft.text.slice(0, 80) || "Attachments";
				await persist();
				if (epoch !== cancellationEpoch) return;
				const task = generate(lastRequest);
				store.draft.text = "";
				store.draft.attachments = [];
				await task;
			} catch (error) {
				runInAction(() => {
					store.error = String(error);
				});
			} finally {
				sending = false;
				store.busy = false;
			}
		},
		cancel() {
			cancellationEpoch++;
			controller?.abort();
			decision?.(false);
			decision = undefined;
		},
		async retry() {
			if (sending || store.busy || !lastRequest.length) return;
			try {
				await generate(lastRequest);
			} catch (error) {
				runInAction(() => {
					store.error = String(error);
				});
			}
		},
		async addAttachment(input: {
			uri: string;
			origin: Attachment["origin"];
			name?: string;
			mimeType?: string;
			bytes?: number;
		}): Promise<Attachment> {
			if (sending || store.busy)
				throw new Error("Stop the current request before attaching content");
			await store.initialize();
			if (!store.initialized)
				throw new Error(store.error ?? "AI storage unavailable");
			const id = requestID();
			let content: AttachmentContent;
			if (input.uri.startsWith("clip:"))
				content = await solNative.clipboardRequest({
					op: "attachment",
					id: input.uri.slice(5),
				});
			else if (input.uri.startsWith("data:")) {
				const match = input.uri.match(
					/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/,
				);
				if (!match || match[2].length > 11_184_812)
					throw new Error("Pasted image is unsupported or over 8 MiB");
				content = {
					kind: "image",
					mimeType: match[1],
					data: match[2],
					bytes: Math.ceil((match[2].length * 3) / 4),
				};
			} else {
				const path = input.uri.startsWith("file://")
					? decodeURIComponent(input.uri.slice(7))
					: input.uri;
				if (!path.startsWith("/"))
					throw new Error("Select an absolute file path");
				content = await solNative.workspaceRequest({ op: "attachment", path });
			}
			if (sending || store.busy)
				throw new Error(
					"The request started while reading the attachment; add it again after completion",
				);
			const provider = store.providers.find(
				(item) => item.id === store.draft.providerId,
			);
			const total =
				store.draft.attachments.reduce((sum, item) => sum + item.bytes, 0) +
				content.bytes;
			const attachment: Attachment = {
				id,
				name:
					input.name ??
					input.uri.split("/").pop()?.slice(0, 120) ??
					"Attachment",
				origin: input.origin,
				kind: content.kind,
				bytes: content.bytes,
				sentBytes: content.bytes,
				status:
					total > 8_388_608
						? "tooLarge"
						: attachmentStatusForProvider(
								{ bytes: content.bytes } as Attachment,
								content,
								provider,
							).status,
				note: attachmentStatusForProvider(
					{ bytes: content.bytes } as Attachment,
					content,
					provider,
				).note,
				path: input.uri.startsWith("/") ? input.uri : undefined,
			};
			attachmentContents[id] = content;
			runInAction(() => {
				store.draft.attachments.push(attachment);
			});
			await persist();
			return attachment;
		},
		removeAttachment(id: string) {
			if (sending || store.busy) return;
			store.draft.attachments = store.draft.attachments.filter(
				(item) => item.id !== id,
			);
			void persist().catch(() => {});
		},
		attachmentPreview(id: string): AttachmentPreview | null {
			if (!store.draft.attachments.some((item) => item.id === id)) return null;
			const content = attachmentContents[id];
			if (content?.kind === "text" && typeof content.text === "string")
				return {
					text: content.text.slice(0, 6000),
					truncated: content.text.length > 6000,
				};
			if (content?.kind === "image" && content.data && content.mimeType)
				return {
					imageUri: `data:${content.mimeType};base64,${content.data}`,
					truncated: false,
				};
			return null;
		},
		approve(callId: string, scope: ApprovalScope) {
			if (scope !== "once" || store.pendingApproval?.call.id !== callId) return;
			store.pendingApproval = null;
			const accept = decision;
			decision = undefined;
			accept?.(true);
		},
		deny(callId: string) {
			if (store.pendingApproval?.call.id !== callId) return;
			const block = store.messages
				.flatMap((item) => item.blocks)
				.find((block) => block.type === "tool" && block.call.id === callId);
			if (block?.type === "tool") block.call.state = "denied";
			store.pendingApproval = null;
			decision?.(false);
			decision = undefined;
		},
		newConversation() {
			if (store.busy) return;
			store.conversationId = requestID();
			store.messages = [];
			history = [];
			lastRequest = [];
			store.conversations.unshift({
				id: store.conversationId,
				title: "New conversation",
				updatedAt: Date.now(),
				messageCount: 0,
			});
		},
		async loadConversation(id: string) {
			if (store.busy) return;
			const raw = await solNative.workspaceRequest({ op: "readDocument", id });
			if (!raw) throw new Error("Conversation not found");
			const saved = JSON.parse(raw);
			if (saved.version !== 1) throw new Error("Unsupported conversation");
			history = saved.history;
			lastRequest = saved.lastRequest;
			const draftContents = selectContents(
				new Set(store.draft.attachments.map((item) => item.id)),
			);
			attachmentContents = { ...draftContents, ...saved.attachmentContents };
			runInAction(() => {
				store.conversationId = id;
				store.messages = saved.messages;
			});
		},
		async insert(
			messageId: string,
			mode: "insert" | "replace",
		): Promise<DeliveryResult> {
			if (mode === "replace")
				return {
					status: "failed",
					message:
						"Selection replacement is not available. Use explicit insertion at the destination instead.",
				};
			const message = store.messages.find((item) => item.id === messageId);
			if (!message) return { status: "failed", message: "Message not found" };
			const text = message.blocks
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n");
			return solNative.workspaceRequest({ op: "pasteText", text });
		},
	});
	const contract: AIContract = store;
	void contract;
	return store;
}
