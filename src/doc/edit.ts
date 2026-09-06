// The five edits of spec §2.2 applied to a play document. Pure: the doc is
// deep-cloned, edits are applied in order, a new doc comes out. Failures that
// are structural (bad selector, missing target, wrong shape) throw an EditError
// naming the edit's index; everything semantic is validate.ts's job and runs
// once per batch in applyAndValidate.

import { buildTimeline } from "../engine/timeline";
import type { Play } from "../model/types";
import {
  formatSelector, parseSelector, resolveAll, SelectorError,
  type Scope, type Slot, type Step,
} from "./selector";
import { validatePlay } from "./validate";

export type { Scope } from "./selector";

export type Edit =
  | { op: "set"; sel: string; value: unknown }
  | { op: "insert"; sel: string; value: unknown; after?: string }
  | { op: "remove"; sel: string }
  | { op: "nudge"; sel: string; delta: number | [number, number] }
  | { op: "import"; src: string; as?: string; into?: string; parent?: string; pivot?: [number, number] };

export type ImportEdit = Extract<Edit, { op: "import" }>;

/**
 * Resolves an import against the library (src/doc/library.ts, Milestone 4):
 * mutates the working doc in place and returns the scopes it touched. Throws
 * for an unresolvable source or a colliding id.
 */
export type ImportResolver = (doc: Play, edit: ImportEdit, scope: Scope) => string[];

export interface EditContext {
  imports?: ImportResolver;
}

export class EditError extends Error {
  constructor(readonly index: number, readonly edit: Edit, message: string) {
    super(message);
    this.name = "EditError";
  }
}

export function applyEdits(
  doc: Play,
  edits: Edit[],
  scope: Scope = { kind: "play" },
  ctx?: EditContext,
): { doc: Play; touched: string[] } {
  const out = structuredClone(doc);
  const touched = new Set<string>();
  edits.forEach((edit, index) => {
    try {
      for (const t of applyOne(out, edit, scope, ctx)) touched.add(t);
    } catch (e) {
      throw new EditError(index, edit, (e as Error).message);
    }
  });
  return { doc: out, touched: [...touched] };
}

/**
 * Apply a batch and validate the result. On failure, re-applies the prefixes
 * `edits[0..i]` to find the first edit whose result is invalid, so the caller
 * can point at it.
 */
export function applyAndValidate(
  doc: Play,
  edits: Edit[],
  scope: Scope = { kind: "play" },
  ctx?: EditContext,
): { ok: true; doc: Play; touched: string[] } | { ok: false; index: number; message: string } {
  let applied;
  try {
    applied = applyEdits(doc, edits, scope, ctx);
  } catch (e) {
    if (e instanceof EditError) return { ok: false, index: e.index, message: e.message };
    throw e;
  }
  const checked = validatePlay(applied.doc);
  if (checked.ok) return { ok: true, doc: checked.doc, touched: applied.touched };
  for (let i = 0; i < edits.length; i++) {
    const prefix = validatePlay(applyEdits(doc, edits.slice(0, i + 1), scope, ctx).doc);
    if (!prefix.ok) return { ok: false, index: i, message: prefix.error };
  }
  return { ok: false, index: Math.max(0, edits.length - 1), message: checked.error };
}

/** One short line per edit, for logs and version history. */
export function editsSummary(edits: Edit[]): string {
  return edits
    .map((e) => {
      switch (e.op) {
        case "set":
          return `set ${e.sel} = ${brief(e.value)}`;
        case "insert":
          return `insert ${e.sel}${e.after === undefined ? "" : e.after === "" ? " first" : ` after ${e.after}`} ${brief(e.value)}`;
        case "remove":
          return `remove ${e.sel}`;
        case "nudge":
          return `nudge ${e.sel} ${Array.isArray(e.delta) ? `[${e.delta.join(", ")}]` : signed(e.delta)}`;
        case "import":
          return `import ${e.src}${e.as ? ` as ${e.as}` : ""}${e.into ? ` into ${e.into}` : ""}`;
      }
    })
    .join("\n");
}

