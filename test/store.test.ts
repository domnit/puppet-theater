// Unit tests for the SQLite store: create/commit round-trips, the per-scope
// stale-commit rule, listing filters, users, and the chat ledger. All on
// `:memory:` stores.

import { describe, expect, test } from "bun:test";
import { openStore, StaleError, type Store } from "../src/store/db";
import type { Play } from "../src/model/types";

function fresh(): Store {
  return openStore(":memory:");
}

function doc(title = "Untitled"): Play {
  return { id: "pl_x", schemaVersion: 1, title, meta: {}, stage: { tempo: 96 }, cast: {}, scenes: [] };
}

describe("create and get", () => {
  test("createPlay writes version 1 with the seed doc", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc("Fox and Lamp") });
    expect(row.id).toMatch(/^pl_[a-z2-9]{6}$/);
    expect(row.headVersion).toBe(1);
    expect(row.title).toBe("Fox and Lamp");

    const got = store.getPlay(row.id);
    expect(got).not.toBeNull();
    expect(got!.version).toBe(1);
    expect(got!.doc.title).toBe("Fox and Lamp");

    const v1 = store.getVersion(row.id, 1);
    expect(v1).not.toBeNull();
    expect(v1!.edits).toEqual([]);
    expect(v1!.scope).toEqual(["play"]);
  });

  test("getPlay and getVersion return null for unknown ids", () => {
    const store = fresh();
    expect(store.getPlay("pl_nope")).toBeNull();
    expect(store.getVersion("pl_nope", 1)).toBeNull();
  });
});

describe("commit", () => {
  test("increments head and appends a version", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc() });
    const { version } = store.commit({
      playId: row.id,
      doc: doc("Renamed"),
      edits: [{ op: "set", sel: "title", value: "Renamed" }],
      touched: ["play"],
      author: "public",
      base: 1,
    });
    expect(version).toBe(2);
    const play = store.getPlay(row.id)!;
    expect(play.version).toBe(2);
    expect(play.row.headVersion).toBe(2);
    expect(play.row.title).toBe("Renamed");
    expect(store.listVersions(row.id).length).toBe(2);
  });

  test("versions are append-only: an earlier version is unchanged by later commits", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc("Original") });
    store.commit({ playId: row.id, doc: doc("Changed"), edits: [], touched: ["scene:s1"], author: "public", base: 1 });
    store.commit({ playId: row.id, doc: doc("Changed again"), edits: [], touched: ["scene:s2"], author: "public", base: 2 });
    const v1 = store.getVersion(row.id, 1)!;
    expect(v1.doc.title).toBe("Original");
    const v2 = store.getVersion(row.id, 2)!;
    expect(v2.doc.title).toBe("Changed");
  });

  test("a fresh commit (no base) is never stale", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc() });
    store.commit({ playId: row.id, doc: doc("A"), edits: [], touched: ["scene:s1"], author: "public" });
    expect(store.getPlay(row.id)!.version).toBe(2);
  });

  test("disjoint scopes on a stale base succeed", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc() });
    // v2 touches scene:s1; a batch computed against base 1 that only touches
    // scene:s2 does not overlap, so it should still land as v3.
    store.commit({ playId: row.id, doc: doc(), edits: [], touched: ["scene:s1"], author: "a", base: 1 });
    const { version } = store.commit({
      playId: row.id,
      doc: doc(),
      edits: [],
      touched: ["scene:s2"],
      author: "b",
      base: 1,
    });
    expect(version).toBe(3);
  });

  test("overlapping scopes reject with StaleError", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc() });
    store.commit({ playId: row.id, doc: doc(), edits: [], touched: ["scene:s1"], author: "a", base: 1 });
    let caught: unknown;
    try {
      store.commit({ playId: row.id, doc: doc(), edits: [], touched: ["scene:s1"], author: "b", base: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleError);
    const err = caught as StaleError;
    expect(err.head).toBe(2);
    expect(err.conflicts).toEqual([{ n: 2, scope: ["scene:s1"] }]);
    expect(err.message).toBe("stale: head is 2, you edited against 1; version 2 touched scene:s1");
    // rejected batch commits nothing
    expect(store.getPlay(row.id)!.version).toBe(2);
  });

  test("a version that touched \"cast\" always conflicts, even with a disjoint batch", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc() });
    store.commit({ playId: row.id, doc: doc(), edits: [], touched: ["cast"], author: "a", base: 1 });
    expect(() =>
      store.commit({ playId: row.id, doc: doc(), edits: [], touched: ["scene:s9"], author: "b", base: 1 }),
    ).toThrow(StaleError);
  });

  test("a batch that touches \"play\" always conflicts, even against a disjoint version", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc() });
    store.commit({ playId: row.id, doc: doc(), edits: [], touched: ["scene:s1"], author: "a", base: 1 });
    expect(() =>
      store.commit({ playId: row.id, doc: doc(), edits: [], touched: ["play"], author: "b", base: 1 }),
    ).toThrow(StaleError);
  });

  test("onCommit fires after the transaction with the commit payload", () => {
    const store = fresh();
    const row = store.createPlay({ creator: "public", mode: "open", doc: doc() });
    const events: unknown[] = [];
    const unsub = store.onCommit((e) => events.push(e));
    store.commit({ playId: row.id, doc: doc("X"), edits: [{ op: "set", sel: "title", value: "X" }], touched: ["play"], author: "public", base: 1 });
    expect(events).toEqual([
      { playId: row.id, version: 2, doc: doc("X"), edits: [{ op: "set", sel: "title", value: "X" }], touched: ["play"], author: "public" },
    ]);
    unsub();
    store.commit({ playId: row.id, doc: doc("Y"), edits: [], touched: ["scene:s1"], author: "public", base: 2 });
    expect(events.length).toBe(1); // unsubscribed, no second event
  });
});

