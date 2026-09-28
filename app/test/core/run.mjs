#!/usr/bin/env node
// Core-logic scenario runner (headless: `native dev --core`, no window, no
// OS effects; the virtual host prints effects instead of performing them).
//
//   node test/core/run.mjs            # every test/core/*.ndjson
//   node test/core/run.mjs calc ai    # just these scenarios
//
// Each <name>.ndjson is a devhost script (Msgs, {"command": ...},
// {"advance": ms}, {"settle": true}, {"restart": true}). <name>.expect lists
// what the transcript must show, one check per line:
//   text      must appear, IN ORDER: searched from the previous match's line
//             (inclusive), or strictly after it when the same text was
//             just checked
//   !text     must not appear anywhere in the transcript
//   -text     must not appear after the previous match
//   # ...     comment
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..", "..");
const wanted = process.argv.slice(2);
const names = fs.readdirSync(here)
  .filter((f) => f.endsWith(".ndjson"))
  .map((f) => f.slice(0, -".ndjson".length))
  .filter((n) => wanted.length === 0 || wanted.includes(n))
  .sort();

let failed = 0;
for (const name of names) {
  const run = spawnSync("native", ["dev", "--core", "--script", path.join(here, `${name}.ndjson`)], {
    cwd: appDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const lines = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.split("\n");
  const problems = [];
  if (run.status !== 0) problems.push(`devhost exited with ${run.status}`);
  const expectFile = path.join(here, `${name}.expect`);
  const checks = fs.existsSync(expectFile) ? fs.readFileSync(expectFile, "utf8").split("\n") : [];
  let at = 0;
  let lastNeedle = "";
  let passedChecks = 0;
  for (const raw of checks) {
    const check = raw.trimEnd();
    if (check.trim().length === 0 || check.startsWith("#")) continue;
    if (check.startsWith("!")) {
      const needle = check.slice(1);
      const hit = lines.findIndex((l) => l.includes(needle));
      if (hit >= 0) problems.push(`unexpected (line ${hit + 1}): ${needle}`);
      else passedChecks += 1;
      continue;
    }
    if (check.startsWith("-")) {
      const needle = check.slice(1);
      const hit = lines.slice(at + 1).findIndex((l) => l.includes(needle));
      if (hit >= 0) problems.push(`unexpected after line ${at + 1} (line ${at + hit + 2}): ${needle}`);
      else passedChecks += 1;
      continue;
    }
    const from = check === lastNeedle ? at + 1 : at;
    const hit = lines.slice(from).findIndex((l) => l.includes(check));
    if (hit < 0) {
      problems.push(`missing from line ${from + 1}: ${check}`);
      break;
    }
    at = from + hit;
    lastNeedle = check;
    passedChecks += 1;
  }
  if (lines.some((l) => l.includes("Error:") || l.includes("TypeError") || l.includes("exited abnormally"))) {
    problems.push("the devhost reported an error:\n    " + lines.filter((l) => l.includes("Error") || l.includes("abnormally")).slice(0, 5).join("\n    "));
  }
  if (problems.length === 0) {
    console.log(`PASS ${name} (${passedChecks} checks)`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}`);
    for (const p of problems) console.log(`  ${p}`);
    const out = path.join(process.env.TMPDIR ?? "/tmp", `bettercast-core-${name}.transcript`);
    fs.writeFileSync(out, lines.join("\n"));
    console.log(`  transcript: ${out}`);
  }
}
console.log(failed === 0 ? `all ${names.length} scenarios passed` : `${failed} of ${names.length} scenarios failed`);
process.exit(failed === 0 ? 0 : 1);
