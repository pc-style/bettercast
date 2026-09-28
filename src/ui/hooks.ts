import type { AIContract, McpContract } from "contracts/ai";
import type { ClipboardContract } from "contracts/clipboard";
import type { CommandsContract } from "contracts/commands";
import type { MigrationContract } from "contracts/migration";
import { solNative } from "lib/SolNative";
import { useEffect, useRef, useState } from "react";
import { useStore } from "store";
import { createCaptureStack } from "./capture-stack";
import type { KeyHandler } from "./keys";

/** Route native keyDown events to `handler` while mounted (and `active`). Newest handler wins. */
export function useKeyHandler(handler: KeyHandler, active = true) {
	const { keystroke } = useStore();
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		if (!active) return;
		return keystroke.pushKeyHandler(event => ref.current(event));
	}, [active, keystroke]);
}

const captureStack = createCaptureStack(capture => {
	capture.enter ? solNative.turnOnEnterListener() : solNative.turnOffEnterListener();
	capture.vertical ? solNative.turnOnVerticalArrowsListeners() : solNative.turnOffVerticalArrowsListeners();
	capture.horizontal
		? solNative.turnOnHorizontalArrowsListeners()
		: solNative.turnOffHorizontalArrowsListeners();
});

/**
 * Choose which keys native swallows and forwards to JS while mounted (and `active`).
 * With a capture off, the key goes to the focused text field and JS never sees it.
 * Nested requests stack: the newest applies and unmounting restores the one below.
 */
export function useNativeKeyCapture(
	capture: { enter: boolean; vertical: boolean; horizontal?: boolean },
	active = true,
) {
	const { enter, vertical, horizontal = false } = capture;
	useEffect(() => {
		if (!active) return;
		return captureStack.push({ enter, vertical, horizontal });
	}, [enter, vertical, horizontal, active]);
}

/** Re-render on an interval so relative times and countdowns stay current. */
export function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

type RootWithContracts = {
	clipboard: unknown;
	ai?: AIContract;
	mcp?: McpContract;
	migration?: MigrationContract;
	commands?: CommandsContract;
};

// Stores are feature-detected so a build without a backend shows an honest
// "not available in this build" state instead of fabricated data.

export function useClipboardContract(): ClipboardContract | null {
	const root = useStore() as unknown as RootWithContracts;
	const c = root.clipboard as Partial<ClipboardContract> | undefined;
	return c && typeof c.load === "function" && typeof c.act === "function"
		? (c as ClipboardContract)
		: null;
}

export function useAIContract(): AIContract | null {
	const root = useStore() as unknown as RootWithContracts;
	return root.ai && typeof root.ai.send === "function" ? root.ai : null;
}

export function useMcpContract(): McpContract | null {
	const root = useStore() as unknown as RootWithContracts;
	return root.mcp && typeof root.mcp.revokeGrant === "function" ? root.mcp : null;
}

export function useMigrationContract(): MigrationContract | null {
	const root = useStore() as unknown as RootWithContracts;
	return root.migration && typeof root.migration.apply === "function" ? root.migration : null;
}

export function useCommandsContract(): CommandsContract | null {
	const root = useStore() as unknown as RootWithContracts;
	return root.commands && typeof root.commands.setHotkey === "function" ? root.commands : null;
}