// ---------- one edit ----------

function applyOne(doc: Play, edit: Edit, scope: Scope, ctx?: EditContext): string[] {
  if (edit.op === "import") {
    if (!ctx?.imports) throw new Error("imports unavailable");
    return ctx.imports(doc, edit, scope);
  }
  const steps = parseSelector(edit.sel, scope);
  switch (edit.op) {
    case "set":
      applySet(doc, steps, structuredClone(edit.value));
      break;
    case "insert":
      applyInsert(doc, steps, structuredClone(edit.value), edit.after);
      break;
    case "remove":
      applyRemove(doc, steps);
      break;
    case "nudge":
      applyNudge(doc, steps, edit.delta);
      break;
  }
  return touchedBy(steps);
}

function applySet(doc: Play, steps: Step[], value: unknown): void {
  if (!steps.length) throw new Error("set needs a target");
  const sel = formatSelector(steps);
  for (const slot of resolveAll(doc, steps, { create: true })) {
    // Anything addressed by an id or an `at` is an object whose identity comes
    // from the selector, not from the value.
    if (slot.by === "at" || slot.by === "id" || slot.step.kind === "puppet") {
      if (!isObject(value)) throw new Error(`${sel}: expected an object`);
      const item: any = { ...value };
      if (slot.by === "at") item.at = slot.at;
      else item.id = slot.name;
      if (slot.by === "prop") slot.parent[slot.key] = item;
      else if ((slot.key as number) >= 0) slot.parent[slot.key as number] = item;
      else if (slot.by === "id") slot.parent.push(item);
      else insertByAt(slot.parent, item);
      continue;
    }
    if (slot.parent == null) throw new Error(`${sel}: nothing to set it on`);
    if (typeof slot.value === "number" && typeof value !== "number") throw new Error(`${sel}: expected a number`);
    slot.parent[slot.key] = value;
  }
}

function applyInsert(doc: Play, steps: Step[], value: unknown, after?: string): void {
  if (!steps.length) throw new Error("insert needs a target list");
  const sel = formatSelector(steps);
  if (!isObject(value)) throw new Error(`insert ${sel}: the value must be an object`);
  const slot = only(resolveAll(doc, steps, { create: true }), sel);
  const last = slot.step;

  if (last.kind === "prop" && last.name === "cast") {
    const id = idOf(value, sel);
    if (!isObject(slot.value)) throw new Error(`insert ${sel}: not a map`);
    if (id in slot.value) throw new Error(`insert ${sel}: '${id}' already exists (set replaces)`);
    slot.value[id] = value;
    return;
  }
  let list = slot.value;
  if (list == null && slot.by === "prop" && slot.parent != null) {
    list = [];
    slot.parent[slot.key] = list;
  }
  if (!Array.isArray(list)) throw new Error(`insert ${sel}: not a list`);

  if (last.kind === "track" || (last.kind === "prop" && last.name === "fx")) {
    const at = (value as any).at;
    if (typeof at !== "number") throw new Error(`insert ${sel}: an at-ordered list needs a numeric \`at\``);
    if (list.some((x: any) => x?.at === at)) throw new Error(`insert ${sel}: something is already at ${at} (set replaces)`);
    insertByAt(list, value);
    return;
  }
  const id = idOf(value, sel);
  if (list.some((x: any) => x?.id === id)) throw new Error(`insert ${sel}: '${id}' already exists (set replaces)`);
  if (after === undefined) list.push(value);
  else if (after === "") list.unshift(value);
  else {
    const i = list.findIndex((x: any) => x?.id === after);
    if (i < 0) throw new Error(`insert ${sel}: no '${after}' to insert after`);
    list.splice(i + 1, 0, value);
  }
}

