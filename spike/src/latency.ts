// Phase 0 · Test 2 — voice-tier latency through the CLI (includes CLI start-up, which the real helper pays too).
// Usage: npm run latency            (3 runs per model)
//        npm run latency -- 5
import { writeFileSync } from "node:fs";
import { runTurn } from "./agent.js";

const RUNS = Number(process.argv[2] ?? 3);
const PROMPTS = [
  "Hey, are you there? Answer without using any tools.",
  "Without using tools, summarise this for a driver: 'Ran git status in tender-tool. 3 files modified, 1 untracked, branch is 2 commits ahead of origin/main.'",
  "Without using tools, summarise in 15 words or fewer: 'Installed 412 npm packages, ran 86 tests, 84 passed, 2 failed in pricing.test.ts.'",
];
const VARIANTS = [
  { label: "haiku-4-5", model: "claude-haiku-4-5", effort: "low" },
  { label: "sonnet-5-5 low", model: "claude-sonnet-5-5", effort: "low" },
  { label: "opus-5-5 low", model: "claude-opus-5-5", effort: "low" },
];

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const out: Record<string, { first: number[]; total: number[]; samples: string[]; errors: number }> = {};

for (const v of VARIANTS) {
  out[v.label] = { first: [], total: [], samples: [], errors: 0 };
  for (let i = 0; i < RUNS; i++) {
    const r = await runTurn(PROMPTS[i % PROMPTS.length], { model: v.model, effort: v.effort, partial: true });
    if (r.isError || r.firstTextMs === undefined) {
      out[v.label].errors++;
      console.log(`${v.label} #${i + 1}: ERROR ${r.text} ${r.stderr ?? ""}`);
      continue;
    }
    out[v.label].first.push(r.firstTextMs);
    out[v.label].total.push(r.durationMs ?? NaN);
    out[v.label].samples.push(r.text);
    console.log(`${v.label} #${i + 1}: first text ${r.firstTextMs.toFixed(0)} ms, total ${(r.durationMs ?? 0).toFixed(0)} ms`);
  }
}

console.log("\n| Model | Median first text | Median total | Errors |\n|---|---|---|---|");
for (const [k, r] of Object.entries(out)) {
  console.log(`| ${k} | ${median(r.first).toFixed(0)} ms | ${median(r.total).toFixed(0)} ms | ${r.errors} |`);
}
console.log("\nSample replies:");
for (const [k, r] of Object.entries(out)) r.samples.forEach((s) => console.log(`  ${k}: ${s}`));
writeFileSync("results/latency.json", JSON.stringify(out, null, 2));
