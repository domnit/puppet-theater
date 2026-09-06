// The six tools of spec §3.1 as plain functions over the store. The MCP server
// and (from Milestone 5) the in-app chat both register from TOOLS, so a tool
// cannot exist in one client and not the other (§4.6).
//
// An edit call is one atomic batch: the edits are applied to a clone, the
// result is validated once, and only then is a version committed. A batch that
// cannot be applied returns `rejected` naming the offending index and commits
// nothing. `version` in the request is the optimistic base; a commit that
// would clobber a concurrent change to the same scope comes back as
// `{ index: -1 }`.

import { applyAndValidate, type Edit, type ImportResolver, type Scope } from "../doc/edit";
import type { LibraryEntry } from "../doc/library";
import { readPlay } from "../doc/read";
import { formatSelector, parseSelector, type Step } from "../doc/selector";
import type { Play } from "../model/types";
import { StaleError, type Mode, type PlayRow, type Role, type Store } from "../store/db";
import { z } from "zod";
import * as D from "./descriptions";

export interface Principal {
  id: string;
  role: Role;
}

export interface ToolContext {
  store: Store;
  principal: Principal;
  /** Origin the play URLs are built from, e.g. `http://localhost:4300`. */
  baseUrl: string;
  imports: ImportResolver;
  libraryIndex: LibraryEntry[];
}

/** A refused call, as opposed to a rejected edit. `status` is its HTTP code. */
export class ToolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ToolError";
  }
}

// ---------- argument schemas (the MCP wrapper reuses these as input schemas) ----------

const EditArg = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), sel: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("insert"), sel: z.string(), value: z.unknown(), after: z.string().optional() }),
  z.object({ op: z.literal("remove"), sel: z.string() }),
  z.object({ op: z.literal("nudge"), sel: z.string(), delta: z.union([z.number(), z.tuple([z.number(), z.number()])]) }),
  z.object({
    op: z.literal("import"),
    src: z.string(),
    as: z.string().optional(),
    into: z.string().optional(),
    parent: z.string().optional(),
    pivot: z.tuple([z.number(), z.number()]).optional(),
  }),
]);

const playId = z.string().min(1);
const edits = z.array(EditArg).min(1).max(200);
const version = z.number().int().min(1).optional();