function applyRemove(doc: Play, steps: Step[]): void {
  if (!steps.length) throw new Error("remove needs a target");
  const sel = formatSelector(steps);
  const last = steps[steps.length - 1];

  if (last.kind === "key" && last.at === "*") {
    const track = only(resolveAll(doc, steps.slice(0, -1)), sel).value;
    if (!Array.isArray(track)) throw new Error(`${sel}: nothing to clear`);
    track.length = 0;
    return;
  }
  const slot = only(resolveAll(doc, steps), sel);
  if (slot.parent == null || slot.value === undefined || (slot.by !== "prop" && (slot.key as number) < 0)) {
    throw new Error(`${sel}: nothing to remove`);
  }
  if (last.kind === "part") {
    const parts = slot.parent as any[];
    const doomed = new Set([last.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of parts) {
        if (p.parent && doomed.has(p.parent) && !doomed.has(p.id)) {
          doomed.add(p.id);
          grew = true;
        }
      }
    }
    const kept = parts.filter((p) => !doomed.has(p.id));
    parts.length = 0;
    parts.push(...kept);
    return;
  }
  if (last.kind === "puppet") {
    delete slot.parent[last.id];
    for (const scene of doc.scenes) for (const beat of scene.beats) delete beat.tracks?.[last.id];
    return;
  }
  if (slot.by === "prop") {
    const required = requiredProps(steps[steps.length - 2]);
    if (last.kind === "prop" && required.has(last.name)) throw new Error(`${sel}: required, it cannot be removed`);
    delete slot.parent[slot.key];
    return;
  }
  slot.parent.splice(slot.key as number, 1);
}

/** Fields whose container cannot do without them. */
function requiredProps(parent: Step | undefined): ReadonlySet<string> {
  if (!parent) return new Set(["id", "schemaVersion", "title", "stage", "cast", "scenes", "mode"]);
  switch (parent.kind) {
    case "scene":
      return new Set(["id", "beats"]);
    case "beat":
      return new Set(["id", "length"]);
    case "key":
      return new Set(["at", "pose"]);
    case "part":
      return new Set(["id", "parent", "pivot"]);
    case "puppet":
      return new Set(["id", "unit", "cap", "parts"]);
    case "prop":
      return parent.name === "stage" ? new Set(["tempo"]) : new Set();
    default:
      return new Set();
  }
}

function applyNudge(doc: Play, steps: Step[], delta: number | [number, number]): void {
  const sel = formatSelector(steps);
  const wild = steps.findIndex((s) => s.kind === "key" && s.at === "*");
  if (wild < 0) {
    const slot = tryResolve(doc, steps);
    if (slot && slot.value !== undefined) {
      slot.parent[slot.key] = nudged(slot.value, delta, sel);
      return;
    }
    // A key that does not carry the value inherits it; make that explicit.
    write(doc, steps, nudged(inherited(doc, steps, sel), delta, sel));
    return;
  }
  const keys = only(resolveAll(doc, steps.slice(0, wild)), sel).value;
  if (!Array.isArray(keys) || !keys.length) throw new Error(`${sel}: no keys to nudge`);
  const carried = keys
    .map((k: any) => concrete(steps, wild, k?.at))
    .map((s) => ({ steps: s, slot: tryResolve(doc, s) }))
    .filter((x) => x.slot && x.slot.value !== undefined);
  if (carried.length) {
    for (const { steps: s, slot } of carried) slot!.parent[slot!.key] = nudged(slot!.value, delta, formatSelector(s));
    return;
  }
  const first = concrete(steps, wild, keys[0].at);
  write(doc, first, nudged(inherited(doc, first, sel), delta, sel));
}

/** The same steps with the `@*` replaced by one key's `at`. */
function concrete(steps: Step[], wild: number, at: number): Step[] {
  return steps.map((s, i) => (i === wild ? { kind: "key" as const, at } : s));
}

