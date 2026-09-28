import { test, expect } from "bun:test";
import { canonicalHotkey, quicklinkURL, parseExtension } from "./command-model";
test("shortcut order and aliases cannot hide duplicate bindings", () => {
	expect(canonicalHotkey("shift+cmd+k")).toBe("command+shift+k");
	expect(canonicalHotkey("⌘+shift+K")).toBe("command+shift+k");
	expect(() => canonicalHotkey("cmd+k+j")).toThrow();
	expect(() => canonicalHotkey("k")).toThrow();
});
test("quicklink query is data and unsafe URL schemes/credentials/placeholders are rejected", () => {
	expect(quicklinkURL("https://example.test/?q={query}", "żółć & #")).toBe(
		"https://example.test/?q=%C5%BC%C3%B3%C5%82%C4%87%20%26%20%23",
	);
	for (const url of [
		"javascript:alert(1)",
		"https://user:pass@example.test",
		"https://example.test/{clipboard}",
	])
		expect(() => quicklinkURL(url, "")).toThrow();
});
test("extension manifest is metadata only with explicit disabled default and no path escape", () => {
	const manifest = {
		version: 1,
		id: "hello",
		title: "Hello",
		runtime: "/opt/homebrew/bin/bun",
		entry: "main.ts",
		enabled: false,
	};
	expect(parseExtension(JSON.stringify(manifest)).enabled).toBe(false);
	expect(() =>
		parseExtension(JSON.stringify({ ...manifest, entry: "../main.ts" })),
	).toThrow();
});
