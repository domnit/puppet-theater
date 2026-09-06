// The six tools over an in-memory store: batch atomicity, the version
// bookkeeping, who may edit what, and the contour-and-note rule. The
// projection itself is read.ts's business and is tested there; here we only
// check that a read reflects what an edit did.

import { describe, expect, test } from "bun:test";
import { createImportResolver } from "../src/doc/library";
import { openStore, type Store } from "../src/store/db";
import {
  create_play, edit_cast, edit_play, edit_scene, list_plays, read_play,
  ToolError, type Principal, type ToolContext,
} from "../src/tools";
import { BOX } from "./helpers";

const AUTHOR: Principal = { id: "u_author", role: "user" };
const STRANGER: Principal = { id: "u_other", role: "user" };
const ANON: Principal = { id: "public", role: "public" };

function ctxFor(store: Store, principal: Principal): ToolContext {
  return {
    store,
    principal,
    baseUrl: "http://theater.test",
    imports: createImportResolver({ puppets: [], parts: [], play: (id) => store.getPlay(id) }),
    libraryIndex: [],
  };
}

function fresh(principal: Principal = AUTHOR): { store: Store; ctx: ToolContext } {
  const store = openStore(":memory:");
  return { store, ctx: ctxFor(store, principal) };
}

const FOX = {
  id: "fox",
  unit: 100,
  cap: 2,
  note: "a lean fox, low-slung and wary",
  parts: [{ id: "torso", parent: null, pivot: [0, 0], z: 0, note: "long low body", path: BOX }],
};

/** A play with a fox, one scene, and one beat holding one keyframe. */
function staged(ctx: ToolContext): string {
  const { play_id } = create_play(ctx, { title: "Fox and Lamp" });
  edit_cast(ctx, { play_id, edits: [{ op: "insert", sel: "", value: FOX }] });
  edit_play(ctx, { play_id, edits: [{ op: "insert", sel: "scenes", value: { id: "s1", title: "The lamp is lit", beats: [] } }] });
  edit_scene(ctx, {
    play_id,
    scene_id: "s1",
    edits: [
      {
        op: "insert",
        sel: "beats",
        value: { id: "b1", label: "she waits", length: 4, tracks: { fox: [{ at: 0, pose: { joints: { torso: 0 }, root: { x: 0.5, y: 0.55 } } }] } },
      },
    ],
  });
  return play_id;
}

describe("create and read", () => {
  test("a new play round-trips through read_play", () => {
    const { ctx } = fresh();
    const made = create_play(ctx, { title: "Fox and Lamp" });
    expect(made.play_id).toMatch(/^pl_/);
    expect(made.url).toBe(`http://theater.test/p/${made.play_id}`);
    expect(made.version).toBe(1);

    const read = read_play(ctx, { play_id: made.play_id });
    expect(read.title).toBe("Fox and Lamp");
    expect(read.version).toBe(1);
    expect(read.mode).toBe("open");
    expect(read.scenes).toEqual([]);
  });

  test("read_play refuses an unknown play with a 404", () => {
    const { ctx } = fresh();
    expect(() => read_play(ctx, { play_id: "pl_nope" })).toThrow(ToolError);
  });

  test("public may create an open play but not a closed one", () => {
    const { store } = fresh();
    const ctx = ctxFor(store, ANON);
    expect(create_play(ctx, {}).version).toBe(1);
    expect(() => create_play(ctx, { mode: "closed" })).toThrow(/only create open/);
  });

  test("list_plays reports the cast and honours `mine`", () => {
    const { store, ctx } = fresh();
    const play_id = staged(ctx);
    create_play(ctxFor(store, STRANGER), { title: "Someone else's" });

    const all = list_plays(ctx, {});
    expect(all.plays.map((p) => p.id)).toContain(play_id);
    const mine = list_plays(ctx, { mine: true });
    expect(mine.plays).toHaveLength(1);
    expect(mine.plays[0].cast).toEqual(["fox"]);
    expect(mine.plays[0].url).toBe(`http://theater.test/p/${play_id}`);
  });
});

describe("editing", () => {
  test("edit_scene writes one joint and the version moves by one", () => {
    const { store, ctx } = fresh();
    const play_id = staged(ctx);
    const before = store.getPlay(play_id)!.version;

    const res = edit_scene(ctx, { play_id, scene_id: "s1", edits: [{ op: "set", sel: "b1:fox@0.joints.torso", value: 15 }] });
    expect(res.rejected).toEqual([]);
    expect(res.version).toBe(before + 1);

    const key = read_play(ctx, { play_id, sel: "s1/b1:fox@0" }) as { pose: { joints: Record<string, number> } };
    expect(key.pose.joints.torso).toBe(15);
  });

  test("stored edits carry play-absolute selectors", () => {
    const { store, ctx } = fresh();
    const play_id = staged(ctx);
    edit_scene(ctx, { play_id, scene_id: "s1", edits: [{ op: "nudge", sel: "b1:fox@*.joints.torso", delta: -18 }] });

    const last = store.listVersions(play_id).at(-1)!;
    expect(last.edits).toEqual([{ op: "nudge", sel: "s1/b1:fox@*.joints.torso", delta: -18 }]);
    expect(last.scope).toEqual(["scene:s1"]);
  });

  test("a rejected batch names the index and commits nothing", () => {
    const { store, ctx } = fresh();
    const play_id = staged(ctx);
    const before = store.getPlay(play_id)!;

    const res = edit_play(ctx, {
      play_id,
      edits: [
        { op: "set", sel: "title", value: "Renamed" },
        { op: "remove", sel: "s9" },
      ],
    });
    expect(res.version).toBe(before.version);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].index).toBe(1);
    expect(res.rejected[0].op).toBe("remove");
    expect(res.rejected[0].sel).toBe("s9");
    expect(store.getPlay(play_id)!.doc.title).toBe(before.doc.title);
  });

  test("an edit against a stale version is refused with index -1", () => {
    const { ctx } = fresh();
    const play_id = staged(ctx);
    const first = edit_play(ctx, { play_id, edits: [{ op: "set", sel: "title", value: "One" }] });
    const stale = edit_play(ctx, { play_id, edits: [{ op: "set", sel: "title", value: "Two" }], version: first.version - 1 });

    expect(stale.rejected).toHaveLength(1);
    expect(stale.rejected[0].index).toBe(-1);
    expect(stale.rejected[0].reason).toMatch(/^stale: head is /);
    expect(read_play(ctx, { play_id }).title).toBe("One");
  });

  test("a fresh version passes the same check", () => {
    const { ctx } = fresh();
    const play_id = staged(ctx);
    const first = edit_play(ctx, { play_id, edits: [{ op: "set", sel: "title", value: "One" }] });
    const second = edit_play(ctx, { play_id, edits: [{ op: "set", sel: "title", value: "Two" }], version: first.version });
    expect(second.rejected).toEqual([]);
  });
});

