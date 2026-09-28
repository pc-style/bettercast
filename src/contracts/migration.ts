// UI ↔ migration (Raycast import) store contract. Types only.

export type ImportKind =
	| "snippet"
	| "quicklink"
	| "alias"
	| "hotkey"
	| "script"
	| "sequence"
	| "extension"
	| "setting"
	| "other";

export type ImportOutcome = "import" | "conflict" | "unsupported" | "skip";

export type ImportEntry = {
	id: string;
	kind: ImportKind;
	name: string;
	outcome: ImportOutcome;
	/** Why unsupported / skipped / conflicting. Required for anything other than "import". */
	reason?: string;
	/** Existing Bettercast item this collides with. */
	conflictWith?: string;
	/** Short readable detail of what would be created, e.g. keyword or URL template. */
	detail?: string;
	selected: boolean;
};

export type ImportPreview = {
	source: "raycast";
	/** File name only; no full path, no contents. */
	sourceLabel: string;
	entries: ImportEntry[];
	warnings: string[];
};

export type ImportReport = {
	appliedAt: number;
	imported: number;
	skipped: number;
	failed: { id: string; name: string; message: string }[];
	/** true while a rollback of this apply is possible. */
	canRollback: boolean;
};

export interface MigrationContract {
	current: ImportPreview | null;
	previewError: string | null;
	applying: boolean;
	report: ImportReport | null;

	/** Parse user-supplied export text into `current`. Read-only; writes nothing. */
	preview(raw: string): void;
	select(id: string, selected: boolean): void;
	/** Commits selected "import" entries after explicit user consent. */
	apply(): Promise<ImportReport>;
	rollback(): Promise<void>;
}