export const CreatePlayArgs = z.object({
  title: z.string().max(200).optional(),
  mode: z.enum(["open", "closed"]).optional(),
});
export const ListPlaysArgs = z.object({
  query: z.string().optional(),
  mine: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const ReadPlayArgs = z.object({
  play_id: playId,
  sel: z.string().optional(),
  depth: z.enum(["play", "scene", "beat", "key"]).optional(),
  include_paths: z.array(z.string()).optional(),
});
export const EditPlayArgs = z.object({ play_id: playId, edits, version });
export const EditSceneArgs = z.object({ play_id: playId, scene_id: z.string().min(1), edits, version });
export const EditCastArgs = z.object({ play_id: playId, puppet_id: z.string().optional(), edits, version });

export type CreatePlayArgs = z.infer<typeof CreatePlayArgs>;
export type ListPlaysArgs = z.infer<typeof ListPlaysArgs>;
export type ReadPlayArgs = z.infer<typeof ReadPlayArgs>;
export type EditPlayArgs = z.infer<typeof EditPlayArgs>;
export type EditSceneArgs = z.infer<typeof EditSceneArgs>;
export type EditCastArgs = z.infer<typeof EditCastArgs>;

export interface Rejection {
  /** The index in the submitted batch; `-1` for a stale-version refusal. */
  index: number;
  op?: Edit["op"];
  sel?: string;
  reason: string;
}

export interface EditResult {
  version: number;
  rejected: Rejection[];
}

// ---------- the six tools ----------

export function create_play(ctx: ToolContext, args: CreatePlayArgs): { play_id: string; url: string; version: number } {
  const mode: Mode = args.mode ?? "open";
  if (mode === "closed" && ctx.principal.role === "public") {
    throw new ToolError("anonymous callers can only create open plays", 403);
  }
  // The store assigns the id and writes version 1.
  const doc: Play = {
    id: "",
    schemaVersion: 1,
    title: args.title ?? "Untitled",
    meta: {},
    stage: { tempo: 96 },
    cast: {},
    scenes: [],
  };
  const row = ctx.store.createPlay({ creator: ctx.principal.id, mode, doc });
  return { play_id: row.id, url: playUrl(ctx, row.id), version: row.headVersion };
}

export function list_plays(ctx: ToolContext, args: ListPlaysArgs) {
  const rows = ctx.store.listPlays({
    query: args.query,
    creator: args.mine ? ctx.principal.id : undefined,
    limit: args.limit ?? 25,
  });
  const plays = rows.map((row) => ({
    id: row.id,
    title: row.title,
    mode: row.mode,
    creator: row.creator,
    version: row.headVersion,
    url: playUrl(ctx, row.id),
    cast: Object.keys(ctx.store.getPlay(row.id)?.doc.cast ?? {}),
    updated: new Date(row.updatedAt).toISOString(),
  }));
  return { plays, library: ctx.libraryIndex };
}

export function read_play(ctx: ToolContext, args: ReadPlayArgs): Record<string, unknown> {
  const { row, doc, version } = mustGet(ctx, args.play_id);
  let projection: unknown;
  try {
    projection = readPlay(doc, { sel: args.sel, depth: args.depth, include_paths: args.include_paths });
  } catch (e) {
    throw new ToolError((e as Error).message, 400);
  }
  // A selector may address a bare value (`stage.tempo`); wrap it so the
  // version and mode always sit at the top level.
  const body = isRecord(projection) ? projection : { value: projection };
  return { ...body, version, mode: row.mode };
}

export function edit_play(ctx: ToolContext, args: EditPlayArgs): EditResult {
  const loaded = mustEdit(ctx, args.play_id);
  // `mode` lives on the play row, not in the document: pull those edits out of
  // the batch, authorise them here, and apply them once the doc commit lands.
  const rest: Edit[] = [];
  const origin: number[] = [];
  let mode: Mode | undefined;
  for (const [index, edit] of args.edits.entries()) {
    if (!isModeEdit(edit)) {
      rest.push(edit);
      origin.push(index);
      continue;
    }
    const bad = modeRefusal(ctx, loaded.row, edit);
    if (bad) return refuse(args.edits, index, bad, loaded.version);
    mode = (edit as { value: Mode }).value;
  }
  if (rest.length === 0) {
    if (mode) ctx.store.setMode(args.play_id, mode);
    return { version: loaded.version, rejected: [] };
  }
  const result = commitEdits(ctx, loaded, rest, { kind: "play" }, args.version);
  // Report indexes against the batch the caller sent, not the filtered one.
  for (const r of result.rejected) if (r.index >= 0) r.index = origin[r.index];
  if (result.rejected.length === 0 && mode) ctx.store.setMode(args.play_id, mode);
  return result;
}

export function edit_scene(ctx: ToolContext, args: EditSceneArgs): EditResult {
  const loaded = mustEdit(ctx, args.play_id);
  return commitEdits(ctx, loaded, args.edits, { kind: "scene", id: args.scene_id }, args.version);
}

export function edit_cast(ctx: ToolContext, args: EditCastArgs): EditResult {
  const loaded = mustEdit(ctx, args.play_id);
  const scope: Scope = { kind: "cast", puppet: args.puppet_id };
  const batch = args.edits;
  const missing = missingNote(loaded.doc, batch, scope);
  if (missing) return refuse(batch, missing.index, missing.reason, loaded.version);
  return commitEdits(ctx, loaded, batch, scope, args.version);
}

// ---------- the registry both clients read ----------

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  /** Parses `args` with `schema`, then runs the tool. */
  run(ctx: ToolContext, args: unknown): unknown;
}

function def<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  fn: (ctx: ToolContext, args: z.infer<S>) => unknown,
): ToolDef {
  return { name, description, schema, run: (ctx, args) => fn(ctx, schema.parse(args)) };
}

export const TOOLS: ToolDef[] = [
  def("create_play", D.CREATE_PLAY, CreatePlayArgs, create_play),
  def("list_plays", D.LIST_PLAYS, ListPlaysArgs, list_plays),
  def("read_play", D.READ_PLAY, ReadPlayArgs, read_play),
  def("edit_play", D.EDIT_PLAY, EditPlayArgs, edit_play),
  def("edit_scene", D.EDIT_SCENE, EditSceneArgs, edit_scene),
  def("edit_cast", D.EDIT_CAST, EditCastArgs, edit_cast),
];

// ---------- shared machinery ----------

interface Loaded {
  row: PlayRow;
  doc: Play;
  version: number;
}

function playUrl(ctx: ToolContext, id: string): string {
  return `${ctx.baseUrl}/p/${id}`;
}

function mustGet(ctx: ToolContext, id: string): Loaded {
  const got = ctx.store.getPlay(id);
  if (!got) throw new ToolError(`no play ${id}`, 404);
  return got;
}

/** Read for editing: anyone may edit an open play, only the creator a closed one. */
function mustEdit(ctx: ToolContext, id: string): Loaded {
  const loaded = mustGet(ctx, id);
  if (loaded.row.mode === "closed" && loaded.row.creator !== ctx.principal.id) {
    throw new ToolError(`play ${id} is closed; only ${loaded.row.creator} can edit it`, 403);
  }
  return loaded;
}

function commitEdits(ctx: ToolContext, loaded: Loaded, batch: Edit[], scope: Scope, base?: number): EditResult {
  const applied = applyAndValidate(loaded.doc, batch, scope, { imports: ctx.imports });
  if (!applied.ok) return refuse(batch, applied.index, applied.message, loaded.version);
  try {
    const { version } = ctx.store.commit({
      playId: loaded.row.id,
      doc: applied.doc,
      edits: absolute(batch, scope),
      touched: applied.touched,
      author: ctx.principal.id,
      base,
    });
    return { version, rejected: [] };
  } catch (e) {
    if (e instanceof StaleError) return { version: e.head, rejected: [{ index: -1, reason: e.message }] };
    throw e;
  }
}

