// SQLite document store: users, plays, and an append-only version history.
// Everything is synchronous (bun:sqlite is sync); the `doc`, `edits`, and
// `scope` columns are opaque JSON text as far as this module is concerned —
// it never imports src/doc, which owns their shape.
//
// Concurrency is optimistic per commit: a caller commits against a `base`
// version, and `commit` rejects with StaleError if a version landed since
// that touched an overlapping scope (or either side touched "play"/"cast",
// which invalidate everything).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Play } from "../model/types";

export type Role = "user" | "admin" | "public";
export type Mode = "open" | "closed";

export interface User {
  id: string;
  name: string | null;
  role: Role;
  createdAt: number;
}

export interface PlayRow {
  id: string;
  creator: string;
  mode: Mode;
  featured: boolean;
  headVersion: number;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VersionRow {
  n: number;
  doc: Play;
  edits: unknown;
  scope: string[];
  author: string;
  createdAt: number;
}

export interface VersionSummary {
  n: number;
  author: string;
  scope: string[];
  createdAt: number;
  edits: unknown;
}

export interface CommitEvent {
  playId: string;
  version: number;
  doc: Play;
  edits: unknown;
  touched: string[];
  author: string;
}

export interface Conflict {
  n: number;
  scope: string[];
}

/** Thrown by `commit` when the batch was computed against a stale base. */
export class StaleError extends Error {
  readonly head: number;
  readonly base: number;
  readonly conflicts: Conflict[];
  constructor(head: number, base: number, conflicts: Conflict[]) {
    super(formatStale(head, base, conflicts));
    this.name = "StaleError";
    this.head = head;
    this.base = base;
    this.conflicts = conflicts;
  }
}

function formatStale(head: number, base: number, conflicts: Conflict[]): string {
  const ns = conflicts.map((c) => c.n);
  const contiguous = ns.every((n, i) => i === 0 || n === ns[i - 1] + 1);
  const label =
    ns.length === 1 ? `version ${ns[0]}` : contiguous ? `versions ${ns[0]}-${ns[ns.length - 1]}` : `versions ${ns.join(",")}`;
  const scopes = [...new Set(conflicts.flatMap((c) => c.scope))].join(", ");
  return `stale: head is ${head}, you edited against ${base}; ${label} touched ${scopes}`;
}

export interface Store {
  createUser(args: { id?: string; name?: string; role: Role }): { id: string; secret: string };
  verifyUser(id: string, secret: string): User | null;
  getUser(id: string): User | null;
  countUsers(): number;
  createPlay(args: { creator: string; mode: Mode; doc: Play }): PlayRow;
  getPlay(id: string): { row: PlayRow; doc: Play; version: number } | null;
  getVersion(id: string, n: number): VersionRow | null;
  listVersions(id: string): VersionSummary[];
  commit(args: { playId: string; doc: Play; edits: unknown; touched: string[]; author: string; base?: number }): { version: number };
  setMode(id: string, mode: Mode): void;
  setFeatured(id: string, featured: boolean): void;
  listPlays(args?: { query?: string; creator?: string; featured?: boolean; limit?: number }): PlayRow[];
  onCommit(cb: (e: CommitEvent) => void): () => void;
  close(): void;
}

// Ids: lowercase, no ambiguous glyphs (no 0/1/i/l/o).
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomId(prefix: string, len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}${s}`;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

function hashSecret(secret: string, salt: string): string {
  return new Bun.CryptoHasher("sha256").update(salt).update(secret).digest("hex");
}

interface UserRowRaw {
  id: string;
  name: string | null;
  secret_hash: string | null;
  role: Role;
  created_at: number;
}

interface PlayRowRaw {
  id: string;
  creator: string;
  mode: Mode;
  featured: number;
  head_version: number;
  title: string | null;
  created_at: number;
  updated_at: number;
}

interface VersionRowRaw {
  play_id: string;
  n: number;
  doc: string;
  edits: string;
  scope: string;
  author: string;
  created_at: number;
}

function toUser(r: UserRowRaw): User {
  return { id: r.id, name: r.name, role: r.role, createdAt: r.created_at };
}

function toPlayRow(r: PlayRowRaw): PlayRow {
  return {
    id: r.id,
    creator: r.creator,
    mode: r.mode,
    featured: r.featured !== 0,
    headVersion: r.head_version,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toVersionRow(r: VersionRowRaw): VersionRow {
  return {
    n: r.n,
    doc: JSON.parse(r.doc),
    edits: JSON.parse(r.edits),
    scope: JSON.parse(r.scope),
    author: r.author,
    createdAt: r.created_at,
  };
}

export function openStore(path?: string): Store {
  const file = path ?? process.env.PUPPER_DB ?? "data/theater.sqlite";
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      secret_hash TEXT,
      role TEXT NOT NULL CHECK(role IN ('user','admin','public')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plays (
      id TEXT PRIMARY KEY,
      creator TEXT REFERENCES users(id),
      mode TEXT NOT NULL CHECK(mode IN ('open','closed')),
      featured INTEGER NOT NULL DEFAULT 0,
      head_version INTEGER NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      play_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      doc TEXT NOT NULL,
      edits TEXT NOT NULL,
      scope TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(play_id, n)
    );
  `);
  db.query(
    "INSERT OR IGNORE INTO users (id, name, secret_hash, role, created_at) VALUES ('public', 'public', NULL, 'public', ?)",
  ).run(Date.now());

  const listeners = new Set<(e: CommitEvent) => void>();

  const insertUser = db.query(
    "INSERT INTO users (id, name, secret_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const selectUser = db.query("SELECT * FROM users WHERE id = ?");
  const selectUserCount = db.query("SELECT COUNT(*) as c FROM users WHERE role != 'public'");

  const insertPlay = db.query(
    "INSERT INTO plays (id, creator, mode, featured, head_version, title, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?)",
  );
  const selectPlay = db.query("SELECT * FROM plays WHERE id = ?");
  const updatePlayHead = db.query(
    "UPDATE plays SET head_version = ?, title = ?, updated_at = ? WHERE id = ?",
  );
  const updatePlayMode = db.query("UPDATE plays SET mode = ?, updated_at = ? WHERE id = ?");
  const updatePlayFeatured = db.query("UPDATE plays SET featured = ? WHERE id = ?");

  const insertVersion = db.query(
    "INSERT INTO versions (play_id, n, doc, edits, scope, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectVersion = db.query("SELECT * FROM versions WHERE play_id = ? AND n = ?");
  const selectVersionsInRange = db.query(
    "SELECT * FROM versions WHERE play_id = ? AND n > ? AND n <= ? ORDER BY n ASC",
  );
  const selectVersionSummaries = db.query(
    "SELECT n, edits, scope, author, created_at FROM versions WHERE play_id = ? ORDER BY n ASC",
  );

  function getPlayRowRaw(id: string): PlayRowRaw | null {
    return (selectPlay.get(id) as PlayRowRaw | null) ?? null;
  }

  const commitTx = db.transaction(
    (args: { playId: string; doc: Play; edits: unknown; touched: string[]; author: string; base?: number }) => {
      const row = getPlayRowRaw(args.playId);
      if (!row) throw new Error(`no such play: ${args.playId}`);
      const head = row.head_version;
      if (args.base !== undefined && args.base < head) {
        const inRange = selectVersionsInRange.all(args.playId, args.base, head) as VersionRowRaw[];
        const touchedHasGlobal = args.touched.includes("play") || args.touched.includes("cast");
        const conflicts: Conflict[] = [];
        for (const v of inRange) {
          const scope: string[] = JSON.parse(v.scope);
          const conflicting =
            touchedHasGlobal ||
            scope.includes("play") ||
            scope.includes("cast") ||
            scope.some((s) => args.touched.includes(s));
          if (conflicting) conflicts.push({ n: v.n, scope });
        }
        if (conflicts.length > 0) throw new StaleError(head, args.base, conflicts);
      }
      const n = head + 1;
      const now = Date.now();
      insertVersion.run(
        args.playId,
        n,
        JSON.stringify(args.doc),
        JSON.stringify(args.edits),
        JSON.stringify(args.touched),
        args.author,
        now,
      );
      updatePlayHead.run(n, args.doc.title ?? null, now, args.playId);
      return n;
    },
  );

  return {
    createUser({ id, name, role }) {
      const uid = id ?? randomId("u_", 8);
      const secret = randomSecret();
      const salt = randomSalt();
      insertUser.run(uid, name ?? null, `${salt}:${hashSecret(secret, salt)}`, role, Date.now());
      return { id: uid, secret };
    },

    verifyUser(id, secret) {
      const row = selectUser.get(id) as UserRowRaw | null;
      if (!row || !row.secret_hash) return null;
      const [salt, hash] = row.secret_hash.split(":");
      if (hashSecret(secret, salt) !== hash) return null;
      return toUser(row);
    },

    getUser(id) {
      const row = selectUser.get(id) as UserRowRaw | null;
      return row ? toUser(row) : null;
    },

    countUsers() {
      return (selectUserCount.get() as { c: number }).c;
    },

    createPlay({ creator, mode, doc }) {
      const id = randomId("pl_", 6);
      const now = Date.now();
      doc = { ...doc, id };
      db.transaction(() => {
        insertPlay.run(id, creator, mode, doc.title ?? null, now, now);
        insertVersion.run(id, 1, JSON.stringify(doc), JSON.stringify([]), JSON.stringify(["play"]), creator, now);
      })();
      return toPlayRow(getPlayRowRaw(id)!);
    },

    getPlay(id) {
      const row = getPlayRowRaw(id);
      if (!row) return null;
      const v = selectVersion.get(id, row.head_version) as VersionRowRaw | null;
      if (!v) return null;
      return { row: toPlayRow(row), doc: JSON.parse(v.doc), version: row.head_version };
    },

    getVersion(id, n) {
      const v = selectVersion.get(id, n) as VersionRowRaw | null;
      return v ? toVersionRow(v) : null;
    },

    listVersions(id) {
      const rows = selectVersionSummaries.all(id) as Omit<VersionRowRaw, "doc" | "play_id">[];
      return rows.map((r) => ({
        n: r.n,
        author: r.author,
        scope: JSON.parse(r.scope),
        createdAt: r.created_at,
        edits: JSON.parse(r.edits),
      }));
    },

    commit(args) {
      const n = commitTx(args);
      const event: CommitEvent = {
        playId: args.playId,
        version: n,
        doc: args.doc,
        edits: args.edits,
        touched: args.touched,
        author: args.author,
      };
      for (const cb of listeners) cb(event);
      return { version: n };
    },

    setMode(id, mode) {
      updatePlayMode.run(mode, Date.now(), id);
    },

    setFeatured(id, featured) {
      updatePlayFeatured.run(featured ? 1 : 0, id);
    },

    listPlays(args = {}) {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (args.query) {
        clauses.push("(LOWER(title) LIKE ? OR LOWER(id) LIKE ?)");
        const needle = `%${args.query.toLowerCase()}%`;
        params.push(needle, needle);
      }
      if (args.creator) {
        clauses.push("creator = ?");
        params.push(args.creator);
      }
      if (args.featured !== undefined) {
        clauses.push("featured = ?");
        params.push(args.featured ? 1 : 0);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(args.limit ?? 100);
      const rows = db
        .query(`SELECT * FROM plays ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params) as PlayRowRaw[];
      return rows.map(toPlayRow);
    },

    onCommit(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    close() {
      db.close();
    },
  };
}
