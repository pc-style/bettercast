// Native key capture is global state (which keys the panel swallows and forwards to JS).
// Widgets and overlays push the capture they need; the newest entry applies, and
// popping restores whatever is underneath, so an overlay can't leave a widget broken.

export type Capture = { enter: boolean; vertical: boolean; horizontal: boolean };

export const DEFAULT_CAPTURE: Capture = { enter: true, vertical: true, horizontal: false };

export function createCaptureStack(apply: (capture: Capture) => void) {
	const entries: { id: number; capture: Capture }[] = [];
	let nextId = 1;
	const top = () => entries[entries.length - 1]?.capture ?? DEFAULT_CAPTURE;
	return {
		push(capture: Capture): () => void {
			const id = nextId++;
			entries.push({ id, capture });
			apply(top());
			return () => {
				const index = entries.findIndex(e => e.id === id);
				if (index < 0) return;
				entries.splice(index, 1);
				apply(top());
			};
		},
		current: top,
	};
}
