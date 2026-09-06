// Unit tests for the import module: source parsing, puppet and part import
// semantics (deep copy, rescale, provenance, id collisions), version
// selection, scope rules, the library index, and an end-to-end batch through
// applyEdits.

import { describe, expect, test } from "bun:test";
import { pathBBox, parsePath } from "../src/model/path";
import { applyEdits, type Edit, type Scope } from "../src/doc/edit";
import {
  createImportResolver, libraryIndex, parseSource,
  type ImportSources, type LibraryPart, type LibraryPuppet,
} from "../src/doc/library";
import { PlaySchema, type Play } from "../src/model/types";
import { BOX, puppetDoc } from "./helpers";

// ---------- fixtures ----------

function libPuppet(id: string, version: number, note = `a ${id}`): LibraryPuppet {
  return {
    id, version,
    puppet: puppetDoc(
      [{ id: "body", parent: null, pivot: [0, 0], path: BOX, note: "body" }],
      { id, note, unit: 100, restPose: { body: 0 } },
    ),
  };
}

function libPart(id: string, version: number, unit: number): LibraryPart {
  return {
    id, version, unit, note: `a ${id}`,
    parts: [
      { id: "root", parent: null, pivot: [0, 0], z: 0, path: BOX, note: "root" },
      { id: "child", parent: "root", pivot: [2, 3], z: 0, path: BOX, note: "child", swing: 0.4, rod: [1, 1] },
      { id: "mirror", parent: "child", pivot: [0, 1], z: 0, mirrorOf: "child", note: "mirror" },
    ],
  };
}

function basePlay(): Play {
  return PlaySchema.parse({
    id: "p", schemaVersion: 1, title: "T", stage: { tempo: 96 },
    cast: { fox: puppetDoc([{ id: "torso", parent: null, pivot: [0, 0], path: BOX, note: "torso" }], { id: "fox", note: "a fox" }) },
    scenes: [],
  });
}

function sourcesWith(overrides: Partial<ImportSources> = {}): ImportSources {
  return {
    puppets: [libPuppet("heron", 1), libPuppet("heron", 2, "a better heron")],
    parts: [libPart("lantern", 1, 50)],
    play: () => null,
    ...overrides,
  };
}

const CAST: Scope = { kind: "cast" };

// ---------- parseSource ----------

describe("parseSource", () => {
  test("lib.<id> and lib.<id>@<n>", () => {
    expect(parseSource("lib.fox")).toEqual({ kind: "libPuppet", id: "fox", version: undefined });
    expect(parseSource("lib.fox@2")).toEqual({ kind: "libPuppet", id: "fox", version: 2 });
  });

  test("lib.part.<id> and lib.part.<id>@<n>", () => {
    expect(parseSource("lib.part.lantern")).toEqual({ kind: "libPart", id: "lantern", version: undefined });
    expect(parseSource("lib.part.lantern@3")).toEqual({ kind: "libPart", id: "lantern", version: 3 });
  });

  test("pl_<id>/cast/<puppet> and .../parts/<part>", () => {
    expect(parseSource("pl_abc123/cast/heron")).toEqual({ kind: "playPuppet", playId: "pl_abc123", puppet: "heron" });
    expect(parseSource("pl_abc123/cast/heron/parts/wing")).toEqual({
      kind: "playPart", playId: "pl_abc123", puppet: "heron", part: "wing",
    });
  });

  test("anything else is rejected", () => {
    expect(() => parseSource("nonsense")).toThrow(/not a valid import source/);
    expect(() => parseSource("lib.")).toThrow();
  });
});

// ---------- puppet import ----------

