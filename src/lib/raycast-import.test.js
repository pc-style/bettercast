import { expect, test } from "bun:test";
import {
	applyRaycastImport,
	parseRaycastImport,
	planRaycastImport,
	rollbackRaycastImport,
} from "./raycast-import";

const empty = () => ({
	customItems: [],
	snippets: [],
	settings: {},
	stagedBindings: [],
});
const snapshot = (value) =>
	parseRaycastImport(
		JSON.stringify({
			schema: "bettercast.raycast-readable",
			version: 1,
			...value,
		}),
	);

test("parses recognizable formats deterministically and leaves everything unselected", () => {
	const a = parseRaycastImport(
		JSON.stringify({
			snippets: [{ name: "Hi", text: "Hello", keyword: "hh" }],
			links: [{ name: "Site", link: "https://example.com" }],
		}),
	);
	const b = parseRaycastImport(
		JSON.stringify({
			links: [{ link: "https://example.com", name: "Site" }],
			snippets: [{ text: "Hello", keyword: "hh", name: "Hi" }],
		}),
	);
	expect(a.entries.map((x) => x.selected)).toEqual([false, false]);
	expect(a.entries.map((x) => x.id)).toEqual(b.entries.map((x) => x.id));
});

test("rejects malformed, unknown, oversized and prototype-key JSON", () => {
	expect(() => parseRaycastImport("{")).toThrow("Malformed");
	expect(() => parseRaycastImport("{}")).toThrow("Unknown");
	expect(() => parseRaycastImport('{"snippets":[],"__proto__":{}}')).toThrow(
		"Unsafe",
	);
	expect(() =>
		parseRaycastImport(
			JSON.stringify({ snippets: [{ name: "x", text: "x".repeat(100001) }] }),
		),
	).toThrow("string over");
});

test("selection is per item, conflicts are asymmetric, and repeat is idempotent", () => {
	const preview = snapshot({
		snippets: [
			{ name: "Same", text: "new" },
			{ name: "Other", text: "ok" },
		],
	});
	const state = {
		...empty(),
		snippets: [{ id: "local", name: "Same", text: "old" }],
	};
	const selected = preview.entries.map((x) => x.id);
	const plan = planRaycastImport(preview, state, selected);
	expect(plan.preview.entries.map((x) => x.status)).toEqual([
		"conflict",
		"import",
	]);
	const first = applyRaycastImport(plan, state);
	expect(first.state.snippets).toHaveLength(2);
	const repeat = planRaycastImport(preview, first.state, selected);
	expect(repeat.preview.entries.map((x) => x.status)).toEqual([
		"conflict",
		"skip",
	]);
	expect(
		planRaycastImport(preview, state, [selected[1]]).operations,
	).toHaveLength(1);
});

test("unsupported placeholders, history consent and dangerous URLs never produce operations", () => {
	const preview = snapshot({
		quicklinks: [{ name: "Bad", link: "javascript:alert(1)" }],
		commands: [{ commandId: "missing", hotkey: "cmd+x" }],
		history: [{ query: "private" }],
	});
	const plan = planRaycastImport(
		preview,
		empty(),
		preview.entries.map((x) => x.id),
		{},
		true,
	);
	expect(plan.operations).toHaveLength(0);
	expect(plan.preview.entries.every((x) => x.status === "unsupported")).toBe(
		true,
	);
});

test("mapped aliases/hotkeys are staged disabled and takeover settings are refused", () => {
	const preview = snapshot({
		commands: [{ commandId: "a", alias: "go", hotkey: "cmd+g" }],
		settings: { start: true, theme: "dark" },
	});
	const plan = planRaycastImport(
		preview,
		empty(),
		preview.entries.map((x) => x.id),
		{
			commandIds: { a: "better.a" },
			settings: { start: "launchAtLogin", theme: "appearance" },
		},
	);
	const result = applyRaycastImport(plan, empty());
	expect(result.state.stagedBindings).toHaveLength(2);
	expect(result.state.stagedBindings.every((x) => x.enabled === false)).toBe(
		true,
	);
	expect(result.state.settings).toEqual({ appearance: "dark" });
});

test("rollback preserves unrelated concurrent edits and refuses overwritten imported records", () => {
	const preview = snapshot({
		snippets: [
			{ name: "A", text: "one" },
			{ name: "B", text: "two" },
		],
	});
	const imported = applyRaycastImport(
		planRaycastImport(
			preview,
			empty(),
			preview.entries.map((x) => x.id),
		),
		empty(),
	);
	const concurrent = structuredClone(imported.state);
	concurrent.snippets[0].text = "user edit";
	concurrent.snippets.push({ id: "later", name: "Later", text: "keep" });
	const rolled = rollbackRaycastImport(imported.receipt, concurrent);
	expect(rolled.state.snippets.map((x) => x.text)).toEqual([
		"user edit",
		"keep",
	]);
	expect(rolled.receipt.skipped).toHaveLength(1);
});
