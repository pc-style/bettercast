import { makeAutoObservable, runInAction, toJS } from "mobx";
import { solNative } from "../lib/SolNative";
import type { ImportReceipt, ImportState } from "../lib/raycast-import";
import type { Quicklink } from "../contracts/commands";

export type ProductState = {
	version: 1;
	imports: ImportState;
	receipt?: ImportReceipt;
	quicklinks: Quicklink[];
	aliases: Record<string, string>;
	aiExposed: string[];
};
export const emptyProductState = (): ProductState => ({
	version: 1,
	imports: { customItems: [], snippets: [], settings: {}, stagedBindings: [] },
	quicklinks: [],
	aliases: {},
	aiExposed: [],
});
export type ProductStore = ReturnType<typeof createProductStore>;
export function createProductStore() {
	let writes = Promise.resolve();
	const store = makeAutoObservable({
		state: emptyProductState(),
		loaded: false,
		error: null as string | null,
		async initialize() {
			try {
				const raw = await solNative.workspaceRequest({
					op: "readDocument",
					id: "product",
				});
				const state = raw ? JSON.parse(raw) : emptyProductState();
				if (
					state.version !== 1 ||
					!Array.isArray(state.quicklinks) ||
					!Array.isArray(state.imports?.snippets)
				)
					throw new Error(
						"Unsupported or corrupt product state; original is preserved",
					);
				runInAction(() => {
					store.state = state;
					store.loaded = true;
				});
			} catch (error) {
				runInAction(() => {
					store.error = String(error);
				});
			}
		},
		async update(change: (current: ProductState) => ProductState) {
			const operation = writes.then(async () => {
				if (!store.loaded)
					throw new Error(store.error ?? "Product storage is loading");
				const next = change(toJS(store.state));
				await solNative.workspaceRequest({
					op: "writeDocument",
					id: "product",
					value: JSON.stringify(next),
				});
				runInAction(() => {
					store.state = next;
					store.error = null;
				});
			});
			writes = operation.catch((error) => {
				runInAction(() => {
					store.error = String(error);
				});
			});
			return operation;
		},
	});
	void store.initialize();
	return store;
}
