// Selectors — spec §2.1. A selector is a string that names one place in a play
// document: `s1/b4:fox@0.joints.arm_l`. This module is the grammar (parse,
// format, scope prefixing) and the navigation it implies: given a doc and a
// parsed selector, which container holds the addressed thing, under what key,
// and what is there now. edit.ts and read.ts do the rest.

import { RESERVED_PLAY, RESERVED_SCENE } from "./validate";

export type Step =
  | { kind: "scene"; id: string }
  | { kind: "beat"; id: string }
  | { kind: "track"; puppet: string }
  /** A keyframe or a cue, addressed by its `at` — never by index. */
  | { kind: "key"; at: number | "*" }
  | { kind: "puppet"; id: string }
  | { kind: "part"; id: string }
  | { kind: "prop"; name: string };

/** The altitude an edit tool works at; a selector is relative to it. */
export type Scope = { kind: "play" } | { kind: "scene"; id: string } | { kind: "cast"; puppet?: string };

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

const NAME = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;
/** Fields of a puppet — never a puppet id, so a leading `fox.` in cast:fox scope is a prefix. */
const PUPPET_FIELDS = new Set(["id", "name", "note", "unit", "cap", "from", "restPose", "look", "parts"]);

// ---------- parsing ----------

interface Tok {
  sep: "" | "/" | ":" | "@" | ".";
  text: string;
}

function tokenize(sel: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < sel.length) {
    let sep: Tok["sep"] = "";
    if (toks.length) {
      const c = sel[i];
      if (c !== "/" && c !== ":" && c !== "@" && c !== ".") throw new SelectorError(`'${sel}': unexpected '${c}'`);
      sep = c;
      i++;
    }
    const start = i;
    if (sep === "@") {
      if (sel[i] === "*") i++;
      else {
        if (sel[i] === "-") i++;
        while (DIGIT.test(sel[i] ?? "")) i++;
        // Read the fraction only when digits follow, so `@0.joints` stops at the dot.
        if (sel[i] === "." && DIGIT.test(sel[i + 1] ?? "")) {
          i++;
          while (DIGIT.test(sel[i] ?? "")) i++;
        }
      }
    } else {
      while (i < sel.length && NAME.test(sel[i])) i++;
    }
    if (i === start) throw new SelectorError(`'${sel}': empty step after '${sep || "start"}'`);
    toks.push({ sep, text: sel.slice(start, i) });
  }
  return toks;
}

/** Where the walk is: what the next separator and name may mean. */
type Mode = "play" | "scene" | "beat" | "track" | "key" | "cast" | "puppet" | "parts" | "part" | "prop" | "atList";

/** The steps a scope prepends to every selector parsed inside it. */
export function scopeSteps(scope: Scope): Step[] {
  switch (scope.kind) {
    case "play":
      return [];
    case "scene":
      return [{ kind: "scene", id: scope.id }];
    case "cast":
      return scope.puppet
        ? [{ kind: "prop", name: "cast" }, { kind: "puppet", id: scope.puppet }]
        : [{ kind: "prop", name: "cast" }];
  }
}

function modeAfter(steps: Step[]): Mode {
  const last = steps[steps.length - 1];
  if (!last) return "play";
  switch (last.kind) {
    case "scene":
      return "scene";
    case "beat":
      return "beat";
    case "track":
      return "track";
    case "key":
      return "key";
    case "puppet":
      return "puppet";
    case "part":
      return "part";
    case "prop":
      if (last.name === "cast" && steps.length === 1) return "cast";
      if (last.name === "parts" && steps[steps.length - 2]?.kind === "puppet") return "parts";
      if (last.name === "fx") return "atList";
      return "prop";
  }
}

/**
 * Parse a selector into steps, prefixed with `scope`'s own steps. A selector
 * that already spells out its scope prefix is forgiven; one that reaches
 * outside the scope is rejected. `""` addresses the scope root.
 */
