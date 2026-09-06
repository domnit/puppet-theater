import { describe, expect, test } from "bun:test";
import {
  IDENTITY, apply, det, ease, hash01, headingOfY, lerp, lerpAngle, magnitude,
  matToString, mul, rotate, scale, translate, wrap180,
} from "../src/engine/math";

describe("matrices", () => {
  test("mul applies the right operand first", () => {
    // translate-then-rotate is not rotate-then-translate
    const [mx, my] = apply(mul(rotate(90), translate(10, 0)), [0, 0]);
    expect(mx).toBeCloseTo(0, 10);
    expect(my).toBeCloseTo(10, 10);
    const [nx, ny] = apply(mul(translate(10, 0), rotate(90)), [0, 0]);
    expect(nx).toBeCloseTo(10, 10);
    expect(ny).toBeCloseTo(0, 10);
  });

  test("rotate is clockwise on screen (SVG y-down)", () => {
    const [x, y] = apply(rotate(90), [1, 0]);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  test("magnitude recovers uniform scale; det sign flags a mirror", () => {
    expect(magnitude(mul(rotate(37), scale(3)))).toBeCloseTo(3, 10);
    expect(det(scale(-1, 1))).toBeLessThan(0);
    expect(magnitude(scale(-2, 2))).toBeCloseTo(2, 10);
  });

  test("headingOfY reports the world heading of local +Y", () => {
    expect(headingOfY(IDENTITY)).toBeCloseTo(0, 10);
    expect(headingOfY(rotate(90))).toBeCloseTo(90, 10);
    expect(headingOfY(rotate(-30))).toBeCloseTo(-30, 10);
    // Uniform scale must not change the reported heading.
    expect(headingOfY(mul(rotate(20), scale(4)))).toBeCloseTo(20, 10);
  });

  test("matToString rounds and keeps SVG order", () => {
    expect(matToString([1, 0, 0, 1, 2.000049, 3])).toBe("matrix(1 0 0 1 2 3)");
  });
});

describe("angles", () => {
  test("wrap180 lands in (-180, 180]", () => {
    expect(wrap180(0)).toBe(0);
    expect(wrap180(190)).toBe(-170);
    expect(wrap180(-190)).toBe(170);
    expect(wrap180(540)).toBe(180);
    expect(wrap180(-180)).toBe(180);
    expect(wrap180(720 + 45)).toBeCloseTo(45, 10);
  });

  test("lerpAngle takes the short way round", () => {
    expect(lerpAngle(170, -170, 0.5)).toBeCloseTo(180, 10);
    expect(lerpAngle(-170, 170, 0.5)).toBeCloseTo(180, 10);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0, 10);
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45, 10);
  });

  test("lerpAngle endpoints are exact", () => {
    expect(lerpAngle(-26, 44, 0)).toBeCloseTo(-26, 10);
    expect(lerpAngle(-26, 44, 1)).toBeCloseTo(44, 10);
  });

  test("lerp is plain linear", () => {
    expect(lerp(2, 4, 0.25)).toBe(2.5);
  });
});

describe("easing", () => {
  test("every curve is pinned at both ends and clamped outside", () => {
    for (const k of ["linear", "in", "out", "inOut", "hold"] as const) {
      expect(ease(k, 0)).toBe(0);
      expect(ease(k, 1)).toBe(1);
      expect(ease(k, -3)).toBe(0);
      expect(ease(k, 3)).toBe(1);
    }
  });

  test("hold holds until the key, inOut is symmetric, in/out bracket linear", () => {
    expect(ease("hold", 0.99)).toBe(0);
    expect(ease("inOut", 0.5)).toBeCloseTo(0.5, 10);
    expect(ease("inOut", 0.25) + ease("inOut", 0.75)).toBeCloseTo(1, 10);
    expect(ease("in", 0.5)).toBeLessThan(0.5);
    expect(ease("out", 0.5)).toBeGreaterThan(0.5);
  });

  test("undefined means inOut", () => {
    expect(ease(undefined, 0.3)).toBe(ease("inOut", 0.3));
  });
});

describe("hash01", () => {
  test("is deterministic, in range, and spread across ids", () => {
    expect(hash01("keeper")).toBe(hash01("keeper"));
    const vals = ["keeper", "fox", "keeper/arm_near", "keeper/arm_far", "a", "b"].map(hash01);
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(vals).size).toBe(vals.length);
    expect(hash01("")).toBeGreaterThanOrEqual(0);
  });
});
