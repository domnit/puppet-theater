import { describe, expect, test } from "bun:test";
import { apply } from "../src/engine/math";
import { resolvePuppet } from "../src/model/puppet";
import { PlaySchema, type Play } from "../src/model/types";
import { readPlay } from "../src/doc/read";
import { BOX, loadPlay } from "./helpers";

/** A minimal two-part puppet: a torso and one arm, optionally rodded. */
function armPlay(rodded: boolean): Play {
  const parts = [
    { id: "torso", parent: null, pivot: [0, 0], path: BOX },
    { id: "arm", parent: "torso", pivot: [0, 4], path: BOX, ...(rodded ? { rod: [0, 8] } : {}) },
  ];
  return PlaySchema.parse({
    id: "p", schemaVersion: 1, stage: { tempo: 60 },
    cast: { k: { id: "k", unit: 100, cap: 2, parts } },
    scenes: [{
      id: "s1",
      beats: [{
        id: "b1", length: 2,
        tracks: { k: [
          { at: 0, pose: { joints: { arm: 0 }, root: { x: 0.5, y: 0.5 } } },
          { at: 1, pose: { joints: { arm: 40 } } },
        ] },
      }],
    }],
  });
}

describe("top-level projection", () => {
  test("default depth is scene: scenes carry a beat-summary list, cast carries summaries", async () => {
    const play = await loadPlay("fixtures/plays/01-hold.json");
    const out = readPlay(play) as any;
    expect(out.id).toBe("fx-hold");
    expect(out.title).toBe(play.title);
    expect(out.stage).toEqual(play.stage);
    expect(out.meta).toEqual(play.meta);
    expect(out.version).toBeUndefined();
    expect(out.mode).toBeUndefined();
    expect(out.cast).toEqual([
      { id: "keeper", name: "The Keeper", note: expect.any(String), parts: 11, extent: expect.any(Object), warnings: [] },
    ]);
    expect(out.scenes).toEqual([
      { id: "s1", title: "The keeper waits", beats: [{ id: "b1", label: "he waits", length: 4, tracks: ["keeper"], fx: 0 }] },
    ]);
  });

  test("depth play collapses scenes to counts and keeps the same cast summaries", async () => {
    const play = await loadPlay("fixtures/plays/01-hold.json");
    const out = readPlay(play, { depth: "play" }) as any;
    expect(out.scenes).toEqual([{ id: "s1", title: "The keeper waits", beats: 1, length: 4 }]);
    expect(out.cast[0]).toEqual({ id: "keeper", name: "The Keeper", note: expect.any(String), parts: 11, extent: expect.any(Object), warnings: [] });
  });

  test("depth beat expands a beat's tracks to keyframe summaries and fx to the full cue list", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const out = readPlay(play, { depth: "beat" }) as any;
    const b9 = out.scenes[0].beats.find((b: any) => b.id === "b9");
    expect(b9.tracks.keeper).toEqual([
      { at: 1, ease: "inOut", joints: ["arm_near", "farm_near", "head"], root: [] },
    ]);
    expect(b9.fx).toEqual([{ at: 0.5, type: "lamp", to: 0.3, over: 2 }]);
  });

  test("depth key gives keyframes exactly as stored", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const out = readPlay(play, { depth: "key" }) as any;
    const b7 = out.scenes[0].beats.find((b: any) => b.id === "b7");
    expect(b7.tracks.keeper).toEqual(play.scenes[0].beats.find((b) => b.id === "b7")!.tracks!.keeper);
  });
});

