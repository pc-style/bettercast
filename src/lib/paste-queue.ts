import type {
	ClipItem,
	DeliveryResult,
	QueueState,
} from "../contracts/clipboard";

export const emptyQueue = (): QueueState => ({
	items: [],
	position: 0,
	reversed: false,
	state: { status: "idle" },
});
export function startQueue(items: ClipItem[]): QueueState {
	if (!items.length || items.length > 200)
		throw new Error("Select between 1 and 200 items");
	return {
		items: items.map((item) => ({ ...item })),
		position: 0,
		reversed: false,
		state: { status: "running" },
	};
}
export function nextQueueItem(queue: QueueState): ClipItem | undefined {
	return queue.items[
		queue.reversed ? queue.items.length - 1 - queue.position : queue.position
	];
}
export function advanceQueue(
	queue: QueueState,
	result?: DeliveryResult,
): QueueState {
	if (result && result.status !== "dispatched")
		return {
			...queue,
			lastResult: result,
			state: {
				status: "interrupted",
				reason:
					"message" in result ? result.message : "Paste was not dispatched",
			},
		};
	const position = Math.min(queue.position + 1, queue.items.length);
	return {
		...queue,
		position,
		lastResult: result,
		state: { status: position === queue.items.length ? "finished" : "running" },
	};
}
export function restoreQueue(raw: unknown): QueueState {
	if (!raw || typeof raw !== "object" || !("items" in raw)) return emptyQueue();
	const queue = raw as QueueState;
	if (
		!Array.isArray(queue.items) ||
		queue.items.length > 200 ||
		!queue.items.every((item) => typeof item.id === "string") ||
		!Number.isInteger(queue.position) ||
		queue.position < 0 ||
		queue.position > queue.items.length
	)
		throw new Error("Saved queue is corrupt");
	// Never resume a potentially dispatched paste after a crash/restart without a decision.
	return {
		...queue,
		state:
			queue.state.status === "idle" || queue.state.status === "finished"
				? queue.state
				: {
						status: "interrupted",
						reason:
							"Restored after restart. Check the destination before resuming or skipping; the last paste may already have arrived.",
					},
	};
}
