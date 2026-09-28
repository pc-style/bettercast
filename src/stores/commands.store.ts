import { makeAutoObservable, runInAction } from "mobx";
import { Linking } from "react-native";
import type { IRootStore } from "../store";
import type {
	Command,
	CommandsContract,
	HotkeyConflict,
	Quicklink,
	ScriptRun,
} from "../contracts/commands";
import {
	canonicalHotkey,
	parseExtension,
	quicklinkURL,
	type ExtensionManifest,
} from "../lib/command-model";
import { solNative } from "../lib/SolNative";
import { nativeStream, requestID } from "../lib/native-stream";
import { UTF8StreamDecoder } from "../lib/ai-engine";
import { ItemType, Widget } from "./ui.store";

export type CommandsStore = ReturnType<typeof createCommandsStore>;
export function createCommandsStore(root: IRootStore) {
	let controller: AbortController | undefined;
	const extensionPath = `/Users/${solNative.userName()}/.config/bettercast/extensions`;
	const fail = (error: unknown) => {
		void solNative.showToast(String(error), "error");
	};
	const store = makeAutoObservable({
		extensions: [] as ExtensionManifest[],
		extensionError: null as string | null,
		activeRun: null as ScriptRun | null,
		get quicklinks(): Quicklink[] {
			return [
				...root.product.state.quicklinks,
				...root.product.state.imports.customItems
					.filter((item) => item.url)
					.map((item) => ({
						id: item.id,
						name: item.name,
						url: item.url!,
						alias: item.alias,
					})),
			];
		},
		get extraItems(): Item[] {
			return [
				...store.quicklinks.map((link) => ({
					id: link.id,
					name: link.name,
					alias: link.alias,
					icon: "↗",
					subName: link.url.includes("{query}")
						? "Open Quicklinks to enter an argument"
						: "Open quicklink",
					type: ItemType.CUSTOM,
					preventClose: link.url.includes("{query}"),
					callback: () =>
						link.url.includes("{query}")
							? root.ui.focusWidget(Widget.QUICKLINKS)
							: store.openQuicklink(link.id, ""),
				})),
				...root.product.state.imports.snippets.map((snippet) => ({
					id: snippet.id,
					name: snippet.name,
					icon: "✎",
					subName: "Paste imported snippet",
					type: ItemType.CONFIGURATION,
					callback: () =>
						void solNative
							.workspaceRequest({ op: "pasteText", text: snippet.text })
							.catch(fail),
				})),
				...store.extensions
					.filter((extension) => extension.enabled)
					.map((extension) => ({
						id: `extension-${extension.id}`,
						name: extension.title,
						icon: "◇",
						subName: "Run trusted TypeScript extension",
						type: ItemType.USER_SCRIPT,
						preventClose: true,
						callback: () => store.runScript(`extension-${extension.id}`),
					})),
			];
		},
		get commands(): Command[] {
			return root.ui.catalog.map((item) => ({
				id: item.id,
				title: item.name,
				subtitle: item.subName,
				kind: item.id.startsWith("extension-")
					? "extension"
					: item.type === ItemType.USER_SCRIPT
						? "script"
						: item.type === ItemType.APPLICATION
							? "app"
							: store.quicklinks.some((link) => link.id === item.id)
								? "quicklink"
								: item.id.startsWith("snippet-") ||
										root.product.state.imports.snippets.some(
											(s) => s.id === item.id,
										)
									? "snippet"
									: "builtin",
				alias: root.product.state.aliases[item.id] ?? item.alias,
				hotkey: root.ui.shortcuts[item.id],
				aiExposed: root.product.state.aiExposed.includes(item.id),
				sideEffect:
					item.type === ItemType.USER_SCRIPT ? "destructive" : "local",
				confirm: item.type === ItemType.USER_SCRIPT,
				enabled: !root.ui.isItemDisabled(item.id),
			}));
		},
		get conflicts(): HotkeyConflict[] {
			const map = new Map<string, string[]>();
			for (const [id, value] of Object.entries(root.ui.shortcuts)) {
				try {
					const key = canonicalHotkey(value);
					map.set(key, [...(map.get(key) ?? []), id]);
				} catch {}
			}
			return [...map]
				.filter(([, ids]) => ids.length > 1)
				.map(([hotkey, commandIds]) => ({ hotkey, commandIds }));
		},
		setHotkey(
			commandId: string,
			hotkey: string | null,
		): { ok: true } | { ok: false; conflict: HotkeyConflict } {
			if (!hotkey) {
				delete root.ui.shortcuts[commandId];
				solNative.updateHotkeys({ ...root.ui.shortcuts });
				return { ok: true };
			}
			let normalized: string;
			try {
				normalized = canonicalHotkey(hotkey);
			} catch {
				return {
					ok: false,
					conflict: {
						hotkey,
						commandIds: [commandId],
						external: "Invalid shortcut syntax",
					},
				};
			}
			if (["command+space", "option+v", "option+tab"].includes(normalized))
				return {
					ok: false,
					conflict: {
						hotkey: normalized,
						commandIds: [commandId],
						external: "Reserved during coexistence with the existing launcher",
					},
				};
			const other = Object.entries(root.ui.shortcuts).find(
				([id, value]) =>
					id !== commandId &&
					(() => {
						try {
							return canonicalHotkey(value) === normalized;
						} catch {
							return false;
						}
					})(),
			);
			if (other)
				return {
					ok: false,
					conflict: { hotkey: normalized, commandIds: [other[0], commandId] },
				};
			root.ui.shortcuts[commandId] = normalized;
			solNative.updateHotkeys({ ...root.ui.shortcuts });
			return { ok: true };
		},
		setAlias(commandId: string, alias: string | null) {
			void root.product
				.update((state) => {
					if (alias?.trim()) state.aliases[commandId] = alias.trim();
					else delete state.aliases[commandId];
					return state;
				})
				.catch(fail);
		},
		setAIExposed(commandId: string, exposed: boolean) {
			void root.product
				.update((state) => ({
					...state,
					aiExposed: exposed
						? [...new Set([...state.aiExposed, commandId])]
						: state.aiExposed.filter((id) => id !== commandId),
				}))
				.catch(fail);
		},
		saveQuicklink(link: Quicklink) {
			try {
				quicklinkURL(link.url, "test");
				if (!link.name.trim()) return false;
				void root.product
					.update((state) => ({
						...state,
						quicklinks: [
							...state.quicklinks.filter((item) => item.id !== link.id),
							link,
						],
						imports: {
							...state.imports,
							customItems: state.imports.customItems.filter(
								(item) => item.id !== link.id,
							),
						},
					}))
					.catch(fail);
				return true;
			} catch (error) {
				fail(error);
				return false;
			}
		},
		removeQuicklink(id: string) {
			void root.product
				.update((state) => ({
					...state,
					quicklinks: state.quicklinks.filter((link) => link.id !== id),
					imports: {
						...state.imports,
						customItems: state.imports.customItems.filter(
							(item) => item.id !== id,
						),
					},
				}))
				.catch(fail);
			return true;
		},
		openQuicklink(id: string, query: string) {
			const link = store.quicklinks.find((item) => item.id === id);
			if (link) void Linking.openURL(quicklinkURL(link.url, query)).catch(fail);
		},
		runScript(commandId: string) {
			if (store.activeRun?.state === "running") return;
			const extension = store.extensions.find(
				(item) => `extension-${item.id}` === commandId && item.enabled,
			);
			const file = commandId.startsWith("script-") ? commandId.slice(7) : null;
			if (!extension && (!file || file.includes("/") || file.includes("..")))
				return;
			const cwd = extension
				? extensionPath
				: `/Users/${solNative.userName()}/.config/bettercast/scripts`;
			const runtime =
				extension?.runtime ??
				(file!.endsWith(".applescript") ? "/usr/bin/osascript" : "/bin/zsh");
			store.activeRun = {
				id: requestID(),
				commandId,
				runtime,
				args: [
					`${cwd}/${extension?.entry ?? file}`,
					...(extension?.arguments ?? []),
				],
				cwd,
				state: "confirming",
				output: "",
				timeoutMs: 120_000,
			};
			root.ui.focusWidget(Widget.SCRIPT_RUN);
		},
		confirmRun() {
			const run = store.activeRun;
			if (!run || run.state !== "confirming") return;
			run.state = "running";
			run.startedAt = Date.now();
			controller = new AbortController();
			const signal = controller.signal;
			void (async () => {
				try {
					const stream = nativeStream(
						{
							op: "script",
							executable: run.runtime,
							arguments: run.args,
							cwd: run.cwd,
							timeout: run.timeoutMs / 1000,
						},
						signal,
					);
					await stream.headers;
					const decoder = new UTF8StreamDecoder();
					for await (const bytes of stream.iterator)
						runInAction(() => {
							run.output += decoder.decode(bytes);
						});
					runInAction(() => {
						run.state = "done";
						run.exitCode = 0;
					});
				} catch (error) {
					runInAction(() => {
						run.state = signal.aborted
							? "cancelled"
							: String(error).includes("TIMEOUT")
								? "timedOut"
								: "failed";
						run.error = String(error);
					});
				} finally {
					runInAction(() => {
						run.finishedAt = Date.now();
					});
				}
			})();
		},
		cancelRun() {
			controller?.abort();
			if (store.activeRun?.state === "confirming")
				store.activeRun.state = "cancelled";
		},
		reloadExtensions() {
			store.extensionError = null;
			try {
				if (!solNative.exists(extensionPath)) {
					solNative.mkdir(extensionPath);
					return;
				}
				const extensions: ExtensionManifest[] = [];
				for (const file of solNative
					.ls(extensionPath)
					.filter((file) => file.endsWith(".json"))) {
					const raw = solNative.readFile(`${extensionPath}/${file}`);
					if (raw) extensions.push(parseExtension(raw));
				}
				store.extensions = extensions;
			} catch (error) {
				store.extensionError = String(error);
			}
		},
	});
	const contract: CommandsContract = store;
	void contract;
	store.reloadExtensions();
	return store;
}
