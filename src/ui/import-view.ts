import type { ImportEntry, ImportKind, ImportOutcome, ImportPreview } from "contracts/migration";
import type { Tone } from "./clipboard-view";

export const OUTCOME: Record<ImportOutcome, { label: string; tone: Tone }> = {
	import: { label: "Will import", tone: "success" },
	conflict: { label: "Conflict", tone: "warning" },
	unsupported: { label: "Unsupported", tone: "danger" },
	skip: { label: "Skipped", tone: "neutral" },
};

export const KIND_LABEL: Record<ImportKind, string> = {
	snippet: "Snippets",
	quicklink: "Quicklinks",
	alias: "Aliases",
	hotkey: "Hotkeys",
	script: "Scripts",
	sequence: "Sequential paste",
	extension: "Extensions",
	setting: "Settings",
	other: "Other",
};

const OUTCOME_ORDER: ImportOutcome[] = ["conflict", "unsupported", "import", "skip"];

export type ImportRow =
	| { type: "header"; key: string; label: string; count: number }
	| { type: "entry"; key: string; entry: ImportEntry };

/** Flatten entries into outcome sections (problems first) for a single keyboard list. */
export function importRows(preview: ImportPreview): ImportRow[] {
	const rows: ImportRow[] = [];
	for (const outcome of OUTCOME_ORDER) {
		const entries = preview.entries.filter(e => e.outcome === outcome);
		if (!entries.length) continue;
		rows.push({ type: "header", key: `h-${outcome}`, label: OUTCOME[outcome].label, count: entries.length });
		for (const entry of entries) rows.push({ type: "entry", key: entry.id, entry });
	}
	return rows;
}

export function importCounts(preview: ImportPreview): Record<ImportOutcome, number> & { selected: number } {
	const counts = { import: 0, conflict: 0, unsupported: 0, skip: 0, selected: 0 };
	for (const e of preview.entries) {
		counts[e.outcome]++;
		if (e.selected && e.outcome === "import") counts.selected++;
	}
	return counts;
}

/** Only "import" entries are selectable; conflicts and unsupported need resolution elsewhere. */
export function isSelectable(entry: ImportEntry): boolean {
	return entry.outcome === "import";
}

/** Every non-importing entry must carry a reason so the report is never silent. */
export function missingReasons(preview: ImportPreview): ImportEntry[] {
	return preview.entries.filter(e => e.outcome !== "import" && !e.reason?.trim());
}
