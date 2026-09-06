import { describe, expect, test } from "bun:test";
import { apply } from "../src/engine/math";
import { PuppetError, resolvePuppet } from "../src/model/puppet";
import { PuppetSchema } from "../src/model/types";
import { BOX, puppetDoc } from "./helpers";

const torso = { id: "torso", parent: null, pivot: [0, 0], path: BOX };
const arm = { id: "arm", parent: "torso", pivot: [0, 4], path: BOX };
const hand = { id: "hand", parent: "arm", pivot: [0, 20], path: BOX, rod: [0, 8] };

describe("structural checks", () => {
  const bad = (parts: unknown[], re: RegExp) => {
    let err: unknown;
    try { resolvePuppet(puppetDoc(parts)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PuppetError);
    expect((err as Error).message).toMatch(re);
  };

  test("duplicate part ids", () => {
    bad([torso, { ...arm, id: "torso" }], /duplicate part id/);
  });

  test("a parent that does not exist", () => {
    bad([torso, { ...arm, parent: "nope" }], /parent 'nope' does not exist/);
  });

  test("a cycle in the part tree", () => {
    bad([{ ...torso, parent: "arm" }, arm], /cycle/);
  });

  test("a part with neither path nor mirrorOf", () => {
    bad([torso, { id: "arm", parent: "torso", pivot: [0, 4] }], /neither path nor mirrorOf/);
  });

  test("mirrorOf pointing at nothing, or at a part with no path of its own", () => {
    bad([torso, { id: "arm", parent: "torso", pivot: [0, 4], mirrorOf: "ghost" }], /mirrorOf 'ghost' does not exist/);
    bad(
      [torso, { id: "a", parent: "torso", pivot: [0, 4], mirrorOf: "torso" }, { id: "b", parent: "torso", pivot: [0, 4], mirrorOf: "a" }],
      /mirrorOf 'a' has no path of its own/,
    );
  });

  test("a contour with no area", () => {
    bad([{ ...torso, path: "M0,0 L10,0 Z" }], /contour has no area/);
  });

  test("a broken path forwards the parser's message", () => {
    bad([{ ...torso, path: "M0,0 L10" }], /multiples of 2/);
  });

  test("the part-count ceiling is enforced by the schema", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ ...torso, id: `p${i}`, parent: i ? "p0" : null }));
    expect(PuppetSchema.safeParse({ id: "t", unit: 100, cap: 2, parts: many }).success).toBe(false);
    expect(PuppetSchema.safeParse({ id: "t", unit: 100, cap: 2, parts: many.slice(0, 64) }).success).toBe(true);
  });

  test("a well-formed puppet resolves", () => {
    expect(() => resolvePuppet(puppetDoc([torso, arm, hand]))).not.toThrow();
  });
});

describe("tree shape", () => {
  const p = resolvePuppet(puppetDoc([torso, arm, hand]));

  test("pre-order traversal, depth and children", () => {
    expect(p.ordered.map((x) => x.id)).toEqual(["torso", "arm", "hand"]);
    expect(p.ordered.map((x) => x.depth)).toEqual([0, 1, 2]);
    expect(p.parts.get("torso")!.children).toEqual(["arm"]);
    expect(p.parts.get("hand")!.children).toEqual([]);
    expect(p.roots.map((x) => x.id)).toEqual(["torso"]);
  });

  test("order is stable and matches the traversal", () => {
    expect(p.ordered.map((x) => x.order)).toEqual([0, 1, 2]);
  });
});

describe("contours", () => {
  test("mirrorOf reflects the source across the local Y axis", () => {
    const p = resolvePuppet(puppetDoc([
      { ...torso, path: "M2,0 L8,0 L8,20 L2,20 Z" },
      { id: "arm", parent: "torso", pivot: [0, 4], mirrorOf: "torso" },
    ]));
    const a = p.parts.get("arm")!;
    expect(a.mirrored).toBe(true);
    expect(a.mirrorOf).toBe("torso");
    expect(a.d).toBe("M-2,0 L-8,0 L-8,20 L-2,20 Z");
  });

  test("an own path wins over mirrorOf, which is kept as provenance", () => {
    const p = resolvePuppet(puppetDoc([
      torso,
      { id: "arm", parent: "torso", pivot: [0, 4], path: "M0,0 L9,0 L9,9 Z", mirrorOf: "torso" },
    ]));
    const a = p.parts.get("arm")!;
    expect(a.mirrored).toBe(false);
    expect(a.mirrorOf).toBe("torso");
    expect(a.d).toBe("M0,0 L9,0 L9,9 Z");
  });

  test("the part bbox unions the contour with the cap disc", () => {
    const p = resolvePuppet(puppetDoc([{ ...torso, path: "M-5,0 L5,0 L5,20 L-5,20 Z" }], { cap: 8 }));
    // the contour starts at y=0, but a cap of 8 reaches to y=-8
    expect(p.parts.get("torso")!.bbox).toEqual({ x: -8, y: -8, w: 16, h: 28 });
  });
});

