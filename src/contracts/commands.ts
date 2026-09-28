// UI ↔ shared command registry contract. Types only.

export type CommandKind =
	| "builtin"
	| "app"
	| "snippet"
	| "quicklink"
	| "script"
	| "extension";

export type CommandSideEffect = "none" | "local" | "network" | "destructive";

export type Command = {
	id: string; // stable
	title: string;
	subtitle?: string;
	kind: CommandKind;
	alias?: string;
	hotkey?: string; // normalized, e.g. "cmd+shift+k"
	/** Opt-in exposure to AI tool calls. */
	aiExposed: boolean;
	sideEffect: CommandSideEffect;
	/** Host enforces confirmation before running. */
	confirm: boolean;
	enabled: boolean;
};

export type Quicklink = {
	id: string;
	name: string;
	/** Template with {query} placeholder; host URL-encodes the argument. */
	url: string;
	alias?: string;
	/** Bundle id of app to open with, if not the default browser. */
	openWith?: string;
};

export type HotkeyConflict = {
	hotkey: string;
	commandIds: string[];
	/** Known system or other-app owner, when detectable. */
	external?: string;
};

export type ScriptRun = {
	id: string;
	commandId: string;
	runtime: string; // e.g. "/bin/zsh"
	args: string[];
	cwd: string;
	state: "confirming" | "running" | "done" | "failed" | "cancelled" | "timedOut";
	output: string;
	error?: string;
	exitCode?: number;
	timeoutMs: number;
	startedAt?: number;
	finishedAt?: number;
};

export interface CommandsContract {
	commands: Command[];
	quicklinks: Quicklink[];
	conflicts: HotkeyConflict[];
	activeRun: ScriptRun | null;

	setHotkey(commandId: string, hotkey: string | null): { ok: true } | { ok: false; conflict: HotkeyConflict };
	setAlias(commandId: string, alias: string | null): void;
	setAIExposed(commandId: string, exposed: boolean): void;
	saveQuicklink(link: Quicklink): boolean;
	removeQuicklink(id: string): boolean;
	openQuicklink(id: string, query: string): void;
	runScript(commandId: string): void; // enters "confirming"
	confirmRun(): void;
	cancelRun(): void;
}