function tryResolve(doc: Play, steps: Step[]): Slot | undefined {
  try {
    const slots = resolveAll(doc, steps);
    return slots.length === 1 ? slots[0] : undefined;
  } catch (e) {
    if (e instanceof SelectorError) return undefined;
    throw e;
  }
}

function write(doc: Play, steps: Step[], value: unknown): void {
  const slot = only(resolveAll(doc, steps, { create: true }), formatSelector(steps));
  if (slot.parent == null) throw new Error(`${formatSelector(steps)}: nothing to set it on`);
  slot.parent[slot.key] = value;
}

/**
 * The value a keyframe inherits at `s/b:puppet@at.joints|root.field`, from the
 * timeline's resolved keys. Only joints and root fields carry forward.
 */
function inherited(doc: Play, steps: Step[], sel: string): number {
  const [scene, beat, track, key, group, field] = steps;
  const shaped =
    steps.length === 6 &&
    scene?.kind === "scene" && beat?.kind === "beat" && track?.kind === "track" &&
    key?.kind === "key" && typeof key.at === "number" &&
    group?.kind === "prop" && (group.name === "joints" || group.name === "root") && field?.kind === "prop";
  if (!shaped) throw new Error(`${sel}: nothing there to nudge`);
  const tl = buildTimeline(doc);
  const span = tl.spans.find((s) => s.scene.id === scene.id && s.beat.id === beat.id);
  const at = (key as { at: number }).at;
  const resolved = span && tl.tracks.get((track as { puppet: string }).puppet)?.find((k) => Math.abs(k.at - (span.start + at)) < 1e-9);
  if (!resolved) throw new Error(`${sel}: no keyframe at ${at}`);
  const name = (field as { name: string }).name;
  const value = (group as { name: string }).name === "joints" ? resolved.joints[name] ?? 0 : (resolved.root as any)[name];
  if (typeof value !== "number") throw new Error(`${sel}: '${name}' is not a number`);
  return value;
}

function nudged(value: unknown, delta: number | [number, number], sel: string): unknown {
  if (typeof value === "number") {
    if (typeof delta !== "number") throw new Error(`${sel}: a number takes a number delta`);
    return value + delta;
  }
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number")) {
    if (!Array.isArray(delta) || delta.length !== 2) throw new Error(`${sel}: a 2-vector takes a [dx, dy] delta`);
    return [value[0] + delta[0], value[1] + delta[1]];
  }
  throw new Error(`${sel}: not a number or a 2-vector`);
}

// ---------- touched scopes ----------

/** The per-scope concurrency keys a selector's write affects. */
function touchedBy(steps: Step[]): string[] {
  const first = steps[0];
  if (!first) return ["play"];
  if (first.kind === "scene") {
    const out = [`scene:${first.id}`];
    // The scene itself, or one of its own fields: the play's scene list changed.
    if (steps.length === 1 || (steps[1].kind === "prop" && steps[1].name !== "beats")) out.push("play");
    return out;
  }
  if (first.kind === "prop" && first.name === "cast") {
    if (steps.length === 1) return ["cast"];
    const puppet = steps[1].kind === "puppet" ? steps[1].id : undefined;
    if (!puppet) return ["cast"];
    return steps.length === 2 ? ["cast", `cast:${puppet}`] : [`cast:${puppet}`];
  }
  return ["play"];
}

// ---------- small helpers ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function idOf(value: Record<string, unknown>, sel: string): string {
  const id = value.id;
  if (typeof id !== "string" || !id) throw new Error(`insert ${sel}: the value needs an \`id\``);
  return id;
}

function insertByAt(list: any[], item: any): void {
  const i = list.findIndex((x) => (x?.at ?? 0) > item.at);
  if (i < 0) list.push(item);
  else list.splice(i, 0, item);
}

function only(slots: Slot[], sel: string): Slot {
  if (slots.length !== 1) throw new Error(`${sel}: addresses ${slots.length} places, not one`);
  return slots[0];
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

function brief(v: unknown): string {
  const s = v === undefined ? "undefined" : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}
