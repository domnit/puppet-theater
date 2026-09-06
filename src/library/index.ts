// Server-side loader for the curated library — reads library/puppets/*.json
// and library/parts/*.json into the shapes src/doc/library.ts's
// `ImportSources` wants, validating along the way. Not browser-safe
// (node:fs); this is what scripts/seed.ts and the server's tool context use
// to build the resolver and the list_plays index.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { LibraryPart, LibraryPuppet } from "../doc/library";
import { formatIssues, PartSchema, PuppetSchema } from "../model/types";

const PartFileSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  unit: z.number().positive(),
  note: z.string(),
  parts: z.array(PartSchema).min(1).max(64),
});

export function loadLibrary(dir = "library"): { puppets: LibraryPuppet[]; parts: LibraryPart[] } {
  return { puppets: loadPuppets(join(dir, "puppets")), parts: loadParts(join(dir, "parts")) };
}

function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return []; // tolerate a missing directory, so an empty library is fine
  }
}

function loadPuppets(dir: string): LibraryPuppet[] {
  const out: LibraryPuppet[] = [];
  for (const file of jsonFiles(dir)) {
    const stem = basename(file, ".json");
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const version = raw.version;
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`library/puppets/${file}: 'version' must be an integer >= 1`);
    }
    const { version: _drop, ...rest } = raw;
    const parsed = PuppetSchema.safeParse(rest);
    if (!parsed.success) throw new Error(`library/puppets/${file}: ${formatIssues(parsed.error).join("; ")}`);
    if (parsed.data.id !== stem) throw new Error(`library/puppets/${file}: id '${parsed.data.id}' must match the filename`);
    out.push({ id: parsed.data.id, version, puppet: parsed.data });
  }
  return out;
}

function loadParts(dir: string): LibraryPart[] {
  const out: LibraryPart[] = [];
  for (const file of jsonFiles(dir)) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const parsed = PartFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`library/parts/${file}: ${formatIssues(parsed.error).join("; ")}`);
    if (parsed.data.parts[0].parent !== null) {
      throw new Error(`library/parts/${file}: parts[0].parent must be null (the subtree root)`);
    }
    out.push(parsed.data);
  }
  return out;
}