describe("access", () => {
  test("a closed play refuses a stranger and admits its creator", () => {
    const { store, ctx } = fresh();
    const { play_id } = create_play(ctx, { title: "Mine", mode: "closed" });

    const rename = { play_id, edits: [{ op: "set" as const, sel: "title", value: "Renamed" }] };
    expect(() => edit_play(ctxFor(store, STRANGER), rename)).toThrow(/closed/);
    expect(edit_play(ctx, rename).rejected).toEqual([]);
  });

  test("only the creator changes mode, and never public", () => {
    const { store, ctx } = fresh();
    const play_id = staged(ctx);
    const setClosed = { play_id, edits: [{ op: "set" as const, sel: "mode", value: "closed" }] };

    expect(edit_play(ctxFor(store, STRANGER), setClosed).rejected[0].reason).toMatch(/created this play/);
    expect(edit_play(ctxFor(store, ANON), setClosed).rejected[0].reason).toMatch(/[Aa]nonymous/);
    expect(read_play(ctx, { play_id }).mode).toBe("open");
  });

  test("a mode change by the creator shows up in the next read", () => {
    const { store, ctx } = fresh();
    const play_id = staged(ctx);
    const head = store.getPlay(play_id)!.version;

    const res = edit_play(ctx, { play_id, edits: [{ op: "set", sel: "mode", value: "closed" }] });
    expect(res.rejected).toEqual([]);
    // mode is a play row, not a document field: nothing to version.
    expect(res.version).toBe(head);
    expect(read_play(ctx, { play_id }).mode).toBe("closed");
  });

  test("mode travels with the rest of its batch", () => {
    const { ctx } = fresh();
    const play_id = staged(ctx);
    const res = edit_play(ctx, {
      play_id,
      edits: [
        { op: "set", sel: "mode", value: "closed" },
        { op: "set", sel: "title", value: "Shut" },
      ],
    });
    expect(res.rejected).toEqual([]);
    const read = read_play(ctx, { play_id });
    expect(read.mode).toBe("closed");
    expect(read.title).toBe("Shut");
  });
});

describe("a contour and its note are written together", () => {
  test("a path with no note is rejected, naming the edit", () => {
    const { ctx } = fresh();
    const play_id = staged(ctx);
    const res = edit_cast(ctx, {
      play_id,
      puppet_id: "fox",
      edits: [{ op: "set", sel: "parts.torso.path", value: "M0,0 L10,0 L10,20 Z" }],
    });
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].index).toBe(0);
    expect(res.rejected[0].reason).toMatch(/note/);
  });

  test("the note may be a separate edit in the same batch", () => {
    const { ctx } = fresh();
    const play_id = staged(ctx);
    const res = edit_cast(ctx, {
      play_id,
      puppet_id: "fox",
      edits: [
        { op: "set", sel: "parts.torso.path", value: "M0,0 L10,0 L10,20 Z" },
        { op: "set", sel: "parts.torso.note", value: "a blunter body" },
      ],
    });
    expect(res.rejected).toEqual([]);
  });

  test("a mirrored part needs no note of its own", () => {
    const { ctx } = fresh();
    const play_id = staged(ctx);
    const res = edit_cast(ctx, {
      play_id,
      puppet_id: "fox",
      edits: [{ op: "insert", sel: "parts", value: { id: "torso_r", parent: "torso", pivot: [4, 2], mirrorOf: "torso" } }],
    });
    expect(res.rejected).toEqual([]);
  });

  test("a new puppet needs a note", () => {
    const { ctx } = fresh();
    const play_id = staged(ctx);
    const { note: _drop, ...mute } = FOX;
    const res = edit_cast(ctx, { play_id, edits: [{ op: "insert", sel: "", value: { ...mute, id: "heron" } }] });
    expect(res.rejected[0].reason).toMatch(/needs a 'note'/);
  });

  test("inserting a puppet puts it in the cast a read reports", () => {
    const { ctx } = fresh();
    const { play_id } = create_play(ctx, { title: "Empty" });
    const res = edit_cast(ctx, { play_id, edits: [{ op: "insert", sel: "", value: FOX }] });
    expect(res.rejected).toEqual([]);

    const read = read_play(ctx, { play_id, depth: "play" }) as { cast: { id: string; note?: string }[] };
    expect(read.cast.map((p) => p.id)).toEqual(["fox"]);
    expect(read.cast[0].note).toMatch(/lean fox/);
  });
});
