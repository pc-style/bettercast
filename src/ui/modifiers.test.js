import { expect, test } from "bun:test";
import { NO_MODIFIERS, nextModifiers } from "./modifiers";

test("ordinary key resyncs a modifier whose keyUp was missed while hidden", () => {
	const stuck = { ...NO_MODIFIERS, shiftPressed: true, controlPressed: true };
	expect(
		nextModifiers(stuck, { keyCode: 51, meta: false, shift: false, control: false }, "down"),
	).toEqual(NO_MODIFIERS);
});

test("missing flags on ordinary keys read as released", () => {
	expect(nextModifiers({ ...NO_MODIFIERS, commandPressed: true }, { keyCode: 36 }, "down")).toEqual(
		NO_MODIFIERS,
	);
});

test("modifier-only events ignore stale flags for other modifiers", () => {
	const commandHeld = { ...NO_MODIFIERS, commandPressed: true };
	// native flagsChanged sends shift with meta:false even while ⌘ is held
	expect(nextModifiers(commandHeld, { keyCode: 60, meta: false, shift: true }, "down")).toEqual({
		...commandHeld,
		shiftPressed: true,
	});
	expect(nextModifiers(commandHeld, { keyCode: 55, meta: false }, "up")).toEqual(NO_MODIFIERS);
});

test("hyper chord on an ordinary key reports all held modifiers", () => {
	expect(
		nextModifiers(NO_MODIFIERS, { keyCode: 40, meta: true, shift: true, control: true }, "down"),
	).toEqual({ commandPressed: true, shiftPressed: true, controlPressed: true });
});
