// Small numeric toolkit: 2D affine matrices (SVG order), angles, easing, hashing.

import type { Ease, Vec } from "../model/types";

/** SVG matrix(a b c d e f): x' = a x + c y + e ; y' = b x + d y + f */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m · n — apply n first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export function translate(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}
export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}
export function scale(sx: number, sy = sx): Mat {
  return [sx, 0, 0, sy, 0, 0];
}
export function apply(m: Mat, p: Vec): Vec {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}
export function det(m: Mat): number {
  return m[0] * m[3] - m[1] * m[2];
}
/** Uniform scale magnitude of the linear part (assumes near-uniform scaling). */
export function magnitude(m: Mat): number {
  return Math.sqrt(Math.abs(det(m)));
}
/** World heading of local +Y, in degrees, clockwise-positive on screen (SVG). */
export function headingOfY(m: Mat): number {
  // local (0,1) → (c, d). Angle from +Y axis, clockwise positive: atan2(-x, y).
  return (Math.atan2(-m[2], m[3]) * 180) / Math.PI;
}
export function matToString(m: Mat): string {
  return `matrix(${m.map((v) => Math.round(v * 1e4) / 1e4).join(" ")})`;
}

// ---------- angles ----------

export function wrap180(a: number): number {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}
/** Interpolate along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = wrap180(b - a);
  return wrap180(a + d * t);
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------- easing ----------

export function ease(kind: Ease | undefined, t: number): number {
  t = clamp(t, 0, 1);
  switch (kind) {
    case "linear": return t;
    case "in": return t * t * t;
    case "out": { const u = 1 - t; return 1 - u * u * u; }
    case "hold": return t < 1 ? 0 : 1;
    case "inOut":
    default:
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}

// ---------- deterministic hashing ----------

/** FNV-1a → [0, 1). Used to seed procedural phases from ids, never Math.random(). */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}
