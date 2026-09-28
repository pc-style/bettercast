import type {
	CaptureState,
	ClipItem,
	ClipKind,
	DeliveryResult,
	QueueState,
	RetentionStatus,
} from "contracts/clipboard";
import { formatBytes, formatRemaining, plural } from "./format";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export const KIND_FILTERS: { label: string; kinds: ClipKind[] }[] = [
	{ label: "All", kinds: [] },
	{ label: "Text", kinds: ["text"] },
	{ label: "Images", kinds: ["image"] },
	{ label: "Files", kinds: ["file"] },
	{ label: "Links", kinds: ["url"] },
];

const DAY = 86_400_000;
export const TIME_FILTERS: { label: string; ms?: number }[] = [
	{ label: "Any time" },
	{ label: "Today", ms: DAY },
	{ label: "7 days", ms: 7 * DAY },
	{ label: "30 days", ms: 30 * DAY },
];

export function sinceFor(timeFilter: number, now: number): number | undefined {
	const ms = TIME_FILTERS[timeFilter]?.ms;
	return ms == null ? undefined : now - ms;
}

export const KIND_LABEL: Record<ClipKind, string> = {
	text: "Text",
	image: "Image",
	file: "File",
	url: "Link",
};

export const KIND_GLYPH: Record<ClipKind, string> = {
	text: "¶",
	image: "▣",
	file: "▤",
	url: "↗",
};

export function captureLabel(
	state: CaptureState,
	now: number,
): { label: string; tone: Tone; detail?: string } {
	switch (state.status) {
		case "capturing":
			return { label: "Capturing", tone: "success" };
		case "paused":
			return state.until
				? {
						label: `Paused · ${formatRemaining(state.until, now)}`,
						tone: "warning",
						detail: "New copies are not recorded until capture resumes.",
					}
				: {
						label: "Paused",
						tone: "warning",
						detail: "New copies are not recorded until you resume capture.",
					};
		case "private":
			return {
				label: "Private mode",
				tone: "warning",
				detail: "Capture is suspended. Nothing you copy is recorded.",
			};
		case "denied":
			return { label: "No access", tone: "danger", detail: state.reason };
		case "unavailable":
			return { label: "Unavailable", tone: "danger", detail: state.reason };
		case "error":
			return { label: "Capture error", tone: "danger", detail: state.message };
	}
}

/** Explains when the storage cap is shortening history below the configured retention. */
export function retentionSummary(r: RetentionStatus): {
	text: string;
	tone: Tone;
	conflict: boolean;
} {
	const usage = `${formatBytes(r.usedBytes)} of ${formatBytes(r.capBytes)}`;
	const conflict = r.effectiveDays < r.retentionDays;
	if (conflict) {
		return {
			conflict,
			tone: "warning",
			text: `${usage} · the storage cap keeps only ~${plural(Math.max(0, Math.floor(r.effectiveDays)), "day")} of your ${r.retentionDays}-day retention`,
		};
	}
	return {
		conflict,
		tone: "neutral",
		text: `${plural(r.itemCount, "item")} · ${usage} · ${r.retentionDays}-day retention`,
	};
}

export function sourceLabel(item: ClipItem): string | undefined {
	if (!item.sourceApp) return undefined;
	return item.sourceApp.evidence === "reported"
		? item.sourceApp.name
		: `${item.sourceApp.name} (inferred)`;
}

/** Row subtitle: kind-specific detail without repeating the preview. */
export function rowTitle(item: ClipItem): string {
	const text = item.preview.replace(/\s+/g, " ").trim();
	if (text) return text;
	return item.kind === "image" ? "Image" : KIND_LABEL[item.kind];
}

/** User-facing copy for an action result. Paste is never described as verified. */
export function deliveryMessage(
	result: DeliveryResult,
): { text: string; tone: Tone } | null {
	switch (result.status) {
		case "dispatched":
			return null; // window hides; the destination app shows the outcome
		case "copied":
			return { text: "Copied to clipboard", tone: "success" };
		case "done":
			return null;
		case "focusChanged":
			return { text: result.message, tone: "warning" };
		case "failed":
			return { text: result.message, tone: "danger" };
	}
}

export function queueSummary(q: QueueState): {
	label: string;
	tone: Tone;
	remaining: number;
} {
	const total = q.items.length;
	const remaining = Math.max(0, total - q.position);
	const pos = `${Math.min(q.position + 1, total)}/${total}`;
	switch (q.state.status) {
		case "idle":
			return { label: "Queue idle", tone: "neutral", remaining };
		case "running":
			return { label: `Next ${pos}`, tone: "accent", remaining };
		case "paused":
			return { label: `Paused ${pos}`, tone: "warning", remaining };
		case "interrupted":
			return {
				label: `Interrupted ${pos}`,
				tone: "danger",
				remaining,
			};
		case "finished":
			return { label: `Done · ${plural(total, "item")}`, tone: "success", remaining: 0 };
	}
}

/** Items in paste order, honouring reversal. `position` indexes into this order. */
export function orderedQueue(q: QueueState): ClipItem[] {
	return q.reversed ? [...q.items].reverse() : q.items;
}

export function looksLikeCode(text: string): boolean {
	const lines = text.split("\n");
	if (lines.length < 2) return /^[\s]*[{[<]|;\s*$|=>|\bfunction\b/.test(text);
	const indented = lines.filter(l => /^( {2,}|\t)/.test(l)).length;
	const symbols = (text.match(/[{}();<>=]/g) ?? []).length;
	return indented / lines.length > 0.3 || symbols / text.length > 0.04;
}
