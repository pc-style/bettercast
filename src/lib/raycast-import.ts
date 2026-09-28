/** Pure, read-only parsing and transactional planning for user-selected Raycast JSON. */

export const RAYCAST_IMPORT_LIMITS = {
	maxBytes: 1_048_576,
	maxEntries: 1_000,
	maxStringLength: 100_000,
} as const;

export type ImportKind =
	| "snippet"
	| "quicklink"
	| "alias"
	| "shortcut"
	| "setting"
	| "history";
export type ImportStatus = "import" | "conflict" | "unsupported" | "skip";
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface NormalizedRaycastSnapshot {
	schema: "bettercast.raycast-readable";
	version: 1;
	snippets?: Array<{ name: string; text: string; keyword?: string }>;
	quicklinks?: Array<{ name: string; link: string }>;
	commands?: Array<{ commandId: string; alias?: string; hotkey?: string }>;
	settings?: Record<string, JsonValue>;
	history?: JsonValue[];
}

export interface ImportEntry {
	id: string;
	kind: ImportKind;
	name: string;
	status: ImportStatus;
	reason: string;
	data: JsonValue;
	selected: false;
}

export interface ImportPreview {
	format: "raycast-json" | "bettercast-readable-v1";
	version: 1;
	entries: ImportEntry[];
	warnings: string[];
}

export interface ImportState {
	customItems: Array<{
		id: string;
		type: string;
		name: string;
		url?: string;
		alias?: string;
		[key: string]: unknown;
	}>;
	snippets: Array<{ id: string; name: string; text: string }>;
	settings: Record<string, JsonValue>;
	/** Requested bindings are deliberately inert until another layer explicitly enables one. */
	stagedBindings: Array<{
		id: string;
		commandId: string;
		binding: string;
		enabled: false;
	}>;
	history?: JsonValue[];
}

export interface ImportMappings {
	/** Raycast command id -> Bettercast command id. Unlisted commands are unsupported. */
	commandIds?: Record<string, string>;
	/** Snapshot setting name -> Bettercast setting name. Unlisted settings are unsupported. */
	settings?: Record<string, string>;
}

export interface ImportPlan {
	preview: ImportPreview;
	selectedIds: string[];
	operations: ImportOperation[];
}

export interface ImportOperation {
	entryId: string;
	collection:
		| "customItems"
		| "snippets"
		| "settings"
		| "stagedBindings"
		| "history";
	key: string;
	hadBefore: boolean;
	before: JsonValue | null;
	after: JsonValue;
}

export interface ImportReceipt {
	version: 1;
	receiptId: string;
	applied: ImportOperation[];
	skipped: Array<{ id: string; reason: string }>;
}

export interface ImportReport {
	state: ImportState;
	receipt: ImportReceipt;
}

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const own = (object: object, key: string) =>
	Object.prototype.hasOwnProperty.call(object, key);
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const clean = (value: string) => value.trim();

function utf8Length(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			bytes += 4;
			index++;
		} else bytes += 3;
	}
	return bytes;
}

