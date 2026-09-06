// Save stills of a fixture play as SVG, for review without a browser.
//
//   bun scripts/snapshot.ts fixtures/plays/00-showcase.json 1.9 5.3 7.8 9.8
//   bun scripts/snapshot.ts fixtures/plays/01-hold.json --every 0.5
//
// Output goes to out/<play-id>/<seconds>.svg (override with --out DIR).

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Evaluator } from "../src/engine/evaluate";
import { resolvePuppet, type ResolvedPuppet } from "../src/model/puppet";
import { PlaySchema, formatIssues } from "../src/model/types";
import { frameToSvg } from "../src/render/snapshot";

const args = process.argv.slice(2);
const file = args.shift();
if (!file) {
  console.error("usage: bun scripts/snapshot.ts <play.json> [seconds...] [--every S] [--out DIR] [--no-rods]");
  process.exit(2);
}
let every: number | null = null;
let outDir: string | null = null;
let rods = true;
const times: number[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--every") every = Number(args[++i]);
  else if (a === "--out") outDir = args[++i];
  else if (a === "--no-rods") rods = false;
  else times.push(Number(a));
}

const raw = JSON.parse(await Bun.file(file).text());
const fixturesDir = path.resolve(path.dirname(file), "..");
for (const [id, v] of Object.entries(raw.cast ?? {})) {
  if (typeof v === "string") {
    const p = JSON.parse(await Bun.file(path.join(fixturesDir, v)).text());
    p.id = id;
    raw.cast[id] = p;
  }
}
const parsed = PlaySchema.safeParse(raw);
if (!parsed.success) {
  console.error(formatIssues(parsed.error).join("\n"));
  process.exit(1);
}
const play = parsed.data;
const puppets = new Map<string, ResolvedPuppet>();
for (const [id, p] of Object.entries(play.cast)) puppets.set(id, resolvePuppet({ ...p, id }));
const ev = new Evaluator(play, puppets);

if (every) for (let t = 0; t <= ev.durationSeconds + 1e-9; t += every) times.push(Number(t.toFixed(3)));
if (times.length === 0) times.push(0, ev.durationSeconds / 2, ev.durationSeconds);

const dir = outDir ?? path.join("out", play.id);
await mkdir(dir, { recursive: true });
for (const t of times.sort((a, b) => a - b)) {
  const svg = frameToSvg(ev.frame(Math.min(t, ev.durationSeconds)), { rods });
  const name = path.join(dir, `${t.toFixed(2).replace(".", "_")}s.svg`);
  await Bun.write(name, svg);
  console.log(name);
}
