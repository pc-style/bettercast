import { describe, expect, test } from "bun:test";
import {
	formatArgs,
	hostOf,
	messageText,
	planSend,
	splitSegments,
} from "./ai-view";
import {
	captureLabel,
	deliveryMessage,
	orderedQueue,
	queueSummary,
	retentionSummary,
	sinceFor,
} from "./clipboard-view";
import { formatBytes, formatRemaining, relativeTime } from "./format";
import { importCounts, importRows, isSelectable, missingReasons } from "./import-view";
import { clampSelection, moveSelection, shouldLoadMore, toggleOrdered } from "./selection";

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

describe("format", () => {
	test("relative time stays compact", () => {
		expect(relativeTime(NOW - 10_000, NOW)).toBe("now");
		expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m");
		expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h");
		expect(relativeTime(NOW - 30 * 3_600_000, NOW)).toBe("Yesterday");
		expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe("4d");
		expect(relativeTime(NOW + 60_000, NOW)).toBe("now"); // clock skew never shows negative
	});
	test("bytes", () => {
		expect(formatBytes(undefined)).toBe("—");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
	});
	test("remaining", () => {
		expect(formatRemaining(NOW + 12 * 60_000, NOW)).toBe("12m");
		expect(formatRemaining(NOW + 65 * 60_000, NOW)).toBe("1h 5m");
	});
});

describe("selection", () => {
	test("moves within bounds", () => {
		expect(moveSelection(0, -1, 5)).toBe(0);
		expect(moveSelection(4, 1, 5)).toBe(4);
		expect(moveSelection(2, 1, 0)).toBe(0);
	});
	test("clamps after deletion", () => {
		expect(clampSelection(9, 3)).toBe(2);
	});
	test("loads more near the end only when possible", () => {
		expect(shouldLoadMore(45, 50, true, false)).toBe(true);
		expect(shouldLoadMore(45, 50, false, false)).toBe(false);
		expect(shouldLoadMore(45, 50, true, true)).toBe(false);
		expect(shouldLoadMore(10, 50, true, false)).toBe(false);
	});
	test("ordered toggle keeps mark order", () => {
		expect(toggleOrdered(toggleOrdered(toggleOrdered([], "b"), "a"), "c")).toEqual(["b", "a", "c"]);
		expect(toggleOrdered(["b", "a", "c"], "a")).toEqual(["b", "c"]);
	});
});

describe("clipboard view", () => {
	test("capture states are explicit", () => {
		expect(captureLabel({ status: "capturing" }, NOW).tone).toBe("success");
		expect(captureLabel({ status: "paused", until: NOW + 30 * 60_000 }, NOW).label).toBe("Paused · 30m");
		expect(captureLabel({ status: "private" }, NOW).detail).toContain("suspended");
		expect(captureLabel({ status: "denied", reason: "Accessibility off" }, NOW)).toEqual({
			label: "No access",
			tone: "danger",
			detail: "Accessibility off",
		});
	});
	test("retention conflict is surfaced, not hidden", () => {
		const ok = retentionSummary({ retentionDays: 30, capBytes: 2e9, usedBytes: 5e8, effectiveDays: 30, itemCount: 9717 });
		expect(ok.conflict).toBe(false);
		expect(ok.text).toContain("9717 items");
		const capped = retentionSummary({ retentionDays: 30, capBytes: 1e9, usedBytes: 1e9, effectiveDays: 11.6, itemCount: 4000 });
		expect(capped.conflict).toBe(true);
		expect(capped.text).toContain("~11 days of your 30-day retention");
	});
	test("paste is never reported as verified", () => {
		expect(deliveryMessage({ status: "dispatched" })).toBeNull();
		expect(deliveryMessage({ status: "focusChanged", message: "Focus moved to another window; nothing was pasted" }).tone).toBe("warning");
		expect(deliveryMessage({ status: "failed", message: "x" }).tone).toBe("danger");
	});
	test("queue summary and order", () => {
		const q = { items: [{ id: "a" }, { id: "b" }, { id: "c" }], position: 1, reversed: false, state: { status: "running" } };
		expect(queueSummary(q)).toEqual({ label: "Next 2/3", tone: "accent", remaining: 2 });
		expect(queueSummary({ ...q, state: { status: "interrupted", reason: "Focus changed" } }).tone).toBe("danger");
		expect(orderedQueue({ ...q, reversed: true }).map(i => i.id)).toEqual(["c", "b", "a"]);
	});
	test("time filters", () => {
		expect(sinceFor(0, NOW)).toBeUndefined();
		expect(sinceFor(2, NOW)).toBe(NOW - 7 * 86_400_000);
	});
});