function validateTree(value: unknown, count = { entries: 0 }): void {
	if (
		typeof value === "string" &&
		value.length > RAYCAST_IMPORT_LIMITS.maxStringLength
	)
		throw new Error("Raycast import contains a string over the limit");
	if (Array.isArray(value)) {
		count.entries += value.length;
		if (count.entries > RAYCAST_IMPORT_LIMITS.maxEntries)
			throw new Error("Raycast import has too many entries");
		for (const item of value) validateTree(item, count);
	} else if (object(value)) {
		for (const key of Object.keys(value)) {
			if (forbidden.has(key)) throw new Error(`Unsafe JSON key: ${key}`);
			validateTree(value[key], count);
		}
	}
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (object(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function hash(value: unknown): string {
	let result = 2166136261;
	for (const char of stable(value)) {
		result ^= char.charCodeAt(0);
		result = Math.imul(result, 16777619);
	}
	return (result >>> 0).toString(36);
}

const entry = (
	kind: ImportKind,
	name: string,
	data: JsonValue,
	status: ImportStatus = "import",
	reason = "Ready to import",
): ImportEntry => ({
	id: `raycast-${kind}-${hash({ kind, name, data })}`,
	kind,
	name,
	status,
	reason,
	data,
	selected: false,
});

export function parseRaycastImport(raw: string): ImportPreview {
	if (
		typeof raw !== "string" ||
		utf8Length(raw) > RAYCAST_IMPORT_LIMITS.maxBytes
	)
		throw new Error("Raycast import exceeds the 1 MiB limit");
	let root: unknown;
	try {
		root = JSON.parse(raw);
	} catch {
		throw new Error("Malformed Raycast JSON");
	}
	validateTree(root);
	if (!object(root)) throw new Error("Raycast import must be a JSON object");
	if (own(root, "encrypted") || own(root, "ciphertext") || own(root, "archive"))
		throw new Error(
			"Encrypted or compressed Raycast exports are unsupported; provide readable JSON",
		);

	const normalized = root.schema === "bettercast.raycast-readable";
	if (normalized && root.version !== 1)
		throw new Error(
			`Unsupported readable snapshot version: ${String(root.version)}`,
		);
	const entries: ImportEntry[] = [];
	const snippets = Array.isArray(root.snippets) ? root.snippets : [];
	for (const item of snippets) {
		if (
			object(item) &&
			text(item.name) &&
			clean(item.name) &&
			text(item.text) &&
			item.text.length
		)
			entries.push(
				entry("snippet", clean(item.name), {
					name: clean(item.name),
					text: item.text,
					...(text(item.keyword) && clean(item.keyword)
						? { keyword: clean(item.keyword) }
						: {}),
				}),
			);
		else
			entries.push(
				entry(
					"snippet",
					object(item) && text(item.name) ? item.name : "Invalid snippet",
					{},
					"unsupported",
					"Snippet requires non-empty name and text",
				),
			);
	}
	const links = Array.isArray(root.quicklinks)
		? root.quicklinks
		: Array.isArray(root.links)
			? root.links
			: [];
	for (const item of links) {
		if (
			object(item) &&
			text(item.name) &&
			clean(item.name) &&
			text(item.link) &&
			clean(item.link)
		)
			entries.push(
				entry("quicklink", clean(item.name), {
					name: clean(item.name),
					link: clean(item.link),
				}),
			);
		else
			entries.push(
				entry(
					"quicklink",
					object(item) && text(item.name) ? item.name : "Invalid quicklink",
					{},
					"unsupported",
					"Quicklink requires non-empty name and link",
				),
			);
	}
	if (Array.isArray(root.commands))
		for (const command of root.commands) {
			if (!object(command) || !text(command.commandId)) {
				entries.push(
					entry(
						"alias",
						"Invalid command preference",
						{},
						"unsupported",
						"Command preference requires commandId",
					),
				);
				continue;
			}
			if (text(command.alias) && clean(command.alias))
				entries.push(
					entry("alias", clean(command.alias), {
						commandId: command.commandId,
						alias: clean(command.alias),
					}),
				);
			if (text(command.hotkey) && clean(command.hotkey))
				entries.push(
					entry(
						"shortcut",
						command.commandId,
						{ commandId: command.commandId, binding: clean(command.hotkey) },
						"import",
						"Binding will be staged disabled",
					),
				);
		}
	if (object(root.settings))
		for (const key of Object.keys(root.settings).sort())
			entries.push(
				entry("setting", key, { key, value: root.settings[key] as JsonValue }),
			);
	if (Array.isArray(root.history))
		for (let i = 0; i < root.history.length; i++)
			entries.push(
				entry(
					"history",
					`History ${i + 1}`,
					root.history[i] as JsonValue,
					"unsupported",
					"History needs an explicit supported adapter and opt-in",
				),
			);
	if (!normalized && snippets.length === 0 && links.length === 0)
		throw new Error(
			"Unknown Raycast JSON format; no recognizable snippets or quicklinks found",
		);
	return {
		format: normalized ? "bettercast-readable-v1" : "raycast-json",
		version: 1,
		entries,
		warnings: [],
	};
}

function dangerousUrl(url: string): boolean {
	if (!/^(https?:\/\/|mailto:)/i.test(url)) return true;
	try {
		new URL(url);
		return false;
	} catch {
		return true;
	}
}

export function planRaycastImport(
	preview: ImportPreview,
	state: ImportState,
	selectedIds: readonly string[],
	mappings: ImportMappings = {},
	historyOptIn = false,
): ImportPlan {
	if (preview.version !== 1) throw new Error("Unsupported preview version");
	const selected = new Set(selectedIds);
	const operations: ImportOperation[] = [];
	const entries: ImportEntry[] = preview.entries.map((source): ImportEntry => {
		let current = { ...source };
		if (!selected.has(source.id))
			return {
				...current,
				status:
					source.status === "unsupported"
						? ("unsupported" as const)
						: ("skip" as const),
				reason:
					source.status === "unsupported" ? source.reason : "Not selected",
			};
		if (source.status === "unsupported") return current;
		const data = source.data as Record<string, JsonValue>;
		let collection: ImportOperation["collection"];
		let key: string;
		let after: JsonValue;
		let before: JsonValue | null = null;
		let hadBefore = false;
		if (source.kind === "snippet") {
			collection = "snippets";
			key = source.id;
			after = { id: key, name: data.name, text: data.text };
			const sameName = state.snippets.find(
				(item) =>
					item.name.toLocaleLowerCase() ===
					String(data.name).toLocaleLowerCase(),
			);
			const byId = state.snippets.find((item) => item.id === key);
			hadBefore = byId !== undefined;
			before = (byId ?? null) as JsonValue | null;
			if (sameName && sameName.text !== data.text && sameName.id !== key)
				current = {
					...current,
					status: "conflict",
					reason: "A snippet with this name has different text",
				};
		} else if (source.kind === "quicklink") {
			if (dangerousUrl(String(data.link)))
				return {
					...current,
					status: "unsupported",
					reason: "Only http, https, and mailto quicklinks are allowed",
				};
			collection = "customItems";
			key = source.id;
			after = { id: key, type: "url", name: data.name, url: data.link };
			const sameName = state.customItems.find(
				(item) =>
					item.name.toLocaleLowerCase() ===
					String(data.name).toLocaleLowerCase(),
			);
			const byId = state.customItems.find((item) => item.id === key);
			hadBefore = byId !== undefined;
			before = (byId ?? null) as JsonValue | null;
			if (sameName && sameName.url !== data.link && sameName.id !== key)
				current = {
					...current,
					status: "conflict",
					reason: "An item with this name has a different URL",
				};
		} else if (source.kind === "alias" || source.kind === "shortcut") {
			const mapped = mappings.commandIds?.[String(data.commandId)];
			if (!mapped)
				return {
					...current,
					status: "unsupported",
					reason: "Command ID has no supplied mapping",
				};
			collection = "stagedBindings";
			key = source.id;
			after = {
				id: key,
				commandId: mapped,
				binding: String(source.kind === "alias" ? data.alias : data.binding),
				enabled: false,
			};
			const existing = state.stagedBindings.find((item) => item.id === key);
			hadBefore = existing !== undefined;
			before = (existing ?? null) as JsonValue | null;
		} else if (source.kind === "setting") {
			const mapped = mappings.settings?.[String(data.key)];
			if (!mapped)
				return {
					...current,
					status: "unsupported",
					reason: "Setting has no supplied mapping",
				};
			if (
				["globalShortcut", "launchAtLogin", "hyperKeyEnabled"].includes(mapped)
			)
				return {
					...current,
					status: "unsupported",
					reason: "Takeover settings cannot be imported",
				};
			collection = "settings";
			key = mapped;
			after = data.value;
			hadBefore = own(state.settings, key);
			before = hadBefore ? state.settings[key] : null;
		} else {
			if (!historyOptIn)
				return {
					...current,
					status: "unsupported",
					reason: "History import was not explicitly opted in",
				};
			return {
				...current,
				status: "unsupported",
				reason: "No history adapter is available",
			};
		}
		if (current.status !== "conflict" && stable(before) === stable(after))
			return {
				...current,
				status: "skip" as const,
				reason: "Already imported",
			};
		if (current.status === "conflict") return current;
		operations.push({
			entryId: source.id,
			collection,
			key,
			hadBefore,
			before,
			after,
		});
		return { ...current, status: "import" as const, reason: "Ready to import" };
	});
	return {
		preview: { ...preview, entries },
		selectedIds: [...selected].sort(),
		operations,
	};
}

function cloneState(state: ImportState): ImportState {
	return JSON.parse(JSON.stringify(state)) as ImportState;
}

export function applyRaycastImport(
	plan: ImportPlan,
	state: ImportState,
): ImportReport {
	const next = cloneState(state);
	const applied: ImportOperation[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	// Validate every optimistic precondition before changing anything: a stale plan is all-or-nothing.
	for (const operation of plan.operations) {
		const list =
			operation.collection === "settings"
				? null
				: (next[operation.collection] as unknown[]);
		const index =
			list?.findIndex((item) => object(item) && item.id === operation.key) ??
			-1;
		const exists =
			operation.collection === "settings"
				? own(next.settings, operation.key)
				: index >= 0;
		const live =
			operation.collection === "settings"
				? exists
					? next.settings[operation.key]
					: null
				: exists
					? (list![index] as JsonValue)
					: null;
		if (
			exists !== operation.hadBefore ||
			stable(live) !== stable(operation.before)
		) {
			return {
				state: next,
				receipt: {
					version: 1,
					receiptId: `raycast-receipt-${hash([])}`,
					applied: [],
					skipped: plan.operations.map((item) => ({
						id: item.entryId,
						reason: "Atomic import refused because state changed after preview",
					})),
				},
			};
		}
	}
	for (const operation of plan.operations) {
		const list =
			operation.collection === "settings"
				? null
				: (next[operation.collection] as unknown[]);
		if (operation.collection === "settings")
			next.settings[operation.key] = operation.after;
		else {
			const index = list!.findIndex(
				(item) => object(item) && item.id === operation.key,
			);
			if (index < 0) list!.push(operation.after);
			else list![index] = operation.after;
		}
		applied.push(operation);
	}
	return {
		state: next,
		receipt: {
			version: 1,
			receiptId: `raycast-receipt-${hash(applied)}`,
			applied,
			skipped,
		},
	};
}

export function rollbackRaycastImport(
	receipt: ImportReceipt,
	state: ImportState,
): ImportReport {
	if (receipt.version !== 1) throw new Error("Unsupported receipt version");
	const next = cloneState(state);
	const applied: ImportOperation[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	for (const operation of [...receipt.applied].reverse()) {
		if (operation.collection === "settings") {
			const live = own(next.settings, operation.key)
				? next.settings[operation.key]
				: null;
			if (stable(live) !== stable(operation.after)) {
				skipped.push({
					id: operation.entryId,
					reason: "Imported setting was subsequently changed",
				});
				continue;
			}
			if (!operation.hadBefore) delete next.settings[operation.key];
			else next.settings[operation.key] = operation.before;
		} else {
			const list = next[operation.collection] as unknown[];
			const index = list.findIndex(
				(item) => object(item) && item.id === operation.key,
			);
			if (index < 0 || stable(list[index]) !== stable(operation.after)) {
				skipped.push({
					id: operation.entryId,
					reason: "Imported record was subsequently changed",
				});
				continue;
			}
			if (!operation.hadBefore) list.splice(index, 1);
			else list[index] = operation.before;
		}
		applied.push(operation);
	}
	return {
		state: next,
		receipt: {
			version: 1,
			receiptId: `raycast-rollback-${hash(applied)}`,
			applied,
			skipped,
		},
	};
}
