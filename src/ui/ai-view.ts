import type {
	Attachment,
	AttachmentStatus,
	Draft,
	Message,
	ProviderInfo,
	ToolCallState,
	ToolSideEffect,
} from "contracts/ai";
import type { Tone } from "./clipboard-view";
import { formatBytes, plural } from "./format";

export type TextSegment =
	| { type: "prose"; text: string }
	| { type: "code"; lang: string; text: string; closed: boolean };

/**
 * Split model text into prose and fenced code. Tolerates an unclosed trailing
 * fence so streaming output renders as code while it arrives.
 */
export function splitSegments(text: string): TextSegment[] {
	const segments: TextSegment[] = [];
	const fence = /^```([^\n`]*)\n?/gm;
	let cursor = 0;
	for (;;) {
		fence.lastIndex = cursor;
		const open = fence.exec(text);
		if (!open) break;
		const prose = text.slice(cursor, open.index);
		if (prose.trim()) segments.push({ type: "prose", text: prose.replace(/\n+$/, "") });
		const bodyStart = open.index + open[0].length;
		const close = text.indexOf("\n```", bodyStart - 1);
		if (close < 0) {
			segments.push({ type: "code", lang: open[1].trim(), text: text.slice(bodyStart), closed: false });
			return segments;
		}
		segments.push({
			type: "code",
			lang: open[1].trim(),
			text: text.slice(bodyStart, Math.max(bodyStart, close)),
			closed: true,
		});
		const afterClose = text.indexOf("\n", close + 4);
		cursor = afterClose < 0 ? text.length : afterClose + 1;
	}
	const rest = text.slice(cursor);
	if (rest.trim()) segments.push({ type: "prose", text: rest });
	return segments;
}

export const ATTACHMENT_STATUS: Record<AttachmentStatus, { label: string; tone: Tone; blocks: boolean }> = {
	ready: { label: "Ready", tone: "neutral", blocks: false },
	truncated: { label: "Truncated", tone: "warning", blocks: false },
	unsupported: { label: "Unsupported by model", tone: "danger", blocks: true },
	tooLarge: { label: "Too large", tone: "danger", blocks: true },
	extractFailed: { label: "Could not read", tone: "danger", blocks: true },
};

export const TOOL_STATE: Record<ToolCallState, { label: string; tone: Tone }> = {
	pending: { label: "Needs approval", tone: "warning" },
	denied: { label: "Denied", tone: "neutral" },
	running: { label: "Running", tone: "accent" },
	done: { label: "Done", tone: "success" },
	failed: { label: "Failed", tone: "danger" },
	cancelled: { label: "Cancelled", tone: "neutral" },
};

export const SIDE_EFFECT: Record<ToolSideEffect, { label: string; tone: Tone }> = {
	read: { label: "Reads", tone: "neutral" },
	network: { label: "Network", tone: "warning" },
	write: { label: "Writes", tone: "danger" },
	delete: { label: "Deletes", tone: "danger" },
	send: { label: "Sends", tone: "danger" },
};

export function selectedProvider(
	providers: ProviderInfo[],
	draft: Draft,
): ProviderInfo | undefined {
	return providers.find(p => p.id === draft.providerId);
}

export function capabilityChips(p: ProviderInfo): { label: string; on: boolean }[] {
	const c = p.capabilities;
	return [
		{ label: "Streaming", on: c.streaming },
		{ label: "Images", on: c.images },
		{ label: "PDF", on: c.pdf },
		{ label: "Files", on: c.textFiles },
		{ label: "Web search", on: c.webSearch },
		{ label: "Tools", on: c.tools },
	];
}

/** Whether the selected provider can take this attachment kind at all. */
export function kindSupported(p: ProviderInfo | undefined, a: Attachment): boolean {
	if (!p) return false;
	switch (a.kind) {
		case "image":
			return p.capabilities.images;
		case "pdf":
			return p.capabilities.pdf;
		case "text":
			return p.capabilities.textFiles;
		default:
			return false;
	}
}

export type SendPlan = {
	canSend: boolean;
	/** First reason sending is blocked, shown next to the send hint. */
	blocker?: string;
	/** One line describing exactly what leaves the device. */
	disclosure: string;
	warnings: string[];
};

export function planSend(
	draft: Draft,
	providers: ProviderInfo[],
	busy: boolean,
): SendPlan {
	const provider = selectedProvider(providers, draft);
	const warnings: string[] = [];
	const ready = draft.attachments.filter(a => !ATTACHMENT_STATUS[a.status].blocks);
	const bytes = ready.reduce((sum, a) => sum + (a.sentBytes ?? a.bytes), 0);
	const parts = ["prompt"];
	if (ready.length) parts.push(`${plural(ready.length, "attachment")} (${formatBytes(bytes)})`);
	const target = provider ? provider.label : "no provider";
	let disclosure = `Sends ${parts.join(" + ")} to ${target}`;
	if (draft.webSearch && provider?.capabilities.webSearch) disclosure += " · web search on";
	if (draft.toolsEnabled && provider?.capabilities.tools) disclosure += " · tools ask first";

	for (const a of draft.attachments) {
		if (a.status === "truncated") warnings.push(`${a.name} will be truncated${a.note ? `: ${a.note}` : ""}`);
	}
	if (draft.webSearch && provider && !provider.capabilities.webSearch)
		warnings.push(`${provider.label} cannot search the web; search is off for this request`);

	const blocked = (blocker: string): SendPlan => ({ canSend: false, blocker, disclosure, warnings });
	if (busy) return blocked("Wait for the current response or stop it");
	if (!provider) return blocked("Choose a provider");
	if (!provider.available) return blocked(provider.reason ?? `${provider.label} is unavailable`);
	const bad = draft.attachments.find(a => ATTACHMENT_STATUS[a.status].blocks);
	if (bad) return blocked(`Remove ${bad.name}: ${ATTACHMENT_STATUS[bad.status].label.toLowerCase()}`);
	const unsupported = draft.attachments.find(a => !kindSupported(provider, a));
	if (unsupported) return blocked(`${provider.label} cannot read ${unsupported.name}`);
	if (!draft.text.trim()) return blocked("Type a message");
	return { canSend: true, disclosure, warnings };
}

/** Plain text of an assistant message, for copy/insert. Tool cards and sources excluded. */
export function messageText(message: Message): string {
	return message.blocks
		.filter((b): b is Extract<Message["blocks"][number], { type: "text" }> => b.type === "text")
		.map(b => b.text)
		.join("\n\n")
		.trim();
}

export function lastAssistant(messages: Message[]): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
	return undefined;
}

/** Compact one-line rendering of tool arguments for cards. */
export function formatArgs(args: Record<string, unknown>, max = 140): string {
	const text = Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" · ");
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function hostOf(url: string): string {
	const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
	return match ? match[1].replace(/^www\./, "") : url;
}
