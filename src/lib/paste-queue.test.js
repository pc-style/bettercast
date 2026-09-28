import { test, expect } from "bun:test";
import {
	startQueue,
	advanceQueue,
	nextQueueItem,
	restoreQueue,
} from "./paste-queue";
const items = ["first-text", "second-image", "third-file"].map((id) => ({
	id,
	preview: id,
}));
test("queue snapshots survive copies and reverse order without changing the original", () => {
	let queue = startQueue(items);
	items.push({ id: "new-copy" });
	expect(queue.items.map((x) => x.id)).toEqual([
		"first-text",
		"second-image",
		"third-file",
	]);
	queue = advanceQueue(queue, { status: "dispatched" });
	expect(nextQueueItem(queue).id).toBe("second-image");
	const reversed = { ...queue, reversed: true, position: 0 };
	expect(nextQueueItem(reversed).id).toBe("third-file");
	expect(nextQueueItem(advanceQueue(reversed)).id).toBe("second-image");
});
test("failed delivery does not advance and restart interrupts rather than auto-retrying", () => {
	const queue = startQueue(items.slice(0, 3));
	const failed = advanceQueue(queue, {
		status: "focusChanged",
		message: "Destination changed",
	});
	expect(failed.position).toBe(0);
	expect(failed.state.status).toBe("interrupted");
	expect(
		restoreQueue(advanceQueue(queue, { status: "dispatched" })).state.status,
	).toBe("interrupted");
	expect(
		restoreQueue({ ...queue, position: 3, state: { status: "finished" } }).state
			.status,
	).toBe("finished");
	expect(() => restoreQueue({ ...queue, position: -1 })).toThrow();
});
