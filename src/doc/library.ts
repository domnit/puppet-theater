// Import sources for `{ op: "import" }` edits — spec §1.9. Copy, never
// reference: a puppet or part subtree is embedded as a full copy, rescaled by
// the ratio of the two puppets' `unit`, with `from` set to the resolved
// source ref (never resolved again at render time). Browser-safe and pure:
// no bun/node imports, only src/model.

import { mapPath, parsePath, serializePath } from "../model/path";
import type { Part, Play, Puppet, Vec } from "../model/types";
import type { ImportEdit, ImportResolver } from "./edit";
import type { Scope } from "./selector";

export interface LibraryPuppet {
  id: string;
  version: number;
  puppet: Puppet; // puppet.id === id
}

export interface LibraryPart {
  id: string;
  version: number;
  unit: number;
  note: string;
  parts: Part[]; // parts[0].parent === null — the subtree root
}

export interface ImportSources {
  /** All versions; `lib.fox` resolves to the highest, `lib.fox@1` to that one. */
  puppets: LibraryPuppet[];
  parts: LibraryPart[];
  /** The head doc of a play, for `pl_x/cast/y` sources. */
  play: (playId: string) => { doc: Play; version: number } | null;
}

export interface LibraryEntry {
  src: string;
  kind: "puppet" | "part";
  name: string;
  note: string;
  version: number;
}

export type ParsedSource =
  | { kind: "libPuppet"; id: string; version?: number }
  | { kind: "libPart"; id: string; version?: number }
  | { kind: "playPuppet"; playId: string; puppet: string }
  | { kind: "playPart"; playId: string; puppet: string; part: string };

const LIB_PART = /^lib\.part\.([A-Za-z0-9_-]+)(?:@(\d+))?$/;
const LIB_PUPPET = /^lib\.([A-Za-z0-9_-]+)(?:@(\d+))?$/;
const PLAY_PART = /^(pl_[A-Za-z0-9_-]+)\/cast\/([A-Za-z0-9_-]+)\/parts\/([A-Za-z0-9_-]+)$/;
const PLAY_PUPPET = /^(pl_[A-Za-z0-9_-]+)\/cast\/([A-Za-z0-9_-]+)$/;

/** Parse an import `src`. Throws for anything that does not match one of the
 *  four forms (`lib.<id>`, `lib.<id>@<n>`, `lib.part.<id>`, `lib.part.<id>@<n>`,
 *  `pl_<id>/cast/<puppet>`, `pl_<id>/cast/<puppet>/parts/<part>`). */
export function parseSource(src: string): ParsedSource {
  let m: RegExpExecArray | null;
  if ((m = LIB_PART.exec(src))) return { kind: "libPart", id: m[1], version: m[2] ? Number(m[2]) : undefined };
  if ((m = LIB_PUPPET.exec(src))) return { kind: "libPuppet", id: m[1], version: m[2] ? Number(m[2]) : undefined };
  if ((m = PLAY_PART.exec(src))) return { kind: "playPart", playId: m[1], puppet: m[2], part: m[3] };
  if ((m = PLAY_PUPPET.exec(src))) return { kind: "playPuppet", playId: m[1], puppet: m[2] };
  throw new Error(`'${src}' is not a valid import source`);
}

/** The library index for `list_plays`: one entry per id, at its latest version. */
export function libraryIndex(sources: ImportSources): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const lp of latestOf(sources.puppets)) {
    out.push({ src: `lib.${lp.id}`, kind: "puppet", name: lp.puppet.name ?? lp.id, note: lp.puppet.note ?? "", version: lp.version });
  }
  for (const p of latestOf(sources.parts)) {
    out.push({ src: `lib.part.${p.id}`, kind: "part", name: p.id, note: p.note, version: p.version });
  }
  return out;
}

function latestOf<T extends { id: string; version: number }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const cur = byId.get(item.id);
    if (!cur || item.version > cur.version) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** The `ImportResolver` edit.ts calls for `{ op: "import" }`. */
export function createImportResolver(sources: ImportSources): ImportResolver {
  return (doc: Play, edit: ImportEdit, scope: Scope): string[] => {
    const isPart = edit.into !== undefined;
    checkScope(scope, isPart);
    return isPart ? importPart(doc, edit, sources) : importPuppet(doc, edit, sources);
  };
}

function checkScope(scope: Scope, isPart: boolean): void {
  if (scope.kind !== "cast") {
    const where = scope.kind === "scene" ? `scene scope (${scope.id})` : "play scope";
    throw new Error(`import needs cast scope, not ${where}`);
  }
  if (!isPart && scope.puppet !== undefined) {
    throw new Error("puppet import needs an unscoped edit_cast (cast scope with no puppet)");
  }
}

// ---------- puppet import ----------

function importPuppet(doc: Play, edit: ImportEdit, sources: ImportSources): string[] {
  const parsed = parseSource(edit.src);
  let source: Puppet;
  let ref: string;
  if (parsed.kind === "libPuppet") {
    const lp = pickPuppet(sources, parsed.id, parsed.version);
    source = lp.puppet;
    ref = `lib.${lp.id}@${lp.version}`;
  } else if (parsed.kind === "playPuppet") {
    const play = sources.play(parsed.playId);
    if (!play) throw new Error(`no such play '${parsed.playId}'`);
    const p = play.doc.cast[parsed.puppet];
    if (!p) throw new Error(`${parsed.playId} has no puppet '${parsed.puppet}' in its cast`);
    source = p;
    ref = `${parsed.playId}/cast/${parsed.puppet}@${play.version}`;
  } else {
    throw new Error(`'${edit.src}' is not a puppet source`);
  }

  const id = edit.as ?? source.id;
  if (id in doc.cast) throw new Error(`cast already has '${id}' (use set to replace)`);
  const copy: Puppet = structuredClone(source);
  copy.id = id;
  copy.from = ref;
  doc.cast[id] = copy;
  return ["cast", `cast:${id}`];
}

