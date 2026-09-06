import { describe, expect, test } from "bun:test";
import { Evaluator, PLANES, STAGE_H, STAGE_W, UNIT_FRACTION } from "../src/engine/evaluate";
import { apply, magnitude, type Mat } from "../src/engine/math";
import { resolvePuppet, type ResolvedPuppet } from "../src/model/puppet";
import { PlaySchema, type Play } from "../src/model/types";
import { BOX } from "./helpers";

const parts = [
  { id: "torso", parent: null, pivot: [0, 0], path: BOX },
  { id: "arm", parent: "torso", pivot: [0, 4], path: BOX },
  { id: "prop", parent: "arm", pivot: [0, 20], path: BOX, swing: 0.8 },
];

function build(keys: unknown[], opts?: Partial<{ idle: boolean; followThrough: boolean; swing: boolean }>): Evaluator {
  const play: Play = PlaySchema.parse({
    id: "p", schemaVersion: 1, stage: { tempo: 60 },
    cast: { k: { id: "k", unit: 100, cap: 2, parts } },
    scenes: [{ id: "s1", beats: [{ id: "b1", length: 8, tracks: { k: keys } }] }],
  });
  const puppets = new Map<string, ResolvedPuppet>([["k", resolvePuppet({ ...play.cast.k, id: "k" })]]);
  return new Evaluator(play, puppets, { idle: true, followThrough: true, swing: true, ...opts });
}

const still = [{ at: 0, pose: { joints: { arm: 0 }, root: { x: 0.5, y: 0.5 } } }];
const OFF = { idle: false, followThrough: false, swing: false };

describe("frame composition", () => {
  test("a puppet is absent before its first key and present after", () => {
    const ev = build([{ at: 2, pose: { joints: { arm: 0 } } }]);
    expect(ev.frame(0).puppets.length).toBe(0);
    expect(ev.frame(2).puppets.length).toBe(1);
    expect(ev.frame(50).puppets.length).toBe(1);
  });

  test("duration follows the beat axis and the tempo", () => {
    expect(build(still).durationSeconds).toBe(8);
  });

  test("a unit-tall puppet fills the stated fraction of the stage at scale 1 on mid", () => {
    const f = build(still, OFF).frame(0);
    expect(magnitude(f.puppets[0].root)).toBeCloseTo((UNIT_FRACTION * STAGE_H) / 100, 10);
  });

  test("root pose places the puppet in stage pixels", () => {
    const f = build([{ at: 0, pose: { root: { x: 0.25, y: 0.75 } } }], OFF).frame(0);
    const [x, y] = apply(f.puppets[0].root, [0, 0]);
    expect(x).toBeCloseTo(0.25 * STAGE_W, 6);
    expect(y).toBeCloseTo(0.75 * STAGE_H, 6);
  });

  test("facing -1 mirrors the puppet without changing its size", () => {
    const a = build([{ at: 0, pose: { root: { facing: 1 } } }], OFF).frame(0).puppets[0].root;
    const b = build([{ at: 0, pose: { root: { facing: -1 } } }], OFF).frame(0).puppets[0].root;
    expect(b[0]).toBeCloseTo(-a[0], 6);
    expect(magnitude(b)).toBeCloseTo(magnitude(a), 10);
  });

  test("plane sets scale and opacity", () => {
    for (const plane of ["far", "mid", "near"] as const) {
      const f = build([{ at: 0, pose: { root: { plane } } }], OFF).frame(0).puppets[0];
      expect(f.plane).toBe(plane);
      expect(magnitude(f.root)).toBeCloseTo((UNIT_FRACTION * STAGE_H / 100) * PLANES[plane].scale, 10);
      expect(f.opacity).toBeCloseTo(PLANES[plane].opacity, 10);
    }
  });

  test("parts paint back to front: z ascending, tree order on ties", () => {
    const f = build(still, OFF).frame(0).puppets[0];
    const zs = f.parts.map((p) => p.part.z);
    expect([...zs].sort((a, b) => a - b)).toEqual(zs);
    expect(f.parts.map((p) => p.part.id)).toEqual(["torso", "arm", "prop"]);
  });

  test("every part hangs off its parent's pivot", () => {
    const f = build([{ at: 0, pose: { joints: { torso: 15, arm: -40 } } }], OFF).frame(0).puppets[0];
    const world = new Map<string, Mat>(f.parts.map((p) => [p.part.id, p.world]));
    for (const { part, world: m } of f.parts) {
      if (!part.parent) continue;
      const [px, py] = apply(world.get(part.parent)!, part.pivot);
      const [cx, cy] = apply(m, [0, 0]);
      expect(cx).toBeCloseTo(px, 6);
      expect(cy).toBeCloseTo(py, 6);
    }
  });

  test("the root joint is keyable like any other", () => {
    const f = build([{ at: 0, pose: { joints: { torso: 30 } } }], OFF).frame(0).puppets[0];
    expect(f.parts.find((p) => p.part.id === "torso")!.angle).toBeCloseTo(30, 6);
  });

  test("rods run from the attachment down to a hand below the stage", () => {
    const f = build(still, OFF).frame(0).puppets[0];
    expect(f.rods.length).toBe(1);
    const rod = f.rods[0];
    expect(rod.main).toBe(true);
    expect(rod.y2).toBeGreaterThan(STAGE_H);
    // vertical at rest: the hand sits directly under the attachment
    expect(rod.x2).toBeCloseTo(rod.x1, 6);
    expect(rod.width).toBeGreaterThan(0);
  });

  test("the lamp stays within range across the play", () => {
    const ev = build(still, OFF);
    for (let t = 0; t <= ev.durationSeconds; t += 0.25) {
      const lamp = ev.frame(t).lamp;
      expect(lamp).toBeGreaterThanOrEqual(0);
      expect(lamp).toBeLessThanOrEqual(1);
    }
  });
});

