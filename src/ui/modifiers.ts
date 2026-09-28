// Modifier state recovery. Native only delivers flagsChanged while the panel is key,
// so a modifier released after the panel hides (e.g. a Hyper chord) would otherwise
// stay "pressed" forever and turn ⌫ into delete or j/k into navigation.
//
// Ordinary key events carry accurate modifier flags, so they fully resync state.
// Modifier-only events (flagsChanged) carry stale flags for the *other* modifiers
// in the native bridge, so they only update their own modifier.

export type Modifiers = {
	commandPressed: boolean;
	shiftPressed: boolean;
	controlPressed: boolean;
};

export const NO_MODIFIERS: Modifiers = {
	commandPressed: false,
	shiftPressed: false,
	controlPressed: false,
};

export type NativeKeyEvent = {
	keyCode: number;
	meta?: boolean;
	shift?: boolean;
	control?: boolean;
};

const MODIFIER_KEYS: Record<number, keyof Modifiers> = {
	55: "commandPressed",
	60: "shiftPressed",
	59: "controlPressed",
};

export function nextModifiers(
	previous: Modifiers,
	event: NativeKeyEvent,
	phase: "down" | "up",
): Modifiers {
	const own = MODIFIER_KEYS[event.keyCode];
	if (own) return { ...previous, [own]: phase === "down" };
	return {
		commandPressed: event.meta === true,
		shiftPressed: event.shift === true,
		controlPressed: event.control === true,
	};
}
