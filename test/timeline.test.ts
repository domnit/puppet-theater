import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROOT, beatsToSeconds, buildTimeline, lampAt, poseAt, secondsToBeats, spanAt,
} from "../src/engine/timeline";
import { PlaySchema, type Play } from "../src/model/types";
import { BOX } from "./helpers";

const cast = {
  k: { id: "k", unit: 100, cap: 2, parts: [{ id: "torso", parent: null, pivot: [0, 0], path: BOX }] },
};

function play(scenes: unknown[], tempo = 60): Play {
  return PlaySchema.parse({ id: "p", schemaVersion: 1, stage: { tempo }, cast, scenes });
}
const beat = (id: string, length: number, keys?: unknown[], fx?: unknown[]) => ({
  id, length, ...(keys ? { tracks: { k: keys } } : {}), ...(fx ? { fx } : {}),
});
const track = (p: Play) => buildTimeline(p).tracks.get("k");

describe("beat axis", () => {
  const tl = buildTimeline(play([
    { id: "s1", beats: [beat("b1", 1), beat("b2", 2)] },
    { id: "s2", beats: [beat("b3", 1.5)] },
  ]));

  test("beats lay end to end across scenes", () => {
    expect(tl.totalBeats).toBe(4.5);
    expect(tl.spans.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 3], [3, 4.5]]);
    expect(tl.scenes.map((s) => [s.start, s.end])).toEqual([[0, 3], [3, 4.5]]);
  });

  test("spanAt finds the beat containing a position, half-open at the end", () => {
    expect(spanAt(tl, 0)!.beat.id).toBe("b1");
    expect(spanAt(tl, 1)!.beat.id).toBe("b2");
    expect(spanAt(tl, 2.99)!.beat.id).toBe("b2");
    expect(spanAt(tl, 3)!.beat.id).toBe("b3");
  });

  test("past the end, the last beat holds", () => {
    expect(spanAt(tl, 99)!.beat.id).toBe("b3");
    expect(spanAt(tl, -1)).toBeUndefined();
  });

  test("tempo converts beats and seconds both ways", () => {
    const t = buildTimeline(play([{ id: "s1", beats: [beat("b1", 4)] }], 120));
    expect(secondsToBeats(t, 1)).toBe(2);
    expect(beatsToSeconds(t, 2)).toBe(1);
    expect(beatsToSeconds(t, secondsToBeats(t, 3.7))).toBeCloseTo(3.7, 10);
  });

  test("a zero-length beat is allowed and takes no time", () => {
    const t = buildTimeline(play([{ id: "s1", beats: [beat("b1", 1), beat("b0", 0), beat("b2", 1)] }]));
    expect(t.totalBeats).toBe(2);
  });
});

describe("keyframe resolution", () => {
  test("keyframe offsets are relative to their beat", () => {
    const t = track(play([{ id: "s1", beats: [
      beat("b1", 2, [{ at: 0, pose: { joints: { a: 0 } } }]),
      beat("b2", 2, [{ at: 0.5, pose: { joints: { a: 10 } } }]),
    ] }]))!;
    expect(t.map((k) => k.at)).toEqual([0, 2.5]);
  });

  test("sparse poses carry forward from earlier keys", () => {
    const t = track(play([{ id: "s1", beats: [beat("b1", 3, [
      { at: 0, pose: { joints: { a: 10 }, root: { x: 0.2 } } },
      { at: 1, pose: { joints: { b: 20 } } },
      { at: 2, pose: { joints: { a: 30 } } },
    ])] }]))!;
    expect(t[1].joints).toEqual({ a: 10, b: 20 });
    expect(t[2].joints).toEqual({ a: 30, b: 20 });
    expect(t[2].root.x).toBe(0.2);
    expect(t[2].root.y).toBe(DEFAULT_ROOT.y);
  });

  test("an unspecified root starts from the default", () => {
    const t = track(play([{ id: "s1", beats: [beat("b1", 1, [{ at: 0, pose: {} }])] }]))!;
    expect(t[0].root).toEqual(DEFAULT_ROOT);
  });

  test("keys are sorted onto the axis and default to inOut", () => {
    const t = track(play([{ id: "s1", beats: [beat("b1", 2, [
      { at: 1, pose: { joints: { a: 1 } } },
      { at: 0, ease: "linear", pose: { joints: { a: 0 } } },
    ])] }]))!;
    expect(t.map((k) => k.at)).toEqual([0, 1]);
    expect(t.map((k) => k.ease)).toEqual(["linear", "inOut"]);
  });
});

