import { solNative } from "lib/SolNative";
import {
	advanceQueue,
	emptyQueue,
	nextQueueItem,
	restoreQueue,
	startQueue,
} from "lib/paste-queue";
import { makeAutoObservable, reaction, runInAction, toJS } from "mobx";
import type { IRootStore } from "store";
import type {
	CaptureState,
	ClipboardConfig,
	ClipboardContract,
	ClipAction,
	ClipPage,
	ClipQuery,
	DeliveryResult,
	QueueState,
	RetentionStatus,
} from "../contracts/clipboard";
import { Widget } from "./ui.store";

export type PasteItem = {
	id: string;
	text: string;
	url?: string;
	bundle?: string;
	datetime: number;
};
export type ClipboardStore = ReturnType<typeof createClipboardStore>;

export function createClipboardStore(root: IRootStore) {
	let version = 0,
		queueBusy = false,
		alive = true;
	const request = (op: string, data: object = {}) =>
		solNative.clipboardRequest({ op, ...data });
	const updateStatus = (status: any) =>
		runInAction(() => {
			store.config = {
				retentionDays: status.config.retentionDays,
				capBytes: status.config.capBytes,
				excludedBundleIds: status.config.excludedBundleIds,
				skipSensitive: status.config.skipSensitive,
			};
			store.capture = status.capture;
			store.retention = status.retention;
		});
	const persistQueue = async (queue: QueueState) => {
		await request("queue", {
			queue: { ...toJS(queue), itemIds: queue.items.map((item) => item.id) },
		});
		runInAction(() => {
			store.queue = queue;
		});
	};
	const changeQueue = (change: (queue: QueueState) => QueueState) => {
		if (queueBusy) return;
		queueBusy = true;
		void persistQueue(change(toJS(store.queue)))
			.catch((error) =>
				runInAction(() => {
					store.loadError = String(error);
				}),
			)
			.finally(() => {
				queueBusy = false;
			});
	};
	const store = makeAutoObservable({
		query: { text: "", kinds: [] } as ClipQuery,
		page: { items: [], hasMore: false } as ClipPage,
		loading: false,
		loadError: null as string | null,
		capture: { status: "paused" } as CaptureState,
		config: {
			retentionDays: 30,
			capBytes: 1_073_741_824,
			excludedBundleIds: [],
			skipSensitive: true,
		} as ClipboardConfig,
		retention: null as RetentionStatus | null,
		queue: emptyQueue(),
		get items(): PasteItem[] {
			return store.page.items.map((item) => ({
				id: item.id,
				text: item.preview,
				url: item.thumbnailPath ?? item.path,
				bundle: item.sourceApp?.bundleId,
				datetime: item.copiedAt,
			}));
		},
		get clipboardItems(): PasteItem[] {
			return store.items;
		},
		get saveHistory(): boolean {
			return store.capture.status === "capturing";
		},
		async load(query: ClipQuery) {
			const current = ++version;
			store.query = query;
			store.loading = true;
			store.loadError = null;
			try {
				const page = await request("query", { query: toJS(query), offset: 0 });
				const status = await request("status");
				if (!alive || current !== version) return;
				runInAction(() => {
					store.page = page;
				});
				updateStatus(status);
			} catch (error) {
				if (current === version)
					runInAction(() => {
						store.loadError = String(error);
					});
			} finally {
				if (current === version)
					runInAction(() => {
						store.loading = false;
					});
			}
		},
		async loadMore() {
			if (store.loading || !store.page.hasMore) return;
			const current = version;
			store.loading = true;
			try {
				const page = await request("query", {
					query: toJS(store.query),
					offset: store.page.items.length,
				});
				if (current === version)
					runInAction(() => {
						store.page = {
							items: [...store.page.items, ...page.items].filter(
								(item, index, all) =>
									all.findIndex((x) => x.id === item.id) === index,
							),
							hasMore: page.hasMore,
						};
					});
			} catch (error) {
				runInAction(() => {
					store.loadError = String(error);
				});
			} finally {
				runInAction(() => {
					store.loading = false;
				});
			}
		},
		async act(id: string, action: ClipAction): Promise<DeliveryResult> {
			try {
				const result = await request("action", { id, action });
				if (["delete", "pin", "unpin"].includes(action))
					await store.load(store.query);
				if (
					action === "delete" &&
					store.queue.items.some((item) => item.id === id)
				)
					changeQueue((queue) => ({
						...queue,
						state: {
							status: "interrupted",
							reason:
								"A queued item was deleted. Skip it or create a new queue.",
						},
					}));
				return result;
			} catch (error) {
				return { status: "failed", message: String(error) };
			}
		},
		async configure(partial: Partial<ClipboardConfig>) {
			updateStatus(await request("configure", { config: partial }));
		},
		pauseCapture(durationMs?: number) {
			void request("configure", {
				config: {
					paused: true,
					pauseUntil: durationMs ? Date.now() + durationMs : 0,
				},
			})
				.then(updateStatus)
				.catch((error) =>
					runInAction(() => {
						store.loadError = String(error);
					}),
				);
		},
		resumeCapture() {
			root.ui.confirm(
				"Enable clipboard capture? Payloads and search index are owner-only local files, not app-encrypted. FileVault is recommended. No history is imported.",
				() => {
					void request("configure", {
						config: { enabled: true, paused: false, pauseUntil: 0 },
					})
						.then(updateStatus)
						.catch((error) =>
							runInAction(() => {
								store.loadError = String(error);
							}),
						);
				},
			);
		},
		setPrivateMode(on: boolean) {
			void request("configure", { config: { private: on } })
				.then(updateStatus)
				.catch((error) =>
					runInAction(() => {
						store.loadError = String(error);
					}),
				);
		},
		async clearAll() {
			await request("clear");
			store.queue = emptyQueue();
			await store.load(store.query);
		},
		setSaveHistory(value: boolean) {
			value ? store.resumeCapture() : store.pauseCapture();
		},
		deleteItem(index: number) {
			const item = store.items[index];
			if (item) void store.act(item.id, "delete");
		},
		deleteAllItems() {
			void store.clearAll();
		},
		popToTop(_index: number) {
			/* Copy occurrences are immutable; pasting does not recapture. */
		},
		queueStart(ids: string[]) {
			const items = ids.map(
				(id) =>
					store.page.items.find((item) => item.id === id) ??
					store.queue.items.find((item) => item.id === id),
			);
			if (items.some((item) => !item)) {
				store.loadError =
					"An item is no longer available. Refresh before queuing.";
				return;
			}
			changeQueue(() =>
				startQueue(items as NonNullable<(typeof items)[number]>[]),
			);
		},
		async queueNext(): Promise<DeliveryResult> {
			if (queueBusy || store.queue.state.status !== "running")
				return {
					status: "failed",
					message: "Resume the queue before pasting.",
				};
			const item = nextQueueItem(store.queue);
			if (!item) return { status: "failed", message: "Queue is finished." };
			queueBusy = true;
			const before = toJS(store.queue);
			try {
				// Durable uncertainty before dispatch: a crash cannot cause silent duplicate paste.
				await persistQueue({
					...before,
					state: {
						status: "interrupted",
						reason: "Paste in flight; check destination before retrying.",
					},
				});
				const result = await store.act(item.id, "paste");
				await persistQueue(advanceQueue(before, result));
				return result;
			} catch (error) {
				return {
					status: "failed",
					message: `Queue persistence failed. Check destination before retrying. ${String(error)}`,
				};
			} finally {
				queueBusy = false;
			}
		},
		queueSkip() {
			changeQueue((queue) => advanceQueue(queue));
		},
		queuePause() {
			changeQueue((queue) => ({ ...queue, state: { status: "paused" } }));
		},
		queueResume() {
			changeQueue((queue) => ({
				...queue,
				state: {
					status: queue.position >= queue.items.length ? "finished" : "running",
				},
			}));
		},
		queueReverse() {
			changeQueue((queue) => ({
				...queue,
				reversed: !queue.reversed,
				position: 0,
				state: { status: "paused" },
			}));
		},
		queueRestart() {
			changeQueue((queue) => ({
				...queue,
				position: 0,
				state: { status: "paused" },
			}));
		},
		queueCancel() {
			changeQueue(() => emptyQueue());
		},
		cleanUp() {
			alive = false;
			version++;
			listener.remove();
			dispose();
		},
	});
	const checked: ClipboardContract = store;
	void checked;
	const listener = solNative.addListener("clipboardChanged", () => {
		if (root.ui.focusedWidget === Widget.CLIPBOARD)
			void store.load(store.query);
	});
	const dispose = reaction(
		() => [root.ui.focusedWidget, root.ui.query],
		() => {
			if (root.ui.focusedWidget === Widget.CLIPBOARD)
				void store.load({ ...store.query, text: root.ui.query });
		},
	);
	void request("status")
		.then((status) => {
			if (!alive) return;
			updateStatus(status);
			runInAction(() => {
				store.queue = restoreQueue(status.queue);
			});
		})
		.catch((error) =>
			runInAction(() => {
				store.loadError = String(error);
				store.capture = {
					status: "unavailable",
					reason: "Native clipboard repository could not open.",
				};
			}),
		);
	return store;
}
