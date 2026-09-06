import { describe, expect, test } from "bun:test";
import { EditError, applyAndValidate, applyEdits, editsSummary, type Edit, type Scope } from "../src/doc/edit";
import { PlaySchema, type Play } from "../src/model/types";
import { BOX } from "./helpers";

const fox = {
  id: "fox", unit: 100, cap: 2, note: "a fox", restPose: { head: -4 },
  parts: [
    { id: "torso", parent: null, pivot: [0, 0], path: BOX },
    { id: "head", parent: "torso", pivot: [0, 20], path: BOX },
    { id: "ear", parent: "head", pivot: [0, 2], path: BOX },
  ],
};

const base = (): Play =>
  PlaySchema.parse({
    id: "p", schemaVersion: 1, title: "T", stage: { tempo: 96 },
    cast: { fox },
    scenes: [{
      id: "s1", title: "one", beats: [
        {
          id: "b1", length: 2,
          tracks: { fox: [
            { at: 0, pose: { joints: { head: 10 }, root: { x: 0.2 } } },
            { at: 1, pose: { joints: { head: 20 } } },
          ] },
          fx: [{ at: 0.5, type: "lamp", to: 0.3 }],
        },
        { id: "b2", length: 1, tracks: { fox: [{ at: 0, pose: { root: { x: 0.5 } } }] } },
      ],
    }],
  });

const run = (edits: Edit[], scope: Scope = { kind: "play" }) => applyEdits(base(), edits, scope).doc;
const keys = (doc: Play, beat = 0) => doc.scenes[0].beats[beat].tracks!.fox;

function fails(edits: Edit[], re: RegExp, index = 0, scope: Scope = { kind: "play" }) {
  let err: unknown;
  try {
    applyEdits(base(), edits, scope);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EditError);
  expect((err as EditError).index).toBe(index);
  expect((err as Error).message).toMatch(re);
}

describe("set", () => {
  test("writes a leaf, leaving the input document alone", () => {
    const doc0 = base();
    const doc = applyEdits(doc0, [{ op: "set", sel: "s1/b1:fox@0.joints.head", value: -12 }]).doc;
    expect(keys(doc)[0].pose.joints!.head).toBe(-12);
    expect(keys(doc0)[0].pose.joints!.head).toBe(10);
  });

  test("upserts an absent leaf", () => {
    const doc = run([{ op: "set", sel: "s1/b1:fox@1.root.y", value: 0.8 }]);
    expect(keys(doc)[1].pose.root!.y).toBe(0.8);
    expect(run([{ op: "set", sel: "cast.fox.look.idle", value: 0.5 }]).cast.fox.look!.idle).toBe(0.5);
  });

  test("appends an absent beat, with the id from the selector", () => {
    const doc = run([{ op: "set", sel: "s1/b9", value: { id: "ignored", length: 3 } }]);
    expect(doc.scenes[0].beats.map((b) => b.id)).toEqual(["b1", "b2", "b9"]);
    expect(doc.scenes[0].beats[2].length).toBe(3);
  });

  test("inserts an absent keyframe in `at` order", () => {
    const doc = run([{ op: "set", sel: "s1/b1:fox@0.5", value: { pose: { joints: { head: 15 } } } }]);
    expect(keys(doc).map((k) => k.at)).toEqual([0, 0.5, 1]);
  });

  test("creates a track that does not exist yet", () => {
    const doc = run([{ op: "set", sel: "s1/b1:heron@0", value: { pose: {} } }]);
    expect(Object.keys(doc.scenes[0].beats[0].tracks!)).toEqual(["fox", "heron"]);
  });

  test("@* writes on every key in the track", () => {
    const doc = run([{ op: "set", sel: "s1/b1:fox@*.joints.head", value: 0 }]);
    expect(keys(doc).map((k) => k.pose.joints!.head)).toEqual([0, 0]);
  });

  test("a number field will not take something else", () => {
    fails([{ op: "set", sel: "s1/b1.length", value: "long" }], /expected a number/);
    fails([{ op: "set", sel: "s1/b9", value: 3 }], /expected an object/);
  });
});

