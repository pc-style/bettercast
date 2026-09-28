// macOS virtual key codes delivered by the native keyDown bridge.
export const KEY = {
	ENTER: 36,
	ESC: 53,
	TAB: 48,
	SPACE: 49,
	DELETE: 51,
	LEFT: 123,
	RIGHT: 124,
	DOWN: 125,
	UP: 126,
	A: 0,
	X: 7,
	T: 17,
	Y: 16,
	W: 13,
	I: 34,
	H: 4,
	D: 2,
	BACKSLASH: 42,
	COMMA: 43,
	S: 1,
	C: 8,
	V: 9,
	E: 14,
	R: 15,
	O: 31,
	P: 35,
	L: 37,
	J: 38,
	K: 40,
	N: 45,
	PERIOD: 47,
	ONE: 18,
	TWO: 19,
	THREE: 20,
	FOUR: 21,
	FIVE: 23,
	SIX: 22,
} as const;

/** ⌘1…⌘6 → 0…5 (undefined for other keys). */
export function digitIndex(keyCode: number): number | undefined {
	const order = [KEY.ONE, KEY.TWO, KEY.THREE, KEY.FOUR, KEY.FIVE, KEY.SIX];
	const index = order.indexOf(keyCode as (typeof order)[number]);
	return index < 0 ? undefined : index;
}

export type KeyEvent = {
	keyCode: number;
	meta: boolean;
	shift: boolean;
	control?: boolean;
};

/** Return true when the key was handled; routing stops at the first handler that handles it. */
export type KeyHandler = (event: KeyEvent) => boolean;
