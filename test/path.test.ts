import { describe, expect, test } from "bun:test";
import {
  canonicalPath, flattenPath, mirrorPath, parsePath, pathArea, pathBBox, serializePath,
} from "../src/model/path";

const cmds = (d: string) => parsePath(d).map((s) => s.c).join("");

describe("parsePath — grammar", () => {
  test("absolute M L Z survive unchanged", () => {
    expect(canonicalPath("M0,0 L10,0 L10,10 Z")).toBe("M0,0 L10,0 L10,10 Z");
  });

  test("relative commands resolve against the current point", () => {
    expect(canonicalPath("m10,10 l5,0 l0,5 z")).toBe("M10,10 L15,10 L15,15 Z");
  });

  test("H and V become L", () => {
    expect(canonicalPath("M0,0 H10 V10 h-10 z")).toBe("M0,0 L10,0 L10,10 L0,10 Z");
  });

  test("extra coordinate pairs after M are implicit linetos", () => {
    expect(cmds("M0,0 5,5 10,0")).toBe("MLLZ");
  });

  test("S reflects the previous cubic control point", () => {
    const segs = parsePath("M0,0 C0,5 5,5 5,0 S10,-5 10,0");
    const s = segs[2];
    expect(s.c).toBe("C");
    if (s.c === "C") expect(s.c1).toEqual([5, -5]);
  });

  test("T reflects the previous quadratic control point", () => {
    const segs = parsePath("M0,0 Q5,5 10,0 T20,0");
    const s = segs[2];
    expect(s.c).toBe("Q");
    if (s.c === "Q") expect(s.c1).toEqual([15, -5]);
  });

  test("an unclosed subpath is closed, and a new M closes the previous one", () => {
    expect(cmds("M0,0 L10,0 L10,10")).toBe("MLLZ");
    expect(cmds("M0,0 L10,0 M20,0 L30,0")).toBe("MLZMLZ");
  });

  test("Z returns the current point to the subpath start", () => {
    // the l5,0 after Z is relative to (0,0), not to (10,0)
    expect(canonicalPath("M0,0 L10,0 Z l5,0 z")).toBe("M0,0 L10,0 Z L5,0 Z");
  });

  test("arcs become cubics with the right endpoint and extent", () => {
    const segs = parsePath("M0,0 A5,5 0 0 1 10,0");
    expect(segs.every((s) => s.c === "M" || s.c === "C" || s.c === "Z")).toBe(true);
    const b = pathBBox(segs)!;
    expect(b.w).toBeCloseTo(10, 6);
    expect(b.h).toBeCloseTo(5, 2);
    // a semicircle of r=5, flattened
    expect(pathArea(segs)).toBeCloseTo((Math.PI * 25) / 2, 0);
  });

  test("a zero-radius arc degrades to a line", () => {
    expect(cmds("M0,0 A0,0 0 0 1 10,0")).toBe("MLZ");
  });

  test("grammar errors are reported, not swallowed", () => {
    expect(() => parsePath("10,10")).toThrow(/number before any command/);
    expect(() => parsePath("M0,0 X1,1")).toThrow(/unknown command/);
    expect(() => parsePath("M0,0 L10")).toThrow(/multiples of 2/);
    expect(() => parsePath("M0,0 Z5")).toThrow(/Z takes no numbers/);
    expect(() => parsePath("M0,0 A5,5 0 2 1 10,0")).toThrow(/bad arc flag/);
  });
});

describe("canonical form", () => {
  const samples = [
    "M0,0 L10,0 L10,10 Z",
    "m10,10 l5,0 l0,5 z",
    "M0,0 Q5,5 10,0 T20,0",
    "M0,0 A5,5 0 0 1 10,0",
    "M0,0 C0,5 5,5 5,0 S10,-5 10,0",
    "M-5,0 H5 V20 H-5 Z",
  ];

  test("is idempotent", () => {
    for (const d of samples) expect(canonicalPath(canonicalPath(d))).toBe(canonicalPath(d));
  });

  test("round-trips through parse/serialize", () => {
    for (const d of samples) expect(serializePath(parsePath(canonicalPath(d)))).toBe(canonicalPath(d));
  });

  test("negative zero is normalised", () => {
    expect(canonicalPath("M-0.0001,0 L10,0 L10,10 Z")).toBe("M0,0 L10,0 L10,10 Z");
  });
});

describe("mirrorPath", () => {
  test("negates x and leaves y", () => {
    expect(serializePath(mirrorPath(parsePath("M1,2 L3,4 Z")))).toBe("M-1,2 L-3,4 Z");
  });

  test("is its own inverse", () => {
    const d = "M0,0 C0,5 5,5 5,0 Q7,3 10,0 Z";
    const segs = parsePath(d);
    expect(serializePath(mirrorPath(mirrorPath(segs)))).toBe(serializePath(segs));
  });

  test("preserves area and reflects the bounding box", () => {
    const segs = parsePath("M2,0 L8,0 L8,20 L2,20 Z");
    const b = pathBBox(mirrorPath(segs))!;
    expect(b.x).toBeCloseTo(-8, 10);
    expect(b.w).toBeCloseTo(6, 10);
    expect(pathArea(mirrorPath(segs))).toBeCloseTo(pathArea(segs), 10);
  });
});

describe("pathBBox", () => {
  test("is tight on polygons", () => {
    expect(pathBBox(parsePath("M0,0 L10,0 L10,20 L0,20 Z"))).toEqual({ x: 0, y: 0, w: 10, h: 20 });
  });

  test("uses curve extrema, not the control hull", () => {
    // apex of this quadratic is y=5, though the control point is at y=10
    const b = pathBBox(parsePath("M0,0 Q5,10 10,0"))!;
    expect(b.y).toBeCloseTo(0, 10);
    expect(b.h).toBeCloseTo(5, 10);
    expect(b.w).toBeCloseTo(10, 10);
  });

  test("is null for an empty path", () => {
    expect(pathBBox([])).toBeNull();
  });
});

describe("pathArea", () => {
  test("measures the filled contour regardless of winding", () => {
    expect(pathArea(parsePath("M0,0 L10,0 L10,20 L0,20 Z"))).toBeCloseTo(200, 6);
    expect(pathArea(parsePath("M0,0 L0,20 L10,20 L10,0 Z"))).toBeCloseTo(200, 6);
  });

  test("is zero for a degenerate contour", () => {
    expect(pathArea(parsePath("M0,0 L10,0 Z"))).toBeCloseTo(0, 9);
    expect(pathArea(parsePath("M3,3 L3,3 Z"))).toBeCloseTo(0, 9);
  });

  test("sums subpaths", () => {
    expect(pathArea(parsePath("M0,0 L10,0 L10,10 L0,10 Z M20,0 L30,0 L30,10 L20,10 Z"))).toBeCloseTo(200, 6);
  });
});

describe("flattenPath", () => {
  test("yields one polyline per subpath", () => {
    const polys = flattenPath(parsePath("M0,0 L10,0 Z M20,0 L30,0 Z"));
    expect(polys.length).toBe(2);
    expect(polys[0][0]).toEqual([0, 0]);
  });

  test("samples curves at the requested resolution", () => {
    expect(flattenPath(parsePath("M0,0 Q5,10 10,0"), 4)[0].length).toBe(5);
    expect(flattenPath(parsePath("M0,0 Q5,10 10,0"), 16)[0].length).toBe(17);
  });
});