function refuse(batch: Edit[], index: number, reason: string, head: number): EditResult {
  const edit = batch[index];
  return {
    version: head,
    rejected: [{ index, op: edit?.op, sel: edit && "sel" in edit ? edit.sel : undefined, reason }],
  };
}

/**
 * Selectors are rewritten play-absolute before a batch is stored and pushed, so
 * that history and the SSE feed carry no hidden scope. Only called after the
 * batch applied cleanly, so every selector parses.
 */
function absolute(batch: Edit[], scope: Scope): Edit[] {
  return batch.map((e) => (e.op === "import" ? e : { ...e, sel: formatSelector(parseSelector(e.sel, scope)) }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------- mode, which is a play row and not a document field ----------

function isModeEdit(edit: { op: string; sel?: string }): boolean {
  return edit.sel?.trim() === "mode";
}

function modeRefusal(ctx: ToolContext, row: PlayRow, edit: Edit): string | null {
  if (edit.op !== "set") return `mode is set, not ${edit.op}ed: {op: "set", sel: "mode", value: "open"}`;
  if (ctx.principal.role === "public") return "anonymous callers cannot change a play's mode";
  if (row.creator !== ctx.principal.id) return `only ${row.creator}, who created this play, can change its mode`;
  if (edit.value !== "open" && edit.value !== "closed") return `mode is "open" or "closed"`;
  return null;
}

// ---------- a contour and its note are written together (spec §1.5) ----------

interface Writes {
  /** Parts whose `path` this edit writes. */
  paths: { key: string; puppet: string; part: string }[];
  /** Note keys this edit writes: `<puppet>` or `<puppet>.<part>`. */
  notes: string[];
  /** Puppets this edit writes whole, and whether the value carries a note. */
  puppets: { id: string; note: boolean }[];
}

/**
 * The Milestone-2 rule the tools layer owns: an edit_cast batch that writes a
 * part's contour must write that part's note too, and a new puppet needs a
 * note. Parts that only mirror another need neither. Returns the first
 * offending edit, or null.
 */
function missingNote(doc: Play, batch: Edit[], scope: Scope): { index: number; reason: string } | null {
  const perEdit = batch.map((e) => castWrites(e, scope));
  const notes = new Set(perEdit.flatMap((w) => w.notes));
  for (let i = 0; i < perEdit.length; i++) {
    for (const p of perEdit[i].paths) {
      if (notes.has(p.key)) continue;
      return {
        index: i,
        reason: `cast.${p.puppet}.parts.${p.part}: a contour and its note are written together — say what the shape is in '${p.part}.note' in this same call`,
      };
    }
    for (const pup of perEdit[i].puppets) {
      if (pup.note || notes.has(pup.id) || pup.id in doc.cast) continue;
      return { index: i, reason: `cast.${pup.id}: a new puppet needs a 'note' saying what it is` };
    }
  }
  return null;
}

function castWrites(edit: Edit, scope: Scope): Writes {
  const w: Writes = { paths: [], notes: [], puppets: [] };
  if (edit.op !== "set" && edit.op !== "insert") return w;
  let steps: Step[];
  try {
    steps = parseSelector(edit.sel, scope);
  } catch {
    return w; // applyEdits reports the bad selector, with its index
  }
  const puppet = steps.find((s) => s.kind === "puppet")?.id;
  const part = steps.find((s) => s.kind === "part")?.id;
  const last = steps[steps.length - 1];
  if (!last) return w;
  if (last.kind === "puppet") {
    addPuppet(w, last.id, edit.value);
  } else if (last.kind === "part" && puppet) {
    addPart(w, puppet, edit.value, last.id);
  } else if (last.kind === "prop" && last.name === "cast") {
    if (edit.op === "insert") addPuppet(w, idOf(edit.value), edit.value);
    else for (const [id, v] of Object.entries(asRecord(edit.value) ?? {})) addPuppet(w, id, v);
  } else if (last.kind === "prop" && puppet) {
    if (last.name === "path" && part) w.paths.push({ key: `${puppet}.${part}`, puppet, part });
    else if (last.name === "note") w.notes.push(part ? `${puppet}.${part}` : puppet);
    else if (last.name === "parts") {
      const value = edit.value;
      for (const p of Array.isArray(value) ? value : [value]) addPart(w, puppet, p);
    }
  }
  return w;
}

function addPuppet(w: Writes, id: string | undefined, value: unknown): void {
  const v = asRecord(value);
  if (!id || !v) return;
  w.puppets.push({ id, note: typeof v.note === "string" });
  if (typeof v.note === "string") w.notes.push(id);
  for (const p of Array.isArray(v.parts) ? v.parts : []) addPart(w, id, p);
}

function addPart(w: Writes, puppet: string, value: unknown, id?: string): void {
  const v = asRecord(value);
  const part = id ?? idOf(value);
  if (!v || !part) return;
  if (typeof v.path === "string") w.paths.push({ key: `${puppet}.${part}`, puppet, part });
  if (typeof v.note === "string") w.notes.push(`${puppet}.${part}`);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

function idOf(v: unknown): string | undefined {
  const r = asRecord(v);
  return typeof r?.id === "string" ? r.id : undefined;
}
