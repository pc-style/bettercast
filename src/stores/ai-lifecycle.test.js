import { expect, test } from "bun:test";
test("AI store and native stream lifecycle (isolated synthetic bridge)", () => {
	const run = Bun.spawnSync(
		[process.execPath, "test", "./scripts/test-ai-lifecycle.js"],
		{ cwd: process.cwd() },
	);
	if (run.exitCode !== 0) console.error(new TextDecoder().decode(run.stderr));
	expect(run.exitCode).toBe(0);
});