const claude = {
	id: "claude-cli",
	label: "Claude CLI",
	accessMethod: "Installed Claude CLI",
	available: true,
	models: [{ id: "default", label: "Default" }],
	capabilities: { streaming: true, images: true, pdf: false, textFiles: true, webSearch: false, tools: false },
};
const draft = (over = {}) => ({
	text: "Explain this",
	attachments: [],
	providerId: "claude-cli",
	modelId: "default",
	webSearch: false,
	toolsEnabled: false,
	...over,
});

describe("ai view", () => {
	test("segments tolerate an unclosed streaming fence", () => {
		expect(splitSegments("Hi\n```ts\nconst a = 1\n```\nBye")).toEqual([
			{ type: "prose", text: "Hi" },
			{ type: "code", lang: "ts", text: "const a = 1", closed: true },
			{ type: "prose", text: "Bye" },
		]);
		expect(splitSegments("Run:\n```sh\nls -la")).toEqual([
			{ type: "prose", text: "Run:" },
			{ type: "code", lang: "sh", text: "ls -la", closed: false },
		]);
		expect(splitSegments("plain")).toEqual([{ type: "prose", text: "plain" }]);
	});

	test("send plan discloses exactly what leaves the device", () => {
		const plan = planSend(
			draft({ attachments: [{ id: "1", name: "shot.png", kind: "image", origin: "paste", bytes: 2048, status: "ready" }] }),
			[claude],
			false,
		);
		expect(plan.canSend).toBe(true);
		expect(plan.disclosure).toBe("Sends prompt + 1 attachment (2.0 KB) to Claude CLI");
	});

	test("send is blocked with a reason instead of dropping material", () => {
		const pdf = { id: "2", name: "spec.pdf", kind: "pdf", origin: "file", bytes: 10, status: "ready" };
		expect(planSend(draft({ attachments: [pdf] }), [claude], false)).toMatchObject({
			canSend: false,
			blocker: "Claude CLI cannot read spec.pdf",
		});
		const big = { ...pdf, kind: "image", status: "tooLarge" };
		expect(planSend(draft({ attachments: [big] }), [claude], false).blocker).toBe("Remove spec.pdf: too large");
		expect(planSend(draft({ providerId: null }), [claude], false).blocker).toBe("Choose a provider");
		expect(planSend(draft(), [{ ...claude, available: false, reason: "Claude CLI not found on PATH" }], false).blocker).toBe(
			"Claude CLI not found on PATH",
		);
		expect(planSend(draft({ text: "  " }), [claude], false).blocker).toBe("Type a message");
		expect(planSend(draft(), [claude], true).canSend).toBe(false);
	});

	test("web search request on an incapable provider warns rather than pretending", () => {
		const plan = planSend(draft({ webSearch: true }), [claude], false);
		expect(plan.disclosure).not.toContain("web search");
		expect(plan.warnings[0]).toContain("cannot search the web");
	});

	test("message text excludes tool cards and sources", () => {
		expect(
			messageText({
				id: "m",
				role: "assistant",
				createdAt: 0,
				blocks: [
					{ type: "text", text: "A" },
					{ type: "tool", call: { id: "t", source: "mcp:fs", tool: "read", args: {}, sideEffects: ["read"], state: "done" } },
					{ type: "sources", citations: [{ url: "https://x.dev" }] },
					{ type: "text", text: "B" },
				],
			}),
		).toBe("A\n\nB");
	});

	test("small helpers", () => {
		expect(hostOf("https://www.example.com/a?b")).toBe("example.com");
		expect(formatArgs({ path: "/tmp/a", depth: 2 })).toBe("path: /tmp/a · depth: 2");
	});
});

describe("import view", () => {
	const preview = {
		source: "raycast",
		sourceLabel: "export.rayconfig",
		warnings: [],
		entries: [
			{ id: "1", kind: "snippet", name: "Address", outcome: "import", selected: true },
			{ id: "2", kind: "quicklink", name: "Search GitHub", outcome: "conflict", reason: "Alias gh already used", conflictWith: "GitHub", selected: false },
			{ id: "3", kind: "extension", name: "Notes", outcome: "unsupported", reason: "Raycast extension runtime not supported", selected: false },
			{ id: "4", kind: "snippet", name: "Sig", outcome: "import", selected: false },
			{ id: "5", kind: "setting", name: "Theme", outcome: "skip", selected: false },
		],
	};
	test("problems are listed first", () => {
		const rows = importRows(preview);
		expect(rows.map(r => (r.type === "header" ? `#${r.label}` : r.entry.id))).toEqual([
			"#Conflict", "2", "#Unsupported", "3", "#Will import", "1", "4", "#Skipped", "5",
		]);
	});
	test("counts and selection", () => {
		expect(importCounts(preview)).toEqual({ import: 2, conflict: 1, unsupported: 1, skip: 1, selected: 1 });
		expect(isSelectable(preview.entries[1])).toBe(false);
	});
	test("silent non-imports are detected", () => {
		expect(missingReasons(preview).map(e => e.id)).toEqual(["5"]);
	});
});