describe("procedural layers", () => {
  test("with every layer off, a hold is perfectly still", () => {
    const ev = build(still, OFF);
    const a = ev.frame(1).puppets[0];
    const b = ev.frame(5).puppets[0];
    expect(b.root).toEqual(a.root);
    expect(b.parts.map((p) => p.angle)).toEqual(a.parts.map((p) => p.angle));
  });

  test("idle alone saves a dead hold from being static", () => {
    const ev = build(still, { followThrough: false, swing: false });
    const a = ev.frame(1).puppets[0];
    const b = ev.frame(3).puppets[0];
    expect(b.root).not.toEqual(a.root);
    expect(b.parts.map((p) => p.angle)).not.toEqual(a.parts.map((p) => p.angle));
  });

  test("idle is seeded from ids, so the same time always gives the same pose", () => {
    const angles = (ev: Evaluator) => ev.frame(2.37).puppets[0].parts.map((p) => p.angle);
    expect(angles(build(still))).toEqual(angles(build(still)));
  });

  test("idle stays small — it is breath, not motion", () => {
    const ev = build(still, { followThrough: false, swing: false });
    const base = build(still, OFF).frame(0).puppets[0];
    for (let t = 0; t <= 8; t += 0.1) {
      const f = ev.frame(t).puppets[0];
      for (let i = 0; i < f.parts.length; i++) {
        expect(Math.abs(f.parts[i].angle - base.parts[i].angle)).toBeLessThan(3);
      }
    }
  });

  test("follow-through makes a child lag its parent's swipe", () => {
    const keys = [
      { at: 0, pose: { joints: { arm: 0 } } },
      { at: 1, ease: "linear", pose: { joints: { arm: 90 } } },
    ];
    const lag = build(keys, { idle: false, swing: false }).frame(0.5).puppets[0];
    const none = build(keys, OFF).frame(0.5).puppets[0];
    const armOf = (f: typeof lag) => f.parts.find((p) => p.part.id === "arm")!.angle;
    // the arm itself is not delayed at depth 1's own key, but its child is dragged
    expect(armOf(lag)).toBeLessThan(armOf(none));
  });

  test("swing overrides the keyed angle of a hanging part", () => {
    const withSwing = build(still).frame(2).puppets[0];
    const without = build(still, { swing: false }).frame(2).puppets[0];
    const propOf = (f: typeof withSwing) => f.parts.find((p) => p.part.id === "prop")!.angle;
    expect(propOf(withSwing)).not.toBeCloseTo(propOf(without), 3);
  });

  test("a hanging part settles toward world-down when nothing moves", () => {
    const ev = build(still, { idle: false, followThrough: false });
    const prop = ev.frame(6).puppets[0].parts.find((p) => p.part.id === "prop")!;
    expect(Math.abs(prop.angle)).toBeLessThan(1);
  });
});

describe("determinism", () => {
  const keys = [
    { at: 0, pose: { joints: { arm: -40 }, root: { x: 0.2 } } },
    { at: 2, ease: "linear", pose: { joints: { arm: 60 }, root: { x: 0.8 } } },
    { at: 4, pose: { joints: { arm: -10 }, root: { x: 0.4 } } },
  ];
  const propAt = (ev: Evaluator, t: number) =>
    ev.frame(t).puppets[0].parts.find((p) => p.part.id === "prop")!.angle;

  test("playing to a time matches jumping straight to it", () => {
    const played = build(keys);
    for (let t = 0; t <= 5; t += 1 / 60) played.frame(t);
    expect(propAt(played, 5)).toBeCloseTo(propAt(build(keys), 5), 9);
  });

  test("scrubbing backwards and forwards returns to the same pose", () => {
    const ev = build(keys);
    const want = propAt(ev, 4.5);
    for (const t of [6, 1, 3.2, 0.4, 7, 2]) ev.frame(t);
    expect(propAt(ev, 4.5)).toBeCloseTo(want, 6);
  });

  test("a frame is otherwise a pure function of time", () => {
    const ev = build(keys, OFF);
    const a = ev.frame(3.3).puppets[0];
    ev.frame(0); ev.frame(7);
    expect(ev.frame(3.3).puppets[0].parts.map((p) => p.angle)).toEqual(a.parts.map((p) => p.angle));
  });
});