describe("rods and what drives a part", () => {
  test("the root always carries a main rod at its pivot", () => {
    const p = resolvePuppet(puppetDoc([torso, arm]));
    expect(p.parts.get("torso")!.rod).toEqual([0, 0]);
    expect(p.parts.get("arm")!.rod).toBeUndefined();
    expect(p.rods.map((r) => r.id)).toEqual(["torso"]);
  });

  test("a rod on the root overrides the default attachment point", () => {
    const p = resolvePuppet(puppetDoc([{ ...torso, rod: [3, 7] }]));
    expect(p.parts.get("torso")!.rod).toEqual([3, 7]);
  });

  test("a hand rod drives its whole chain up to the root", () => {
    const p = resolvePuppet(puppetDoc([torso, arm, hand]));
    expect(p.parts.get("hand")!.drivenBy).toEqual(["hand"]);
    expect(p.parts.get("arm")!.drivenBy).toEqual(["hand"]);
    expect(p.parts.get("torso")!.drivenBy.sort()).toEqual(["hand", "torso"]);
  });

  test("a part off the driven chain is held by nothing", () => {
    const tail = { id: "tail", parent: "torso", pivot: [0, 18], path: BOX };
    const p = resolvePuppet(puppetDoc([torso, arm, hand, tail]));
    expect(p.parts.get("tail")!.drivenBy).toEqual([]);
  });

  test("rods list main rods first, then tree order", () => {
    const p = resolvePuppet(puppetDoc([torso, arm, hand, { id: "prop", parent: "torso", pivot: [6, 6], path: BOX, rod: [0, 1] }]));
    expect(p.rods[0].id).toBe("torso");
    expect(p.rods.slice(1).map((r) => r.id)).toEqual(["hand", "prop"]);
  });
});

describe("rest geometry", () => {
  test("rest matrices chain pivots down the tree", () => {
    const p = resolvePuppet(puppetDoc([torso, arm, hand]));
    expect(apply(p.rest.get("hand")!, [0, 0])).toEqual([0, 24]);
  });

  test("restPose angles rotate the chain below them", () => {
    const p = resolvePuppet(puppetDoc([torso, arm, hand], { restPose: { arm: 90 } }));
    const [x, y] = apply(p.rest.get("hand")!, [0, 0]);
    expect(x).toBeCloseTo(-20, 6);
    expect(y).toBeCloseTo(4, 6);
  });

  test("extent covers every part at rest", () => {
    const p = resolvePuppet(puppetDoc([torso, arm, hand]));
    const e = p.extent;
    expect(e.x).toBeCloseTo(-5, 6);
    expect(e.w).toBeCloseTo(10, 6);
    expect(e.y).toBeCloseTo(-2, 6); // cap disc above the root pivot
    expect(e.y + e.h).toBeCloseTo(44, 6); // hand at y=24 plus its 20-unit box
  });
});

describe("defaults", () => {
  test("optional look and note fields fall back", () => {
    const p = resolvePuppet(puppetDoc([torso]));
    expect(p.name).toBe("t");
    expect(p.idle).toBe(1);
    expect(p.opacity).toBe(1);
    expect(p.note).toBe("");
    expect(p.parts.get("torso")!.swing).toBe(0);
  });

  test("look overrides are carried through", () => {
    const p = resolvePuppet(puppetDoc([torso], { name: "Keeper", look: { idle: 0.4, opacity: 0.5 } }));
    expect(p.name).toBe("Keeper");
    expect(p.idle).toBe(0.4);
    expect(p.opacity).toBe(0.5);
  });
});