describe("listPlays", () => {
  function seeded(): { store: Store; foxId: string; heronId: string } {
    const store = fresh();
    const foxId = store.createPlay({ creator: "alice", mode: "open", doc: doc("Fox and Lamp") }).id;
    const heronId = store.createPlay({ creator: "bob", mode: "closed", doc: doc("Heron's Bridge") }).id;
    return { store, foxId, heronId };
  }

  test("query matches title or id, case-insensitively", () => {
    const { store, foxId } = seeded();
    const byTitle = store.listPlays({ query: "fox" });
    expect(byTitle.map((p) => p.id)).toEqual([foxId]);
    const byId = store.listPlays({ query: foxId.toUpperCase() });
    expect(byId.map((p) => p.id)).toEqual([foxId]);
  });

  test("creator filters to that user's plays", () => {
    const { store, heronId } = seeded();
    const rows = store.listPlays({ creator: "bob" });
    expect(rows.map((p) => p.id)).toEqual([heronId]);
  });

  test("featured filters plays", () => {
    const { store, foxId } = seeded();
    expect(store.listPlays({ featured: true })).toEqual([]);
    store.setFeatured(foxId, true);
    const rows = store.listPlays({ featured: true });
    expect(rows.map((p) => p.id)).toEqual([foxId]);
    expect(rows[0].featured).toBe(true);
  });
});

describe("users", () => {
  test("the public user is seeded, has no secret, and cannot verify", () => {
    const store = fresh();
    const pub = store.getUser("public");
    expect(pub).not.toBeNull();
    expect(pub!.role).toBe("public");
    expect(store.verifyUser("public", "anything")).toBeNull();
  });

  test("createUser + verifyUser round-trips, and a wrong secret is rejected", () => {
    const store = fresh();
    const { id, secret } = store.createUser({ name: "Alice", role: "user" });
    const verified = store.verifyUser(id, secret);
    expect(verified).not.toBeNull();
    expect(verified!.name).toBe("Alice");
    expect(store.verifyUser(id, "wrong-secret")).toBeNull();
  });

  test("countUsers excludes the seeded public row", () => {
    const store = fresh();
    expect(store.countUsers()).toBe(0);
    store.createUser({ role: "user" });
    expect(store.countUsers()).toBe(1);
  });
});

describe("spend and settings", () => {
  test("recordSpend sums into spendSince, and a later cutoff excludes earlier rows", () => {
    const store = fresh();
    expect(store.spendSince(0)).toEqual({ usd: 0, calls: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
    const entry = { session: "s1", model: "claude-sonnet-5", inputTokens: 100, cacheWriteTokens: 50, cacheReadTokens: 25, outputTokens: 10, usd: 0.001 };
    store.recordSpend(entry);
    store.recordSpend({ ...entry, session: "s2", usd: 0.002 });
    const total = store.spendSince(0);
    expect(total.calls).toBe(2);
    expect(total.usd).toBeCloseTo(0.003, 9);
    expect(total.inputTokens).toBe(200);
    expect(total.cacheWriteTokens).toBe(100);
    expect(total.cacheReadTokens).toBe(50);
    expect(total.outputTokens).toBe(20);
    expect(store.spendSince(Date.now() + 60_000).calls).toBe(0);
  });

  test("settings are absent until set, and setSetting overwrites", () => {
    const store = fresh();
    expect(store.getSetting("chat")).toBeNull();
    store.setSetting("chat", "off");
    expect(store.getSetting("chat")).toBe("off");
    store.setSetting("chat", "on");
    expect(store.getSetting("chat")).toBe("on");
  });
});
