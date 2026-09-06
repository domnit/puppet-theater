// Loads the real library/ directory (curated by a separate agent, in
// progress alongside this one) and checks whatever is there validates and
// resolves. Tolerant of an empty or partial library.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { loadLibrary } from "../src/library";
import { resolvePuppet } from "../src/model/puppet";
import { PuppetSchema } from "../src/model/types";

const libDir = path.resolve(import.meta.dir, "..", "library");

describe("loadLibrary", () => {
  test("every puppet in library/puppets validates and resolves", () => {
    const { puppets } = loadLibrary(libDir);
    for (const lp of puppets) {
      expect(lp.puppet.id).toBe(lp.id);
      expect(lp.version).toBeGreaterThanOrEqual(1);
      expect(() => resolvePuppet(lp.puppet)).not.toThrow();
    }
  });

  test("every part in library/parts validates and resolves, wrapped in a minimal puppet", () => {
    const { parts } = loadLibrary(libDir);
    for (const lp of parts) {
      expect(lp.parts[0].parent).toBeNull();
      const wrapped = PuppetSchema.parse({ id: lp.id, unit: lp.unit, cap: 2, note: lp.note, parts: lp.parts });
      expect(() => resolvePuppet(wrapped)).not.toThrow();
    }
  });

  test("tolerant of a missing or empty directory", () => {
    const empty = loadLibrary(path.join(libDir, "..", "no-such-library-dir"));
    expect(empty).toEqual({ puppets: [], parts: [] });
  });
});
