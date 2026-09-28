// UI ↔ AI store contract. Types only.

import type { DeliveryResult } from "./clipboard";

export type ProviderCapabilities = {
	streaming: boolean;
	images: boolean;
	pdf: boolean;
	textFiles: boolean;
	webSearch: boolean;
	tools: boolean;
	/** Max attachment bytes accepted per request, when known. */
	maxAttachmentBytes?: number;
};

export type ProviderInfo = {
	id: string; // e.g. "claude-cli"
	label: string;
	/** How access works, shown to the user, e.g. "Installed Claude CLI". */
	accessMethod: string;
	available: boolean;
	/** Why unavailable / limited; shown verbatim. */
	reason?: string;
	models: { id: string; label: string }[];
	capabilities: ProviderCapabilities;
	/** Visible cost note, e.g. "Uses your Claude subscription"; never implied free. */
	costNote?: string;
};

export type AttachmentStatus =
	| "ready"
	| "unsupported" // provider can't take this type
	| "tooLarge"
	| "extractFailed"
	| "truncated";

export type Attachment = {
	id: string;
	name: string;
	kind: "image" | "pdf" | "text" | "other";
	path?: string;
	/** Source: picker, drop, paste, clipboard history item. */
	origin: "file" | "paste" | "clipboard" | "selection";
	bytes: number;
	/** Bytes that will actually be sent after truncation/extraction. */
	sentBytes?: number;
	status: AttachmentStatus;
	note?: string;
};

export type Draft = {
	text: string;
	attachments: Attachment[];
	providerId: string | null;
	modelId: string | null;
	webSearch: boolean;
	toolsEnabled: boolean;
};

export type AttachmentPreview = {
	text?: string;
	imageUri?: string;
	/** Only the display is shortened; sending still uses the loaded content. */
	truncated: boolean;
};

export type Citation = {
	url: string;
	title?: string;
	fetchedAt?: number;
};

export type ToolSideEffect = "read" | "write" | "network" | "delete" | "send";

export type ToolCallState =
	| "pending" // awaiting approval
	| "denied"
	| "running"
	| "done"
	| "failed"
	| "cancelled";

export type ToolCall = {
	id: string;
	/** "mcp:<server>" or "command:<id>" */
	source: string;
	tool: string;
	/** Human-meaningful arguments, already redacted for display. */
	args: Record<string, unknown>;
	destination?: string; // host / path the call touches
	sideEffects: ToolSideEffect[];
	state: ToolCallState;
	result?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
};

export type MessageBlock =
	| { type: "text"; text: string }
	| { type: "tool"; call: ToolCall }
	| { type: "sources"; citations: Citation[]; failures?: string[] };

export type Message = {
	id: string;
	role: "user" | "assistant";
	blocks: MessageBlock[];
	attachments?: Attachment[];
	createdAt: number;
	/** assistant only */
	status?: "streaming" | "done" | "error" | "cancelled";
	error?: string;
	providerId?: string;
	modelId?: string;
	usage?: { inputTokens?: number; outputTokens?: number; costUSD?: number; estimated: boolean };
};

export type ConversationSummary = {
	id: string;
	title: string;
	updatedAt: number;
	messageCount: number;
};

export type ApprovalScope = "once" | "conversation" | "always";

export type PendingApproval = {
	call: ToolCall;
	/** Scopes the host will enforce for this tool; UI only offers these. */
	allowedScopes: ApprovalScope[];
};

export interface AIContract {
	initialized: boolean;
	providers: ProviderInfo[];
	draft: Draft;
	conversationId: string | null;
	conversations: ConversationSummary[];
	messages: Message[];
	busy: boolean;
	error: string | null;
	pendingApproval: PendingApproval | null;

	initialize(): Promise<void>;
	setDraft(partial: Partial<Draft>): void;
	/**
	 * Moves the draft into a user message and starts streaming. The draft is cleared only once
	 * the request is dispatched; on provider errors the message stays and retry() resends it,
	 * so typed text and attachments are never lost.
	 */
	send(): Promise<void>;
	/** Stops the active request; partial output stays with status "cancelled". */
	cancel(): void;
	/** Re-runs the last user message (after error/cancel, or to regenerate). */
	retry(): Promise<void>;
	/**
	 * uri: absolute path, file:// URL, data: URL (pasted image), or `clip:<ClipItem.id>` for a
	 * user-selected clipboard history item. The store sniffs kind/size and sets status against
	 * the selected provider's capabilities; it never reads more history than the given id.
	 */
	addAttachment(input: {
		uri: string;
		origin: Attachment["origin"];
		name?: string;
		mimeType?: string;
		bytes?: number;
	}): Promise<Attachment>;
	removeAttachment(id: string): void;
	/** Preview already-loaded draft content; never reads additional files or history. */
	attachmentPreview?(id: string): AttachmentPreview | null;
	approve(callId: string, scope: ApprovalScope): void;
	deny(callId: string): void;
	newConversation(): void;
	loadConversation(id: string): Promise<void>;

	// Optional: the UI shows these disabled with "not available in this build" when absent.
	/** Insert/replace in the app that was frontmost when the launcher opened; focus-guarded. */
	insert?(messageId: string, mode: "insert" | "replace"): Promise<DeliveryResult>;
	/** Replace a previous user message's text, drop later messages, and resend. */
	editMessage?(messageId: string, text: string): Promise<void>;
	/** Writes a Markdown export and returns its path. */
	exportConversation?(id: string): Promise<string>;
	deleteConversation?(id: string): Promise<void>;
	/** Adds the frontmost app's selected text as an attachment (origin "selection"), or null if none. */
	captureSelection?(): Promise<Attachment | null>;
	/**
	 * Save a user-configured compatible endpoint. endpoint must be https:// or loopback http://.
	 * apiKey is write-only (native Keychain), never persisted in JSON or read back.
	 */
	configureProvider?(input: CompatibleProviderInput): Promise<void>;
}

export type CompatibleProviderInput = {
	id: "compatible";
	label: string;
	endpoint: string;
	modelId: string;
	images: boolean;
	tools: boolean;
	apiKey?: string;
};

export type McpServerInput = {
	id: string;
	name: string;
	transport: "http" | "stdio";
	/** http: URL. stdio: absolute executable path (trusted, unrestricted local code). */
	target: string;
	args?: string[];
	/** Write-only; stored in Keychain. */
	apiKey?: string;
};

export type McpServerInfo = {
	id: string;
	name: string;
	transport: "stdio" | "http";
	/** Command line for stdio, URL for http. Trusted-code label is shown for stdio. */
	target: string;
	enabled: boolean;
	status: "stopped" | "starting" | "ready" | "error" | "authRequired";
	error?: string;
	protocolVersion?: string;
	tools: { name: string; description?: string; enabled: boolean; sideEffects: ToolSideEffect[] }[];
};

export type Grant = {
	id: string;
	source: string; // same format as ToolCall.source
	tool: string;
	scope: Exclude<ApprovalScope, "once">;
	grantedAt: number;
};

export interface McpContract {
	servers: McpServerInfo[];
	grants: Grant[];
	/** Saves the server disabled; nothing starts until setServerEnabled(id, true). */
	addServer?(input: McpServerInput): Promise<void>;
	/** Enabling runs discovery (starts stdio process / contacts http endpoint) on explicit request. */
	setServerEnabled(id: string, enabled: boolean): Promise<void>;
	setToolEnabled(serverId: string, tool: string, enabled: boolean): void;
	revokeGrant(id: string): void;
	/** Stop-all for AI/tool jobs owned by the app. */
	stopAll(): void;
}