describe("insert", () => {
  const beat = { id: "b1a", length: 1 };

  test("`after` anchors by id; omitted appends, empty prepends", () => {
    const ids = (e: Edit) => run([e]).scenes[0].beats.map((b) => b.id);
    expect(ids({ op: "insert", sel: "s1/beats", value: beat })).toEqual(["b1", "b2", "b1a"]);
    expect(ids({ op: "insert", sel: "s1/beats", value: beat, after: "b1" })).toEqual(["b1", "b1a", "b2"]);
    expect(ids({ op: "insert", sel: "s1/beats", value: beat, after: "" })).toEqual(["b1a", "b1", "b2"]);
  });

  test("an at-ordered list takes its position from `at`", () => {
    const doc = run([
      { op: "insert", sel: "s1/b1:fox", value: { at: 0.5, pose: {} }, after: "b1" },
      { op: "insert", sel: "s1/b1.fx", value: { at: 0.1, type: "lamp", to: 1 } },
    ]);
    expect(keys(doc).map((k) => k.at)).toEqual([0, 0.5, 1]);
    expect(doc.scenes[0].beats[0].fx!.map((c) => c.at)).toEqual([0.1, 0.5]);
  });

  test("a puppet goes into the cast map by its own id", () => {
    const doc = run([{ op: "insert", sel: "cast", value: { ...fox, id: "vixen" } }]);
    expect(Object.keys(doc.cast)).toEqual(["fox", "vixen"]);
  });

  test("inserting over something that exists is an error", () => {
    fails([{ op: "insert", sel: "s1/beats", value: { id: "b2", length: 1 } }], /'b2' already exists/);
    fails([{ op: "insert", sel: "s1/b1:fox", value: { at: 0, pose: {} } }], /already at 0/);
    fails([{ op: "insert", sel: "cast", value: fox }], /'fox' already exists/);
  });

  test("the value must be an object that carries what the list is keyed by", () => {
    fails([{ op: "insert", sel: "s1/beats", value: [1, 2] }], /must be an object/);
    fails([{ op: "insert", sel: "s1/beats", value: { length: 1 } }], /needs an `id`/);
    fails([{ op: "insert", sel: "s1/b1:fox", value: { pose: {} } }], /needs a numeric `at`/);
    fails([{ op: "insert", sel: "s1/beats", value: beat, after: "b7" }], /no 'b7' to insert after/);
  });
});

describe("remove", () => {
  test("takes out a keyframe, a cue, a track", () => {
    expect(keys(run([{ op: "remove", sel: "s1/b1:fox@1" }])).map((k) => k.at)).toEqual([0]);
    expect(run([{ op: "remove", sel: "s1/b1.fx@0.5" }]).scenes[0].beats[0].fx).toEqual([]);
    expect(run([{ op: "remove", sel: "s1/b1:fox" }]).scenes[0].beats[0].tracks).toEqual({});
  });

  test("@* clears the track without removing it", () => {
    const doc = run([{ op: "remove", sel: "s1/b1:fox@*" }]);
    expect(doc.scenes[0].beats[0].tracks!.fox).toEqual([]);
  });

  test("removing a part removes its subtree", () => {
    const doc = run([{ op: "remove", sel: "cast.fox.parts.head" }]);
    expect(doc.cast.fox.parts.map((p) => p.id)).toEqual(["torso"]);
  });

  test("removing a puppet removes its tracks everywhere", () => {
    const doc = run([{ op: "remove", sel: "cast.fox" }]);
    expect(doc.cast).toEqual({});
    expect(doc.scenes[0].beats.map((b) => b.tracks)).toEqual([{}, {}]);
  });

  test("removing something absent is an error", () => {
    fails([{ op: "remove", sel: "s1/b1:fox@7" }], /nothing to remove/);
    fails([{ op: "remove", sel: "cast.fox.parts.tail" }], /nothing to remove/);
  });

  test("required fields cannot be removed", () => {
    fails([{ op: "remove", sel: "title" }], /required/);
    fails([{ op: "remove", sel: "stage.tempo" }], /required/);
    fails([{ op: "remove", sel: "s1/b1.length" }], /required/);
    expect(run([{ op: "remove", sel: "s1.title" }, { op: "remove", sel: "cast.fox.note" }]).cast.fox.note)
      .toBeUndefined();
  });
});

describe("nudge", () => {
  test("adds to a number and to a 2-vector", () => {
    expect(keys(run([{ op: "nudge", sel: "s1/b1:fox@0.joints.head", delta: -5 }]))[0].pose.joints!.head).toBe(5);
    expect(run([{ op: "nudge", sel: "cast.fox.parts.head.pivot", delta: [1, -2] }]).cast.fox.parts[1].pivot)
      .toEqual([1, 18]);
    fails([{ op: "nudge", sel: "s1/b1:fox@0.joints.head", delta: [1, 2] }], /takes a number delta/);
    fails([{ op: "nudge", sel: "s1.title", delta: 1 }], /not a number or a 2-vector/);
  });

  test("@* touches only the keys that carry the value", () => {
    const doc = run([{ op: "nudge", sel: "s1/b1:fox@*.root.x", delta: 0.1 }]);
    expect(keys(doc)[0].pose.root!.x).toBeCloseTo(0.3, 10);
    expect(keys(doc)[1].pose.root).toBeUndefined();
  });

  test("@* with no key carrying it materialises on the first key, from the inherited value", () => {
    // b2's track carries no head; the timeline resolves it to 20, carried from b1.
    const doc = run([{ op: "nudge", sel: "s1/b2:fox@*.joints.head", delta: 5 }]);
    expect(keys(doc, 1)[0].pose.joints).toEqual({ head: 25 });
    expect(keys(doc, 0).map((k) => k.pose.joints!.head)).toEqual([10, 20]);
  });

  test("a single key that lacks the value gets the inherited one too", () => {
    const doc = run([{ op: "nudge", sel: "s1/b2:fox@0.joints.head", delta: -20 }]);
    expect(keys(doc, 1)[0].pose.joints).toEqual({ head: 0 });
    expect(run([{ op: "nudge", sel: "s1/b2:fox@0.root.x", delta: 0.1 }]).scenes[0].beats[1].tracks!.fox[0].pose.root!.x)
      .toBeCloseTo(0.6, 10);
  });

  test("nothing to nudge and nothing to inherit is an error", () => {
    fails([{ op: "nudge", sel: "s1/b1.fx@0.5.over", delta: 1 }], /nothing there to nudge/);
    fails([{ op: "nudge", sel: "s1/b2:fox@9.joints.head", delta: 1 }], /no keyframe at 9/);
  });
});