describe("puppet import", () => {
  test("deep copy with `as`, id from `as`, provenance in `from`", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    const touched = resolver(doc, { op: "import", src: "lib.heron@1", as: "bird" }, CAST);
    expect(touched.sort()).toEqual(["cast", "cast:bird"]);
    expect(doc.cast.bird.id).toBe("bird");
    expect(doc.cast.bird.from).toBe("lib.heron@1");
    expect(doc.cast.bird.note).toBe("a heron");
    // deep copy: mutating the copy must not reach the source
    doc.cast.bird.parts[0].note = "mutated";
    const original = sourcesWith().puppets[0].puppet.parts[0].note;
    expect(original).toBe("body");
  });

  test("without `as`, id is the source puppet's own id", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    resolver(doc, { op: "import", src: "lib.heron@1" }, CAST);
    expect(doc.cast.heron.id).toBe("heron");
    expect(doc.cast.heron.from).toBe("lib.heron@1");
  });

  test("no @n picks the highest version", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    resolver(doc, { op: "import", src: "lib.heron", as: "bird" }, CAST);
    expect(doc.cast.bird.from).toBe("lib.heron@2");
    expect(doc.cast.bird.note).toBe("a better heron");
  });

  test("an exact @n that does not exist throws, naming what is available", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    expect(() => resolver(doc, { op: "import", src: "lib.heron@5", as: "bird" }, CAST))
      .toThrow("no lib.heron@5 (have @2)");
  });

  test("an id collision throws", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    expect(() => resolver(doc, { op: "import", src: "lib.heron@1", as: "fox" }, CAST)).toThrow(/already has 'fox'/);
  });

  test("scope rules: cast only, and puppet import needs it unscoped", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    const edit: Edit = { op: "import", src: "lib.heron@1", as: "bird" };
    expect(() => resolver(doc, edit as any, { kind: "play" })).toThrow(/needs cast scope/);
    expect(() => resolver(doc, edit as any, { kind: "scene", id: "s1" })).toThrow(/needs cast scope/);
    expect(() => resolver(doc, edit as any, { kind: "cast", puppet: "fox" })).toThrow(/unscoped edit_cast/);
  });
});

// ---------- part import ----------

describe("part import", () => {
  test("rescales pivot, rod and path by the unit ratio; keeps swing; sets `from`", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith()); // target fox is unit 100, source lantern is unit 50 -> ratio 2
    resolver(doc, { op: "import", src: "lib.part.lantern@1", into: "fox", parent: "torso", pivot: [10, 20] }, CAST);
    const parts = doc.cast.fox.parts;
    const root = parts.find((p) => p.id === "root")!;
    const child = parts.find((p) => p.id === "child")!;

    expect(root.parent).toBe("torso");
    expect(root.pivot).toEqual([10, 20]); // the given pivot, not rescaled
    expect(root.from).toBe("lib.part.lantern@1");
    expect(child.parent).toBe("root");
    expect(child.pivot).toEqual([4, 6]); // [2,3] * 2
    expect(child.rod).toEqual([2, 2]); // [1,1] * 2
    expect(child.swing).toBe(0.4);

    const sourceBBox = pathBBox(parsePath(BOX))!;
    const gotBBox = pathBBox(parsePath(child.path!))!;
    expect(gotBBox.w).toBeCloseTo(sourceBBox.w * 2, 6);
    expect(gotBBox.h).toBeCloseTo(sourceBBox.h * 2, 6);
  });

  test("the id defaults to the source part's id; `as` renames the root only", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    resolver(doc, { op: "import", src: "lib.part.lantern@1", as: "lamp", into: "fox", parent: "torso", pivot: [0, 0] }, CAST);
    const ids = doc.cast.fox.parts.map((p) => p.id);
    expect(ids).toContain("lamp");
    expect(ids).toContain("child"); // unchanged
    expect(doc.cast.fox.parts.find((p) => p.id === "child")!.parent).toBe("lamp");
  });

  test("mirrorOf inside the subtree is remapped; a dangling mirrorOf is rejected", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    resolver(doc, { op: "import", src: "lib.part.lantern@1", into: "fox", parent: "torso", pivot: [0, 0] }, CAST);
    expect(doc.cast.fox.parts.find((p) => p.id === "mirror")!.mirrorOf).toBe("child");

    const danglingSources = sourcesWith({
      parts: [{ id: "loose", version: 1, unit: 50, note: "loose", parts: [
        { id: "root", parent: null, pivot: [0, 0], z: 0, path: BOX, note: "root" },
        { id: "twin", parent: "root", pivot: [0, 1], z: 0, mirrorOf: "outside", note: "twin" },
      ] }],
    });
    const doc2 = basePlay();
    expect(() =>
      createImportResolver(danglingSources)(doc2, { op: "import", src: "lib.part.loose", into: "fox", parent: "torso", pivot: [0, 0] }, CAST),
    ).toThrow(/mirrorOf 'outside' is outside the imported subtree/);
  });

  test("a missing `parent` in the target puppet is rejected", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    expect(() =>
      resolver(doc, { op: "import", src: "lib.part.lantern@1", into: "fox", parent: "nope", pivot: [0, 0] }, CAST),
    ).toThrow(/no part 'nope'/);
  });

  test("an id collision with an existing part is rejected", () => {
    const doc = basePlay();
    doc.cast.fox.parts.push({ id: "child", parent: "torso", pivot: [0, 0], z: 0, path: BOX });
    const resolver = createImportResolver(sourcesWith());
    expect(() =>
      resolver(doc, { op: "import", src: "lib.part.lantern@1", into: "fox", parent: "torso", pivot: [0, 0] }, CAST),
    ).toThrow(/already has a part 'child'/);
  });
});

