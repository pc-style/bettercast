import { makeAutoObservable, runInAction } from "mobx";
import type { IRootStore } from "../store";
import type {
	MigrationContract,
	ImportPreview,
	ImportReport,
} from "../contracts/migration";
import {
	applyRaycastImport,
	parseRaycastImport,
	planRaycastImport,
	rollbackRaycastImport,
	type ImportPreview as ParsedPreview,
} from "../lib/raycast-import";

export type MigrationStore = ReturnType<typeof createMigrationStore>;
export function createMigrationStore(root: IRootStore) {
	let parsed: ParsedPreview | null = null;
	const mappings = () => ({
		commandIds: Object.fromEntries(
			root.commands.commands.map((command) => [command.id, command.id]),
		),
		settings: {},
	});
	const store = makeAutoObservable({
		current: null as ImportPreview | null,
		previewError: null as string | null,
		applying: false,
		report: null as ImportReport | null,
		preview(raw: string) {
			store.previewError = null;
			try {
				if (!root.product.loaded)
					throw new Error(
						root.product.error ?? "Product storage is still loading",
					);
				parsed = parseRaycastImport(raw);
				const planned = planRaycastImport(
					parsed,
					root.product.state.imports,
					parsed.entries.map((entry) => entry.id),
					mappings(),
				);
				store.current = {
					source: "raycast",
					sourceLabel: "Selected readable JSON",
					warnings: [
						...planned.preview.warnings,
						"Nothing is selected automatically. Bindings remain disabled. Encrypted Raycast archives and private history are not read.",
					],
					entries: planned.preview.entries.map((entry) => ({
						id: entry.id,
						kind:
							entry.kind === "shortcut"
								? "hotkey"
								: entry.kind === "history"
									? "other"
									: entry.kind,
						name: entry.name,
						outcome: entry.status,
						reason: entry.reason,
						detail:
							entry.kind === "quicklink"
								? String((entry.data as any).link)
								: entry.kind === "snippet"
									? String((entry.data as any).text).slice(0, 200)
									: entry.reason,
						selected: false,
					})),
				};
			} catch (error) {
				store.current = null;
				parsed = null;
				store.previewError = String(error);
			}
		},
		select(id: string, selected: boolean) {
			const entry = store.current?.entries.find((item) => item.id === id);
			if (entry?.outcome === "import") entry.selected = selected;
		},
		async apply(): Promise<ImportReport> {
			if (!parsed || !store.current || store.applying)
				throw new Error("Preview an export first");
			const source = parsed;
			const selected = store.current.entries
				.filter((entry) => entry.selected && entry.outcome === "import")
				.map((entry) => entry.id);
			store.applying = true;
			try {
				let imported = 0;
				await root.product.update((current) => {
					const plan = planRaycastImport(
						source,
						current.imports,
						selected,
						mappings(),
					);
					const result = applyRaycastImport(plan, current.imports);
					imported = result.receipt.applied.length;
					return { ...current, imports: result.state, receipt: result.receipt };
				});
				const report: ImportReport = {
					appliedAt: Date.now(),
					imported,
					skipped: source.entries.length - imported,
					failed: [],
					canRollback: imported > 0,
				};
				runInAction(() => {
					store.report = report;
				});
				return report;
			} catch (error) {
				runInAction(() => {
					store.previewError = String(error);
				});
				throw error;
			} finally {
				runInAction(() => {
					store.applying = false;
				});
			}
		},
		async rollback() {
			store.applying = true;
			try {
				await root.product.update((current) => {
					if (!current.receipt) throw new Error("No saved import receipt");
					const result = rollbackRaycastImport(
						current.receipt,
						current.imports,
					);
					if (result.receipt.skipped.length)
						throw new Error(
							"Imported records were edited. Rollback refused to overwrite those edits.",
						);
					return { ...current, imports: result.state, receipt: undefined };
				});
				runInAction(() => {
					if (store.report) store.report.canRollback = false;
				});
			} catch (error) {
				runInAction(() => {
					store.previewError = String(error);
				});
				throw error;
			} finally {
				runInAction(() => {
					store.applying = false;
				});
			}
		},
	});
	const contract: MigrationContract = store;
	void contract;
	return store;
}