export function parseSelector(sel: string, scope: Scope = { kind: "play" }): Step[] {
  const steps = scopeSteps(scope);
  const rest = stripScope(sel.trim(), scope);
  let mode = modeAfter(steps);
  for (const tok of tokenize(rest)) {
    const sep = tok.sep;
    const at = sep === "@" ? (tok.text === "*" ? ("*" as const) : Number(tok.text)) : 0;
    const bad = () => new SelectorError(`'${sel}': '${sep}${tok.text}' does not follow a ${mode}`);
    switch (mode) {
      case "play":
        if (sep !== "") throw bad();
        steps.push(RESERVED_PLAY.has(tok.text) ? { kind: "prop", name: tok.text } : { kind: "scene", id: tok.text });
        break;
      case "scene":
        if (sep === "/" || sep === "") {
          steps.push(RESERVED_SCENE.has(tok.text) ? { kind: "prop", name: tok.text } : { kind: "beat", id: tok.text });
        } else if (sep === ".") steps.push({ kind: "prop", name: tok.text });
        else throw bad();
        break;
      case "beat":
        if (sep === ":") steps.push({ kind: "track", puppet: tok.text });
        else if (sep === "." || sep === "") steps.push({ kind: "prop", name: tok.text });
        else throw bad();
        break;
      case "track":
      case "atList":
        if (sep === "@") steps.push({ kind: "key", at });
        else if (sep === "." && mode === "atList") steps.push({ kind: "prop", name: tok.text });
        else throw bad();
        break;
      case "cast":
        if (sep === "." || sep === "") steps.push({ kind: "puppet", id: tok.text });
        else throw bad();
        break;
      case "parts":
        if (sep === "." || sep === "") steps.push({ kind: "part", id: tok.text });
        else throw bad();
        break;
      case "key":
      case "puppet":
      case "part":
      case "prop":
        if (sep === "." || sep === "") steps.push({ kind: "prop", name: tok.text });
        else throw bad();
        break;
    }
    mode = modeAfter(steps);
  }
  return steps;
}

/** Drop a spelled-out scope prefix; reject a selector that leaves the scope. */
function stripScope(sel: string, scope: Scope): string {
  if (scope.kind === "scene") {
    const m = /^([A-Za-z0-9_-]+)(\/|$)/.exec(sel);
    // Only a scene can be followed by `/`, so a leading `x/` is always a scene prefix.
    if (m && (m[2] === "/" || m[1] === scope.id)) {
      if (m[1] !== scope.id) throw new SelectorError(`'${sel}' escapes scene ${scope.id}`);
      return sel.slice(m[0].length);
    }
    return sel;
  }
  if (scope.kind === "cast") {
    const m = /^([A-Za-z0-9_-]+)(\.|$)/.exec(sel);
    if (!m) return sel;
    if (m[1] === "cast") {
      const inner = sel.slice(m[0].length);
      if (!scope.puppet) return inner;
      const n = /^([A-Za-z0-9_-]+)(\.|$)/.exec(inner);
      if (!n || n[1] !== scope.puppet) throw new SelectorError(`'${sel}' escapes cast ${scope.puppet}`);
      return inner.slice(n[0].length);
    }
    if (scope.puppet && m[1] === scope.puppet && !PUPPET_FIELDS.has(m[1])) return sel.slice(m[0].length);
    return sel;
  }
  return sel;
}

export function formatSelector(steps: Step[]): string {
  let out = "";
  steps.forEach((step, i) => {
    const first = i === 0;
    switch (step.kind) {
      case "scene":
        out += step.id;
        break;
      case "beat":
        out += first ? step.id : `/${step.id}`;
        break;
      case "track":
        out += `:${step.puppet}`;
        break;
      case "key":
        out += `@${step.at}`;
        break;
      case "puppet":
      case "part":
        out += first ? step.id : `.${step.id}`;
        break;
      case "prop":
        // A scene's beat list is the one property reached with `/`.
        out += first ? step.name : step.name === "beats" && steps[i - 1]?.kind === "scene" ? `/${step.name}` : `.${step.name}`;
        break;
    }
  });
  return out;
}

export function hasWildcard(steps: Step[]): boolean {
  return steps.some((s) => s.kind === "key" && s.at === "*");
}

// ---------- navigation ----------

/** A resolved address: the container, how it keys its contents, what is there. */
export interface Slot {
  /** The object, record or array holding the value. */
  parent: any;
  /** A property name, or an array index — `-1` when nothing matches yet. */
  key: string | number;
  /** Undefined when the addressed thing does not exist. */
  value: unknown;
  /** How `parent` is addressed: a property, an `id` in a list, an `at` in a list. */
  by: "prop" | "id" | "at";
  /** The id from the selector, for id-keyed lists and the cast map. */
  name?: string;
  /** The `at` from the selector, for `at`-ordered lists. */
  at?: number;
  step: Step;
}