// ---------- import from a play source ----------

describe("import from a play", () => {
  function playSources(): ImportSources {
    const heron = puppetDoc(
      [
        { id: "body", parent: null, pivot: [0, 0], path: BOX, note: "body", unit: 60 } as any,
        { id: "wing", parent: "body", pivot: [3, 4], path: BOX, note: "wing" },
      ],
      { id: "heron", note: "a play heron", unit: 60 },
    );
    const play: Play = PlaySchema.parse({
      id: "pl_src1", schemaVersion: 1, title: "Source play", stage: { tempo: 96 }, cast: { heron }, scenes: [],
    });
    return { puppets: [], parts: [], play: (id) => (id === "pl_src1" ? { doc: play, version: 7 } : null) };
  }

  test("puppet import: `from` carries the play's head version", () => {
    const doc = basePlay();
    const resolver = createImportResolver(playSources());
    resolver(doc, { op: "import", src: "pl_src1/cast/heron", as: "bird" }, CAST);
    expect(doc.cast.bird.from).toBe("pl_src1/cast/heron@7");
  });

  test("part import: the subtree is the part and its descendants, unit from the source puppet", () => {
    const doc = basePlay();
    const resolver = createImportResolver(playSources());
    resolver(doc, { op: "import", src: "pl_src1/cast/heron/parts/wing", into: "fox", parent: "torso", pivot: [5, 5] }, CAST);
    const wing = doc.cast.fox.parts.find((p) => p.id === "wing")!;
    expect(wing.from).toBe("pl_src1/cast/heron/parts/wing@7");
    expect(wing.pivot).toEqual([5, 5]);
  });

  test("an unknown play throws", () => {
    const doc = basePlay();
    const resolver = createImportResolver(playSources());
    expect(() => resolver(doc, { op: "import", src: "pl_nope/cast/heron", as: "bird" }, CAST)).toThrow(/no such play/);
  });
});

// ---------- library index ----------

describe("libraryIndex", () => {
  test("one entry per id, at its latest version", () => {
    const entries = libraryIndex(sourcesWith());
    expect(entries).toEqual([
      { src: "lib.heron", kind: "puppet", name: "heron", note: "a better heron", version: 2 },
      { src: "lib.part.lantern", kind: "part", name: "lantern", note: "a lantern", version: 1 },
    ]);
  });
});

// ---------- end to end ----------

describe("applyEdits with import", () => {
  test("a batch of [import, nudge on the imported part] applies, with the right touched scopes", () => {
    const doc = basePlay();
    const resolver = createImportResolver(sourcesWith());
    const edits: Edit[] = [
      { op: "import", src: "lib.heron@1", as: "bird" },
      { op: "nudge", sel: "cast.bird.parts.body.pivot", delta: [1, 2] },
    ];
    const { doc: out, touched } = applyEdits(doc, edits, CAST, { imports: resolver });
    expect(out.cast.bird.parts[0].pivot).toEqual([1, 2]);
    expect(touched.sort()).toEqual(["cast", "cast:bird"]);
  });
});