describe("selector narrowing", () => {
  test("a scene selector returns that scene's projection at the depth", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const whole = readPlay(play, { sel: "s1" }) as any;
    expect(whole.id).toBe("s1");
    expect(whole.beats.length).toBe(play.scenes[0].beats.length);
    const summary = readPlay(play, { sel: "s1", depth: "play" }) as any;
    expect(summary).toEqual({ id: "s1", title: "Along the cliff path", beats: play.scenes[0].beats.length, length: expect.any(Number) });
  });

  test("a beat selector returns that beat", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const beat = readPlay(play, { sel: "s1/b7", depth: "beat" }) as any;
    expect(beat.id).toBe("b7");
    expect(beat.label).toBe("he stops and lifts the lantern");
    expect(Object.keys(beat.tracks)).toEqual(["keeper"]);
  });

  test("a track selector gives summaries at beat depth and full keyframes at key depth", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const summarized = readPlay(play, { sel: "s1/b7:keeper", depth: "beat" }) as any[];
    expect(summarized.map((k) => k.at)).toEqual([0, 0.6]);
    expect(summarized[1].joints).toContain("arm_near");
    const full = readPlay(play, { sel: "s1/b7:keeper", depth: "key" }) as any[];
    expect(full).toEqual(play.scenes[0].beats.find((b) => b.id === "b7")!.tracks!.keeper);
  });

  test("cast returns every puppet's full detail; cast.<id> returns one", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const all = readPlay(play, { sel: "cast" }) as any[];
    expect(all.map((p) => p.id)).toEqual(["keeper"]);
    const one = readPlay(play, { sel: "cast.keeper" }) as any;
    expect(one).toEqual(all[0]);
    expect(one.parts.length).toBe(12); // keeper-lantern: keeper's 11 plus the lantern
    expect(one.extent).toBeTruthy();
    expect(one.path).toBeUndefined();
  });

  test("cast.<id>.parts.<id> returns one part with derived geometry", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const part = readPlay(play, { sel: "cast.keeper.parts.farm_near" }) as any;
    expect(part.id).toBe("farm_near");
    expect(part.parent).toBe("arm_near");
    expect(part.rod).toEqual([0, 21]);
    expect(Number.isFinite(part.rest.x)).toBe(true);
    expect(Number.isFinite(part.rest.y)).toBe(true);
    expect(Number.isFinite(part.rest.angle)).toBe(true);
    expect(part.bbox).toBeTruthy();
  });

  test("leaf selectors return the raw stored value", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    expect(readPlay(play, { sel: "stage.tempo" })).toBe(96);
    expect(readPlay(play, { sel: "cast.keeper.note" })).toBe(play.cast.keeper.note);
    expect(readPlay(play, { sel: "s1/b7.label" })).toBe("he stops and lifts the lantern");
    expect(readPlay(play, { sel: "s1/b7:keeper@0.6.joints.arm_near" })).toBe(-100);
  });
});

describe("path visibility", () => {
  test("path is omitted by default, included only for named parts, and never present on a mirrored part", async () => {
    const play = await loadPlay("fixtures/plays/05-mirror.json");
    const bare = readPlay(play, { sel: "cast.fox" }) as any;
    for (const part of bare.parts) expect(part.path).toBeUndefined();

    const named = readPlay(play, { sel: "cast.fox", include_paths: ["torso", "ear_r"] }) as any;
    const torso = named.parts.find((p: any) => p.id === "torso");
    const earR = named.parts.find((p: any) => p.id === "ear_r"); // mirrorOf ear_l, no own path
    expect(torso.path).toBe(play.cast.fox.parts.find((p) => p.id === "torso")!.path);
    expect(earR.path).toBeUndefined();
    expect(earR.mirrorOf).toBe("ear_l");
  });
});

describe("derived geometry", () => {
  test("extent matches resolvePuppet(...).extent within tolerance", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const resolved = resolvePuppet(play.cast.keeper);
    const out = readPlay(play, { sel: "cast.keeper" }) as any;
    expect(out.extent.x).toBeCloseTo(resolved.extent.x, 0);
    expect(out.extent.y).toBeCloseTo(resolved.extent.y, 0);
    expect(out.extent.w).toBeCloseTo(resolved.extent.w, 0);
    expect(out.extent.h).toBeCloseTo(resolved.extent.h, 0);
  });

  test("a child's rest position equals its pivot transformed by the parent's rest matrix", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const resolved = resolvePuppet(play.cast.keeper);
    const out = readPlay(play, { sel: "cast.keeper" }) as any;
    const farmNear = out.parts.find((p: any) => p.id === "farm_near"); // parent: arm_near
    const [expectedX, expectedY] = apply(resolved.rest.get("arm_near")!, farmNear.pivot);
    expect(farmNear.rest.x).toBeCloseTo(expectedX, 0);
    expect(farmNear.rest.y).toBeCloseTo(expectedY, 0);
  });
});

describe("unheld motion warnings", () => {
  test("04-lantern warns only about the head, keyed 18° from a standstill", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const out = readPlay(play, { sel: "cast.keeper" }) as any;
    expect(out.warnings).toEqual(["head: keyed 18° from a standstill with nothing holding it — add a rod or let it swing"]);
  });

  test("a big keyed rotation on an unrodded part from a standstill warns, naming the part", () => {
    const play = armPlay(false);
    const out = readPlay(play, { sel: "cast.k" }) as any;
    expect(out.warnings).toEqual(["arm: keyed 40° from a standstill with nothing holding it — add a rod or let it swing"]);
  });

  test("the same rotation on a rodded part warns not at all", () => {
    const play = armPlay(true);
    const out = readPlay(play, { sel: "cast.k" }) as any;
    expect(out.warnings).toEqual([]);
  });
});
