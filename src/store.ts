import { createContext, useContext } from "react";
import { type CalendarStore, createCalendarStore } from "stores/calendar.store";
import {
	type ClipboardStore,
	createClipboardStore,
} from "stores/clipboard.store";
import {
	createKeystrokeStore,
	type KeystrokeStore,
} from "stores/keystroke.store";
import { createUIStore, type UIStore } from "./stores/ui.store";
import {
	type ProcessesStore,
	createProcessesStore,
} from "stores/processes.store";
import { type EmojiStore, createEmojiStore } from "stores/emoji.store";
import { type ScriptsStore, createScriptsStore } from "stores/scripts.store";
import { type SnippetsStore, createSnippetsStore } from "stores/snippets.store";
import {createProductStore,type ProductStore} from './stores/product.store';
import {createCommandsStore,type CommandsStore} from './stores/commands.store';
import {createMigrationStore,type MigrationStore} from './stores/migration.store';
import {createAIStore,type AIStore} from './stores/ai.store';
import {createMcpStore,type McpStore} from './stores/mcp.store';

export interface IRootStore {
	ui: UIStore;
	clipboard: ClipboardStore;
	keystroke: KeystrokeStore;
	calendar: CalendarStore;
	processes: ProcessesStore;
	emoji: EmojiStore;
	scripts: ScriptsStore;
	snippets: SnippetsStore;
	product: ProductStore;
	commands: CommandsStore;
	migration: MigrationStore;
	ai: AIStore;
	mcp: McpStore;
	cleanUp: () => void;
}

const createRootStore = (): IRootStore => {
	const store: any = {};

	store.product = createProductStore();
	store.ui = createUIStore(store);
	store.clipboard = createClipboardStore(store);
	store.keystroke = createKeystrokeStore(store);
	store.calendar = createCalendarStore(store);
	store.processes = createProcessesStore(store);
	store.scripts = createScriptsStore(store);
	store.snippets = createSnippetsStore(store);
	store.emoji = createEmojiStore(store);
	store.commands = createCommandsStore(store);
	store.migration = createMigrationStore(store);
	store.mcp = createMcpStore(store);
	store.ai = createAIStore(store);
	(store as IRootStore).cleanUp = () => {
		store.ui.cleanUp();
		store.calendar.cleanUp();
		store.keystroke.cleanUp();
		store.clipboard.cleanUp();
		store.mcp.stopAll();
		store.commands.cancelRun();
	};

	return store;
};

export const root = createRootStore();

// @ts-expect-error hot is RN
module.hot?.dispose(() => {
	root.cleanUp();
});

export const StoreContext = createContext<IRootStore>(root);
export const StoreProvider = StoreContext.Provider;
export const useStore = () => useContext(StoreContext);
