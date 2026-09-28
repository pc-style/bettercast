// Synthetic, deliberately asymmetric fixtures loaded by the `test.seed`
// command (test modes only). Never real user data: different lengths,
// unicode, one very long item, one empty-ish item, one image.

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import type { AppEntry, ProviderInfo, Snippet } from "./shared.ts";
import type { Clip } from "./model.ts";

export const FIXTURE_APPS: readonly AppEntry[] = [
  { name: utf8Bytes("Fixture Browser"), path: utf8Bytes("/Applications/Fixture Browser.app") },
  { name: utf8Bytes("Ångström Editor"), path: utf8Bytes("/Applications/Ångström Editor.app") },
  { name: utf8Bytes("Q"), path: utf8Bytes("/Applications/Q.app") },
  { name: utf8Bytes("Terminal Fixture"), path: utf8Bytes("/Applications/Utilities/Terminal Fixture.app") },
  { name: utf8Bytes("Système Préférences Fixture With A Deliberately Long Bundle Name"), path: utf8Bytes("/System/Applications/Système Préférences Fixture With A Deliberately Long Bundle Name.app") },
  { name: utf8Bytes("Safari Fixture"), path: utf8Bytes("/Applications/Safari Fixture.app") },
];

export const FIXTURE_SNIPPETS: readonly Snippet[] = [
  { id: 1, name: utf8Bytes("Email sign-off"), keyword: asciiBytes("sig"), body: utf8Bytes("Best,\nA. Fixture"), updatedMs: 1700000000000 },
  { id: 2, name: utf8Bytes("Grüße 👋"), keyword: asciiBytes(""), body: utf8Bytes("Viele Grüße aus der Testumgebung — ✓"), updatedMs: 1700000100000 },
  { id: 3, name: utf8Bytes("Long lorem"), keyword: asciiBytes("lorem"), body: utf8Bytes("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat."), updatedMs: 1700000200000 },
  { id: 4, name: utf8Bytes("x"), keyword: asciiBytes(""), body: utf8Bytes(" "), updatedMs: 1700000300000 },
];

// Newest first (the index order). Asymmetric on purpose: a 240-byte
// preview of a longer text, unicode, one image, one whitespace-only clip.
export const FIXTURE_CLIPS: readonly Clip[] = [
  { id: 9, kind: "text", sha: asciiBytes("5555555555555555555555555555555555555555555555555555555555555555"), size: 5321, width: 0, height: 0, preview: utf8Bytes("Quarterly sample report, section 7: synthetic rows only. Quarterly sample report, section 7: synthetic rows only. Quarterly sample report, section 7: synthetic rows only. Quarterly sample report, section 7: synthetic rows only. Quarterly sa"), sourceBundle: asciiBytes("dev.fixture.sheets"), firstMs: 1700000800000, lastMs: 1700000800000, pinned: false },
  { id: 8, kind: "text", sha: asciiBytes("4444444444444444444444444444444444444444444444444444444444444444"), size: 1, width: 0, height: 0, preview: utf8Bytes(" "), sourceBundle: asciiBytes(""), firstMs: 1700000700000, lastMs: 1700000700000, pinned: false },
  { id: 7, kind: "image", sha: asciiBytes("3333333333333333333333333333333333333333333333333333333333333333"), size: 2048, width: 64, height: 48, preview: asciiBytes(""), sourceBundle: asciiBytes("dev.fixture.browser"), firstMs: 1700000600000, lastMs: 1700000600000, pinned: false },
  { id: 6, kind: "text", sha: asciiBytes("2222222222222222222222222222222222222222222222222222222222222222"), size: 24, width: 0, height: 0, preview: utf8Bytes("naïve café — 日本語 ✓"), sourceBundle: asciiBytes("dev.fixture.browser"), firstMs: 1700000500000, lastMs: 1700000500000, pinned: false },
  { id: 5, kind: "text", sha: asciiBytes("1111111111111111111111111111111111111111111111111111111111111111"), size: 11, width: 0, height: 0, preview: utf8Bytes("hello there"), sourceBundle: asciiBytes("dev.fixture.editor"), firstMs: 1700000400000, lastMs: 1700000400000, pinned: true },
];

export const FIXTURE_PROVIDERS: readonly ProviderInfo[] = [
  { id: "claude", binPath: asciiBytes("/opt/fixture/bin/claude") },
  { id: "codex", binPath: asciiBytes("/opt/fixture/bin/codex") },
];

export const FIXTURE_NEXT_ID = 100;