function pickPuppet(sources: ImportSources, id: string, version?: number): LibraryPuppet {
  const candidates = sources.puppets.filter((p) => p.id === id);
  if (!candidates.length) throw new Error(`no such library puppet 'lib.${id}'`);
  if (version === undefined) return candidates.reduce((a, b) => (b.version > a.version ? b : a));
  const exact = candidates.find((p) => p.version === version);
  if (!exact) {
    const have = Math.max(...candidates.map((p) => p.version));
    throw new Error(`no lib.${id}@${version} (have @${have})`);
  }
  return exact;
}

// ---------- part import ----------

function importPart(doc: Play, edit: ImportEdit, sources: ImportSources): string[] {
  if (!edit.into) throw new Error("part import needs `into`");
  if (!edit.parent) throw new Error("part import needs `parent`");
  if (!edit.pivot) throw new Error("part import needs `pivot`");
  const target = doc.cast[edit.into];
  if (!target) throw new Error(`no such puppet '${edit.into}' in the cast`);
  if (!target.parts.some((p) => p.id === edit.parent)) {
    throw new Error(`puppet '${edit.into}' has no part '${edit.parent}'`);
  }

  const parsed = parseSource(edit.src);
  let subtree: Part[];
  let sourceUnit: number;
  let ref: string;
  if (parsed.kind === "libPart") {
    const lp = pickPart(sources, parsed.id, parsed.version);
    subtree = lp.parts;
    sourceUnit = lp.unit;
    ref = `lib.part.${lp.id}@${lp.version}`;
  } else if (parsed.kind === "playPart") {
    const play = sources.play(parsed.playId);
    if (!play) throw new Error(`no such play '${parsed.playId}'`);
    const puppet = play.doc.cast[parsed.puppet];
    if (!puppet) throw new Error(`${parsed.playId} has no puppet '${parsed.puppet}' in its cast`);
    subtree = subtreeOf(puppet.parts, parsed.part);
    sourceUnit = puppet.unit;
    ref = `${parsed.playId}/cast/${parsed.puppet}/parts/${parsed.part}@${play.version}`;
  } else {
    throw new Error(`'${edit.src}' is not a part source`);
  }
  if (!subtree.length) throw new Error(`'${edit.src}': empty subtree`);

  const ratio = target.unit / sourceUnit;
  const rootId = edit.as ?? subtree[0].id;
  const idMap = new Map<string, string>(subtree.map((p) => [p.id, p.id]));
  idMap.set(subtree[0].id, rootId);

  const existing = new Set(target.parts.map((p) => p.id));
  for (const p of subtree) {
    const newId = idMap.get(p.id)!;
    if (existing.has(newId)) throw new Error(`puppet '${edit.into}' already has a part '${newId}'`);
  }

  const subtreeIds = new Set(subtree.map((p) => p.id));
  const copied: Part[] = subtree.map((p, i) => {
    const isRoot = i === 0;
    const copy: Part = structuredClone(p);
    copy.id = idMap.get(p.id)!;
    copy.parent = isRoot ? edit.parent! : idMap.get(p.parent as string) ?? p.parent;
    copy.pivot = isRoot ? (edit.pivot as Vec) : scaleVec(p.pivot, ratio);
    if (copy.rod) copy.rod = scaleVec(copy.rod, ratio);
    if (typeof copy.path === "string" && copy.path.trim()) {
      copy.path = serializePath(mapPath(parsePath(copy.path), (v) => scaleVec(v, ratio)));
    }
    if (copy.mirrorOf) {
      if (!subtreeIds.has(copy.mirrorOf)) {
        throw new Error(`'${p.id}': mirrorOf '${copy.mirrorOf}' is outside the imported subtree`);
      }
      copy.mirrorOf = idMap.get(copy.mirrorOf);
    }
    if (isRoot) copy.from = ref;
    return copy;
  });

  target.parts.push(...copied);
  return [`cast:${edit.into}`];
}

function pickPart(sources: ImportSources, id: string, version?: number): LibraryPart {
  const candidates = sources.parts.filter((p) => p.id === id);
  if (!candidates.length) throw new Error(`no such library part 'lib.part.${id}'`);
  if (version === undefined) return candidates.reduce((a, b) => (b.version > a.version ? b : a));
  const exact = candidates.find((p) => p.version === version);
  if (!exact) {
    const have = Math.max(...candidates.map((p) => p.version));
    throw new Error(`no lib.part.${id}@${version} (have @${have})`);
  }
  return exact;
}

/** `rootId` and every part beneath it, root first, in the parts list's own order. */
function subtreeOf(parts: Part[], rootId: string): Part[] {
  const root = parts.find((p) => p.id === rootId);
  if (!root) throw new Error(`no such part '${rootId}'`);
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of parts) {
      if (p.parent && ids.has(p.parent) && !ids.has(p.id)) {
        ids.add(p.id);
        grew = true;
      }
    }
  }
  return [root, ...parts.filter((p) => p.id !== rootId && ids.has(p.id))];
}

function scaleVec([x, y]: Vec, ratio: number): Vec {
  return [x * ratio, y * ratio];
}