describe("poseAt", () => {
  const p = play([{ id: "s1", beats: [beat("b1", 4, [
    { at: 0, pose: { joints: { a: 0 }, root: { x: 0, facing: 1, plane: "far" } } },
    { at: 2, ease: "linear", pose: { joints: { a: 40 }, root: { x: 1, facing: -1, plane: "near" } } },
  ])] }]);
  const t = track(p)!;

  test("a puppet is not on stage before its first key", () => {
    const early = track(play([{ id: "s1", beats: [beat("b1", 4, [{ at: 2, pose: { joints: { a: 5 } } }])] }]))!;
    expect(poseAt(early, 1.9)).toBeNull();
    expect(poseAt(early, 2)).not.toBeNull();
    expect(poseAt(undefined, 0)).toBeNull();
    expect(poseAt([], 0)).toBeNull();
  });

  test("after the last key the pose holds", () => {
    const last = poseAt(t, 99)!;
    expect(last.joints.a).toBe(40);
    expect(last.progress).toBe(1);
  });

  test("continuous channels interpolate", () => {
    const mid = poseAt(t, 1)!;
    expect(mid.joints.a).toBeCloseTo(20, 10);
    expect(mid.root.x).toBeCloseTo(0.5, 10);
  });

  test("a key's ease governs the motion into it, not out of it", () => {
    // `hold` on the second key freezes the first key's value until the second lands
    const held = track(play([{ id: "s1", beats: [beat("b1", 4, [
      { at: 0, pose: { joints: { a: 0 } } },
      { at: 2, ease: "hold", pose: { joints: { a: 40 } } },
    ])] }]))!;
    expect(poseAt(held, 1.99)!.joints.a).toBe(0);
    expect(poseAt(held, 2)!.joints.a).toBe(40);
  });

  test("joints take the shortest arc", () => {
    const wrapped = track(play([{ id: "s1", beats: [beat("b1", 4, [
      { at: 0, pose: { joints: { a: 170 } } },
      { at: 2, ease: "linear", pose: { joints: { a: -170 } } },
    ])] }]))!;
    expect(wrapped.length).toBe(2);
    expect(poseAt(wrapped, 1)!.joints.a).toBeCloseTo(180, 6);
  });

  test("a joint keyed only later interpolates from its first stated value", () => {
    const late = track(play([{ id: "s1", beats: [beat("b1", 4, [
      { at: 0, pose: { joints: { a: 0 } } },
      { at: 2, ease: "linear", pose: { joints: { b: 50 } } },
    ])] }]))!;
    expect(poseAt(late, 1)!.joints.b).toBeCloseTo(50, 10);
  });

  test("facing and plane switch at the segment midpoint", () => {
    expect(poseAt(t, 0.99)!.root.facing).toBe(1);
    expect(poseAt(t, 0.99)!.root.plane).toBe("far");
    expect(poseAt(t, 1.01)!.root.facing).toBe(-1);
    expect(poseAt(t, 1.01)!.root.plane).toBe("near");
  });

  test("coincident keys do not divide by zero", () => {
    const dup = track(play([{ id: "s1", beats: [beat("b1", 4, [
      { at: 1, pose: { joints: { a: 0 } } },
      { at: 1, pose: { joints: { a: 40 } } },
    ])] }]))!;
    const at = poseAt(dup, 1)!;
    expect(Number.isFinite(at.joints.a)).toBe(true);
    expect(at.progress).toBe(1);
  });
});

describe("lamp cues", () => {
  const tl = buildTimeline(play([{ id: "s1", beats: [
    beat("b1", 4, undefined, [{ at: 1, type: "lamp", to: 0.2, over: 2 }]),
    beat("b2", 4, undefined, [{ at: 0, type: "lamp", to: 1, over: 0 }, { at: 1, type: "notlamp", to: 0 }]),
  ] }]));

  test("only lamp cues are collected, on the absolute axis, in order", () => {
    expect(tl.lampCues).toEqual([{ at: 1, to: 0.2, over: 2 }, { at: 4, to: 1, over: 0 }]);
  });

  test("the lamp is full before any cue and ramps over its span", () => {
    expect(lampAt(tl, 0)).toBe(1);
    expect(lampAt(tl, 1)).toBeCloseTo(1, 10);
    expect(lampAt(tl, 2)).toBeCloseTo(0.6, 10);
    expect(lampAt(tl, 3)).toBeCloseTo(0.2, 10);
    expect(lampAt(tl, 3.5)).toBeCloseTo(0.2, 10);
  });

  test("an instant cue snaps, and later cues start from the current level", () => {
    expect(lampAt(tl, 4)).toBeCloseTo(1, 10);
  });
});
