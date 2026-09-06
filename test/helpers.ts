// Shared fixture loading for the test suite: mirrors what the harness and
// scripts/snapshot.ts do — embed cast entries given as paths, validate, resolve.

import path from "node:path";
import { Evaluator } from "../src/engine/evaluate";
import { resolvePuppet, type ResolvedPuppet } from "../src/model/puppet";
import { PlaySchema, PuppetSchema, formatIssues, type Play, type Puppet } from "../src/model/types";

const root = path.resolve(import.meta.dir, "..");

export const playFiles = [
  "00-showcase", "01-hold", "02-limb", "03-planes", "04-lantern", "05-mirror", "06-bridge",
].map((n) => `fixtures/plays/${n}.json`);

export async function loadPlay(file: string): Promise<Play> {
  const raw = JSON.parse(await Bun.file(path.join(root, file)).text());
  for (const [id, v] of Object.entries(raw.cast ?? {})) {
    if (typeof v === "string") {
      const p = JSON.parse(await Bun.file(path.join(root, "fixtures", v)).text());
      p.id = id;
      raw.cast[id] = p;
    }
  }
  const parsed = PlaySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${formatIssues(parsed.error).join("; ")}`);
  return parsed.data;
}

export function evaluatorFor(play: Play): Evaluator {
  const puppets = new Map<string, ResolvedPuppet>();
  for (const [id, p] of Object.entries(play.cast)) puppets.set(id, resolvePuppet({ ...p, id }));
  return new Evaluator(play, puppets);
}

/** A minimal valid puppet, for structural tests. `parts` is merged in. */
export function puppetDoc(parts: unknown[], extra: Record<string, unknown> = {}): Puppet {
  return PuppetSchema.parse({ id: "t", unit: 100, cap: 2, parts, ...extra });
}

export const BOX = "M-5,0 L5,0 L5,20 L-5,20 Z";
