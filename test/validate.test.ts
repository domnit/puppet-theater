import { describe, expect, test } from "bun:test";
import { LIMITS, RESERVED_PLAY, RESERVED_SCENE, validatePlay } from "../src/doc/validate";
import { BOX, loadPlay } from "./helpers";

const fox = {
  id: "fox", unit: 100, cap: 2,
  parts: [
    { id: "torso", parent: null, pivot: [0, 0], path: BOX },
    { id: "ear", parent: "torso", pivot: [0, 4], path: BOX },
  ],
};

const doc = (over: Record<string, unknown> = {}) => ({
  id: "p", schemaVersion: 1, title: "T", stage: { tempo: 96 },
  cast: { fox },
  scenes: [{ id: "s1", beats: [{ id: "b1", length: 1 }] }],
  ...over,
});

const bad = (over: Record<string, unknown>, re: RegExp) => {
  const out = validatePlay(doc(over));
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toMatch(re);
};

describe("validatePlay", () => {
  test("a shipped fixture validates, and validating again changes nothing", async () => {
    const play = await loadPlay("fixtures/plays/04-lantern.json");
    const once = validatePlay(play);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = validatePlay(once.doc);
    expect(twice.ok).toBe(true);
    if (twice.ok) expect(twice.doc).toEqual(once.doc);
  });

  test("the schema speaks first, one line per problem", () => {
    const out = validatePlay({ id: "p", schemaVersion: 1, stage: {}, cast: {}, scenes: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/stage\.tempo/);
  });

  test("a track for someone not in the cast is rejected", () => {
    bad(
      { scenes: [{ id: "s1", beats: [{ id: "b1", length: 1, tracks: { heron: [{ at: 0, pose: {} }] } }] }] },
      /'heron', who is not in the cast/,
    );
  });

  test("ids a selector could not address are rejected", () => {
    bad({ scenes: [{ id: "s.1", beats: [] }] }, /scene id 's\.1' contains a '\.'/);
    bad({ cast: { "f.x": { ...fox, id: "f.x" } } }, /puppet id 'f\.x' contains a '\.'/);
    bad({ cast: { fox: { ...fox, parts: [{ ...fox.parts[0], id: "tor.so" }] } } }, /part id 'tor\.so' contains a '\.'/);
  });

  test("scene and beat ids may not be reserved selector words", () => {
    expect([...RESERVED_PLAY]).toContain("cast");
    expect([...RESERVED_SCENE]).toContain("beats");
    bad({ scenes: [{ id: "cast", beats: [] }] }, /scene id 'cast' is a reserved/);
    bad({ scenes: [{ id: "s1", beats: [{ id: "beats", length: 1 }] }] }, /beat id 'beats' is a reserved/);
  });

  test("ids are unique, and a cast key is the puppet's own id", () => {
    bad({ scenes: [{ id: "s1", beats: [] }, { id: "s1", beats: [] }] }, /duplicate scene id/);
    bad({ scenes: [{ id: "s1", beats: [{ id: "b1", length: 1 }, { id: "b1", length: 1 }] }] }, /duplicate beat id/);
    bad({ cast: { vixen: fox } }, /the puppet's id is 'fox'/);
  });

  test("geometry checks come from resolvePuppet", () => {
    bad({ cast: { fox: { ...fox, parts: [{ ...fox.parts[0], path: "M0,0 L10,0 Z" }] } } }, /no area/);
    bad({ cast: { fox: { ...fox, parts: [{ ...fox.parts[0], parent: "ghost" }] } } }, /does not exist/);
  });

  test("bounds", () => {
    const keys = Array.from({ length: LIMITS.keys + 1 }, (_, i) => ({ at: i, pose: {} }));
    bad({ scenes: [{ id: "s1", beats: [{ id: "b1", length: 1, tracks: { fox: keys } }] }] }, /over the 64 limit/);
    bad({ scenes: Array.from({ length: LIMITS.scenes + 1 }, (_, i) => ({ id: `s${i}`, beats: [] })) }, /over the 64 limit/);
    bad({ meta: { blob: "x".repeat(LIMITS.bytes + 1) } }, /over the 512 KiB limit/);
  });
});

describe("normalisation", () => {
  test("paths come back canonical and closed", () => {
    const out = validatePlay(doc({
      cast: { fox: { ...fox, parts: [{ id: "torso", parent: null, pivot: [0, 0], path: "m0,0 l10,0 l0,10" }] } },
    }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.doc.cast.fox.parts[0].path).toBe("M0,0 L10,0 L10,10 Z");
  });

  test("tracks and fx come back sorted by `at`", () => {
    const out = validatePlay(doc({
      scenes: [{ id: "s1", beats: [{
        id: "b1", length: 2,
        tracks: { fox: [{ at: 1, pose: {} }, { at: 0, pose: {} }] },
        fx: [{ at: 1.5, type: "lamp" }, { at: 0.5, type: "lamp" }],
      }] }],
    }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const beat = out.doc.scenes[0].beats[0];
    expect(beat.tracks!.fox.map((k) => k.at)).toEqual([0, 1]);
    expect(beat.fx!.map((c) => c.at)).toEqual([0.5, 1.5]);
  });

  test("the input document is not mutated", () => {
    const input = doc({
      cast: { fox: { ...fox, parts: [{ id: "torso", parent: null, pivot: [0, 0], path: "m0,0 l10,0 l0,10" }] } },
    });
    const before = JSON.stringify(input);
    validatePlay(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
