import { expect, test } from "bun:test";
import { createCaptureStack, DEFAULT_CAPTURE } from "./capture-stack";

test("overlay capture restores the widget capture underneath, then defaults", () => {
	const applied = [];
	const stack = createCaptureStack(c => applied.push(c));
	const composer = { enter: false, vertical: false, horizontal: false };
	const panel = { enter: true, vertical: true, horizontal: false };
	const popComposer = stack.push(composer);
	const popPanel = stack.push(panel);
	popPanel();
	expect(applied.at(-1)).toEqual(composer);
	popComposer();
	expect(applied.at(-1)).toEqual(DEFAULT_CAPTURE);
});

test("out-of-order unmount keeps the newest remaining entry applied", () => {
	const applied = [];
	const stack = createCaptureStack(c => applied.push(c));
	const a = { enter: false, vertical: true, horizontal: false };
	const b = { enter: true, vertical: false, horizontal: true };
	const popA = stack.push(a);
	const popB = stack.push(b);
	popA(); // widget unmounts before its overlay's cleanup runs
	expect(stack.current()).toEqual(b);
	popB();
	popB(); // double pop is harmless
	expect(stack.current()).toEqual(DEFAULT_CAPTURE);
});