describe("import", () => {
  const edit: Edit = { op: "import", src: "lib.heron", as: "heron" };

  test("without a resolver it is an error", () => {
    fails([edit], /imports unavailable/);
  });

  test("with one, the resolver owns the change and reports what it touched", () => {
    const imports = (doc: Play, e: Extract<Edit, { op: "import" }>) => {
      doc.cast[e.as!] = { ...fox, id: e.as!, from: e.src };
      return ["cast", `cast:${e.as}`];
    };
    const out = applyEdits(base(), [edit], { kind: "cast" }, { imports });
    expect(out.doc.cast.heron.from).toBe("lib.heron");
    expect(out.touched).toEqual(["cast", "cast:heron"]);
  });
});

describe("scopes and bookkeeping", () => {
  test("edits are relative to the scope", () => {
    const doc = applyEdits(base(), [{ op: "set", sel: "b1:fox@0.joints.head", value: 3 }], { kind: "scene", id: "s1" }).doc;
    expect(keys(doc)[0].pose.joints!.head).toBe(3);
    expect(() => applyEdits(base(), [{ op: "set", sel: "cast.fox.note", value: "x" }], { kind: "scene", id: "s1" }))
      .toThrow(EditError);
  });

  test("touched names the scopes a batch changed", () => {
    const touched = (sel: string, op: Edit["op"] = "set") =>
      applyEdits(base(), [{ op, sel, value: 1 } as Edit]).touched;
    expect(touched("s1/b1.length")).toEqual(["scene:s1"]);
    expect(touched("s1.title", "set")).toEqual(["scene:s1", "play"]);
    expect(touched("stage.tempo")).toEqual(["play"]);
    expect(applyEdits(base(), [{ op: "set", sel: "cast.fox.unit", value: 120 }]).touched).toEqual(["cast:fox"]);
    expect(applyEdits(base(), [{ op: "remove", sel: "cast.fox" }]).touched).toEqual(["cast", "cast:fox"]);
  });

  test("editsSummary is one short line per edit", () => {
    const lines = editsSummary([
      { op: "set", sel: "s1/b1:fox@0.joints.head", value: -12 },
      { op: "insert", sel: "s1/beats", value: { id: "b3", length: 1 }, after: "b1" },
      { op: "remove", sel: "cast.fox.parts.ear" },
      { op: "nudge", sel: "s1/b1:fox@*.root.x", delta: 0.05 },
      { op: "import", src: "lib.heron", as: "bird" },
    ]).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("set s1/b1:fox@0.joints.head = -12");
    expect(lines[1]).toBe("insert s1/beats after b1 {\"id\":\"b3\",\"length\":1}");
    expect(lines[3]).toBe("nudge s1/b1:fox@*.root.x +0.05");
    expect(lines[4]).toBe("import lib.heron as bird");
  });
});

describe("applyAndValidate", () => {
  test("returns the normalised document", () => {
    const out = applyAndValidate(base(), [{ op: "set", sel: "cast.fox.parts.ear.path", value: "m0,0 l10,0 l0,10" }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.doc.cast.fox.parts[2].path).toBe("M0,0 L10,0 L10,10 Z");
  });

  test("reports the index of the first edit whose result is invalid", () => {
    const out = applyAndValidate(base(), [
      { op: "set", sel: "s1/b1.label", value: "fine" },
      { op: "set", sel: "s1/b1:ghost", value: [{ at: 0, pose: {} }] },
      { op: "set", sel: "title", value: "also fine" },
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.index).toBe(1);
      expect(out.message).toMatch(/'ghost', who is not in the cast/);
    }
  });

  test("a structural failure reports its own index", () => {
    const out = applyAndValidate(base(), [
      { op: "set", sel: "title", value: "ok" },
      { op: "remove", sel: "s1/b7" },
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.index).toBe(1);
  });
});
