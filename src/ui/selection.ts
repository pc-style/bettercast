// Keyboard list selection. Pure so it can be reasoned about and tested without React.

export function moveSelection(
	index: number,
	delta: number,
	length: number,
): number {
	if (length <= 0) return 0;
	return Math.min(length - 1, Math.max(0, index + delta));
}

/** Keep a selection valid after the list changes (e.g. deletion, new page, filter). */
export function clampSelection(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.min(length - 1, Math.max(0, index));
}

/** Request the next page once the selection is within `threshold` rows of the end. */
export function shouldLoadMore(
	index: number,
	length: number,
	hasMore: boolean,
	loading: boolean,
	threshold = 8,
): boolean {
	return hasMore && !loading && length > 0 && index >= length - threshold;
}

/** Toggle membership while preserving the order items were marked in. */
export function toggleOrdered(ids: readonly string[], id: string): string[] {
	return ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
}
