// Sweep every shipped fixture: it must validate, resolve, and evaluate to
// finite, well-formed geometry at every point on its timeline. These are the
// checks that would catch a bad edit to a fixture or a regression in the
// engine, without pinning any number a tuning pass is allowed to change.

import { describe, expect, test } from "bun:test";
import { STAGE_H } from "../src/engine/evaluate";
import { apply, type Mat } from "../src/engine/math";
import { resolvePuppet } from "../src/model/puppet";
import { evaluatorFor, loadPlay, playFiles } from "./helpers";

const finite = (m: Mat) => m.every((v) => Number.isFinite(v));

for (const file of playFiles) {
  describe(file, () => {
    test("validates, resolves, and has a non-empty timeline", async () => {
      const play = await loadPlay(file);
      expect(Object.keys(play.cast).length).toBeGreaterThan(0);
      for (const [id, p] of Object.entries(play.cast)) expect(() => resolvePuppet({ ...p, id })).not.toThrow();
      const ev = evaluatorFor(play);
      expect(ev.durationSeconds).toBeGreaterThan(0);
      expect(ev.tl.spans.length).toBeGreaterThan(0);
    });

    test("every cast member is keyed, and every keyed track names a cast member", async () => {
      const play = await loadPlay(file);
      const ev = evaluatorFor(play);
      for (const id of Object.keys(play.cast)) expect(ev.tl.tracks.has(id)).toBe(true);
      for (const id of ev.tl.tracks.keys()) expect(play.cast[id]).toBeDefined();
    });

    test("every keyed joint names a real part", async () => {
      const play = await loadPlay(file);
      const ev = evaluatorFor(play);
      for (const [id, keys] of ev.tl.tracks) {
        const puppet = resolvePuppet({ ...play.cast[id], id });
        for (const joint of Object.keys(keys[keys.length - 1].joints)) {
          expect(puppet.parts.has(joint)).toBe(true);
        }
      }
    });

    test("geometry stays finite and connected across the whole play", async () => {
      const ev = evaluatorFor(await loadPlay(file));
      const end = ev.durationSeconds;
      for (let t = 0; t <= end + 0.5; t += end / 40) {
        const f = ev.frame(Math.min(t, end));
        expect(Number.isFinite(f.lamp)).toBe(true);
        expect(f.lamp).toBeGreaterThanOrEqual(0);
        expect(f.lamp).toBeLessThanOrEqual(1);
        for (const fp of f.puppets) {
          expect(finite(fp.root)).toBe(true);
          const world = new Map<string, Mat>(fp.parts.map((p) => [p.part.id, p.world]));
          for (const { part, angle, world: m } of fp.parts) {
            expect(Number.isFinite(angle)).toBe(true);
            expect(finite(m)).toBe(true);
            if (!part.parent) continue;
            const [px, py] = apply(world.get(part.parent)!, part.pivot);
            const [cx, cy] = apply(m, [0, 0]);
            expect(cx).toBeCloseTo(px, 6);
            expect(cy).toBeCloseTo(py, 6);
          }
          for (const rod of fp.rods) {
            expect([rod.x1, rod.y1, rod.x2, rod.y2, rod.width].every(Number.isFinite)).toBe(true);
            expect(rod.y2).toBeGreaterThan(STAGE_H);
          }
        }
      }
    });

    test("scrubbing anywhere gives the same frame as playing there", async () => {
      const ev = evaluatorFor(await loadPlay(file));
      const fresh = evaluatorFor(await loadPlay(file));
      const end = ev.durationSeconds;
      const probe = Math.min(end, end * 0.7);
      const angles = (e: typeof ev) => e.frame(probe).puppets.flatMap((p) => p.parts.map((x) => x.angle));
      const want = angles(fresh);
      for (const t of [end, 0, end * 0.3, end * 0.9, 0.1]) ev.frame(t);
      for (const [i, a] of angles(ev).entries()) expect(a).toBeCloseTo(want[i], 5);
    });
  });
}

describe("fixture coverage of the failure modes in spec §6.1", () => {
  test("between them the fixtures exercise swing, mirrorOf, planes and hand rods", async () => {
    const plays = await Promise.all(playFiles.map(loadPlay));
    const puppets = plays.flatMap((p) => Object.entries(p.cast).map(([id, c]) => resolvePuppet({ ...c, id })));
    expect(puppets.some((p) => p.ordered.some((x) => x.swing > 0))).toBe(true);
    expect(puppets.some((p) => p.ordered.some((x) => x.mirrored))).toBe(true);
    expect(puppets.some((p) => p.rods.length > 1)).toBe(true);
    const planes = new Set(plays.flatMap((p) => [...evaluatorFor(p).tl.tracks.values()].flatMap((ks) => ks.map((k) => k.root.plane))));
    expect(planes).toEqual(new Set(["far", "mid", "near"]));
  });
});