export interface ResolveOptions {
  /** Create missing intermediate objects and lists (what `set` needs to upsert). */
  create?: boolean;
}

/**
 * Every slot a selector addresses — more than one only through `@*`. Missing
 * intermediates are an error unless `create`, and even then only plain objects
 * and lists are created: a missing scene, beat, part or keyframe on the way is
 * always an error. The last step may be absent (`value === undefined`).
 */
export function resolveAll(doc: unknown, steps: Step[], opts: ResolveOptions = {}): Slot[] {
  if (!steps.length) throw new SelectorError("the document root is not a slot");
  let cursors: unknown[] = [doc];
  let slots: Slot[] = [];
  for (let i = 0; i < steps.length; i++) {
    const last = i === steps.length - 1;
    const next: unknown[] = [];
    slots = [];
    for (const cur of cursors) {
      for (const slot of slotsFor(cur, steps, i, opts.create === true)) {
        if (!last && slot.value == null) {
          if (!opts.create || slot.by !== "prop" || slot.parent == null) {
            throw new SelectorError(`${formatSelector(steps.slice(0, i + 1))}: nothing there`);
          }
          slot.value = emptyFor(steps[i], steps[i + 1]);
          slot.parent[slot.key] = slot.value;
        }
        slots.push(slot);
        next.push(slot.value);
      }
    }
    cursors = next;
  }
  return slots;
}

/** The one slot a selector addresses. Throws on a `@*` fan-out. */
export function resolve(doc: unknown, steps: Step[], opts: ResolveOptions = {}): Slot {
  const slots = resolveAll(doc, steps, opts);
  if (slots.length !== 1) throw new SelectorError(`${formatSelector(steps)}: addresses ${slots.length} places, not one`);
  return slots[0];
}

/** The value at a selector; the doc itself for `[]`, an array of values for `@*`. */
export function resolveValue(doc: unknown, steps: Step[]): unknown {
  if (!steps.length) return doc;
  const slots = resolveAll(doc, steps);
  return hasWildcard(steps) ? slots.map((s) => s.value) : slots[0]?.value;
}

function slotsFor(cur: any, steps: Step[], i: number, create: boolean): Slot[] {
  const step = steps[i];
  const prev = i > 0 ? steps[i - 1] : undefined;
  const where = formatSelector(steps.slice(0, i + 1));
  switch (step.kind) {
    case "scene":
      return [inList(cur?.scenes, step.id, step, where)];
    case "beat":
      return [inList(cur?.beats, step.id, step, where)];
    case "track": {
      if (create && cur != null && cur.tracks == null) cur.tracks = {};
      const tracks = cur?.tracks;
      return [{ parent: tracks, key: step.puppet, value: tracks?.[step.puppet], by: "prop", name: step.puppet, step }];
    }
    case "part":
      return [inList(cur, step.id, step, where)];
    case "puppet":
      return [{ parent: cur, key: step.id, value: cur?.[step.id], by: "prop", name: step.id, step }];
    case "key": {
      if (!Array.isArray(cur)) throw new SelectorError(`${where}: not a keyed list`);
      if (step.at === "*") {
        return cur.map((v, idx) => ({ parent: cur, key: idx, value: v, by: "at" as const, at: v?.at, step }));
      }
      const idx = cur.findIndex((v: any) => v?.at === step.at);
      return [{ parent: cur, key: idx, value: idx < 0 ? undefined : cur[idx], by: "at", at: step.at, step }];
    }
    case "prop": {
      // Inside a keyframe, `joints` and `root` live under `pose`.
      let obj = cur;
      if (prev?.kind === "key" && (step.name === "joints" || step.name === "root")) {
        if (create && obj != null && obj.pose == null) obj.pose = {};
        obj = obj?.pose;
      }
      return [{ parent: obj, key: step.name, value: obj?.[step.name], by: "prop", step }];
    }
  }
}

function inList(list: any, id: string, step: Step, where: string): Slot {
  if (!Array.isArray(list)) throw new SelectorError(`${where}: not a list`);
  const idx = list.findIndex((v: any) => v?.id === id);
  return { parent: list, key: idx, value: idx < 0 ? undefined : list[idx], by: "id", name: id, step };
}

function emptyFor(step: Step, next: Step): unknown {
  if (step.kind === "track") return [];
  if (next.kind === "key" || next.kind === "part") return [];
  if (step.kind === "prop" && ["scenes", "beats", "parts", "fx"].includes(step.name)) return [];
  return {};
}
