// SVG path data: parse liberally, store canonically (absolute M L Q C Z).
// Spec §1.3. Arcs become cubics, shorthand is expanded, relatives resolved,
// unclosed subpaths get a Z. Bounding boxes and mirroring work on the
// canonical form only, so every downstream consumer sees one small grammar.

import type { Vec } from "./types";

export type Seg =
  | { c: "M"; p: Vec }
  | { c: "L"; p: Vec }
  | { c: "Q"; c1: Vec; p: Vec }
  | { c: "C"; c1: Vec; c2: Vec; p: Vec }
  | { c: "Z" };

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------- tokenizer ----------

interface Tok {
  cmd: string;
  nums: number[];
}

const NUM = /^[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/;

/** Tokenise path data. Arc flags are parsed as single characters, which is the
 *  one place SVG's grammar is not "numbers separated by whitespace". */
function tokenize(d: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = d.length;
  let cur: Tok | null = null;
  const skip = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  while (i < n) {
    skip();
    if (i >= n) break;
    const ch = d[i];
    if (/[a-zA-Z]/.test(ch)) {
      cur = { cmd: ch, nums: [] };
      toks.push(cur);
      i++;
      continue;
    }
    if (!cur) throw new Error(`path: number before any command at ${i}`);
    // Arc flags: positions 3 and 4 of every 7-number group are single digits.
    if ((cur.cmd === "a" || cur.cmd === "A") && (cur.nums.length % 7 === 3 || cur.nums.length % 7 === 4)) {
      if (ch !== "0" && ch !== "1") throw new Error(`path: bad arc flag '${ch}' at ${i}`);
      cur.nums.push(Number(ch));
      i++;
      continue;
    }
    const m = NUM.exec(d.slice(i));
    if (!m) throw new Error(`path: unexpected '${ch}' at ${i}`);
    cur.nums.push(Number(m[0]));
    i += m[0].length;
  }
  return toks;
}

// ---------- parse to canonical ----------

const ARITY: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

/** Parse any SVG path data into canonical absolute segments. Throws on grammar
 *  errors with a human-readable message (this is the parser error the
 *  validator forwards). */
export function parsePath(d: string): Seg[] {
  const toks = tokenize(d);
  const out: Seg[] = [];
  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  let lastC: Vec | null = null; // last cubic control point, for S
  let lastQ: Vec | null = null; // last quadratic control point, for T
  let open = false;

  for (const tok of toks) {
    const upper = tok.cmd.toUpperCase();
    const rel = tok.cmd !== upper;
    const arity = ARITY[upper];
    if (arity === undefined) throw new Error(`path: unknown command '${tok.cmd}'`);
    if (arity === 0) {
      if (tok.nums.length) throw new Error(`path: Z takes no numbers`);
      if (open) out.push({ c: "Z" });
      open = false;
      cx = sx; cy = sy;
      lastC = lastQ = null;
      continue;
    }
    if (tok.nums.length === 0 || tok.nums.length % arity !== 0) {
      throw new Error(`path: '${tok.cmd}' expects multiples of ${arity} numbers, got ${tok.nums.length}`);
    }
    for (let k = 0; k < tok.nums.length; k += arity) {
      const a = tok.nums.slice(k, k + arity);
      const ax = (v: number) => (rel ? cx + v : v);
      const ay = (v: number) => (rel ? cy + v : v);
      let cmd = upper;
      // Implicit lineto after the first moveto pair.
      if (cmd === "M" && k > 0) cmd = "L";
      switch (cmd) {
        case "M": {
          if (open) out.push({ c: "Z" }); // an unclosed subpath gets closed
          cx = ax(a[0]); cy = ay(a[1]);
          sx = cx; sy = cy;
          out.push({ c: "M", p: [cx, cy] });
          open = true;
          lastC = lastQ = null;
          break;
        }
        case "L": {
          cx = ax(a[0]); cy = ay(a[1]);
          out.push({ c: "L", p: [cx, cy] });
          lastC = lastQ = null;
          break;
        }
        case "H": {
          cx = ax(a[0]);
          out.push({ c: "L", p: [cx, cy] });
          lastC = lastQ = null;
          break;
        }
        case "V": {
          cy = ay(a[0]);
          out.push({ c: "L", p: [cx, cy] });
          lastC = lastQ = null;
          break;
        }
        case "C": {
          const c1: Vec = [ax(a[0]), ay(a[1])];
          const c2: Vec = [ax(a[2]), ay(a[3])];
          cx = ax(a[4]); cy = ay(a[5]);
          out.push({ c: "C", c1, c2, p: [cx, cy] });
          lastC = c2; lastQ = null;
          break;
        }
        case "S": {
          const c1: Vec = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
          const c2: Vec = [ax(a[0]), ay(a[1])];
          cx = ax(a[2]); cy = ay(a[3]);
          out.push({ c: "C", c1, c2, p: [cx, cy] });
          lastC = c2; lastQ = null;
          break;
        }
        case "Q": {
          const c1: Vec = [ax(a[0]), ay(a[1])];
          cx = ax(a[2]); cy = ay(a[3]);
          out.push({ c: "Q", c1, p: [cx, cy] });
          lastQ = c1; lastC = null;
          break;
        }
        case "T": {
          const c1: Vec = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
          cx = ax(a[0]); cy = ay(a[1]);
          out.push({ c: "Q", c1, p: [cx, cy] });
          lastQ = c1; lastC = null;
          break;
        }
        case "A": {
          const x2 = ax(a[5]), y2 = ay(a[6]);
          for (const seg of arcToCubics(cx, cy, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, x2, y2)) out.push(seg);
          cx = x2; cy = y2;
          lastC = lastQ = null;
          break;
        }
      }
      if (!open && cmd !== "M") {
        // Drawing without a moveto: treat the current point as a start.
        // (Only reachable for malformed input; keep it renderable.)
        open = true;
        sx = cx; sy = cy;
      }
    }
  }
  if (open) out.push({ c: "Z" });
  return out;
}

/** Elliptical arc → one or more cubic béziers (SVG implementation notes F.6). */
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, phiDeg: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): Seg[] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ c: "L", p: [x2, y2] }];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const d = ux * vx + uy * vy;
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, d / l)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dtheta) / (Math.PI / 2));
  const delta = dtheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: Seg[] = [];
  let th = theta1;
  for (let i = 0; i < segs; i++) {
    const cos1 = Math.cos(th), sin1 = Math.sin(th);
    const cos2 = Math.cos(th + delta), sin2 = Math.sin(th + delta);
    const e1x = cos1 - t * sin1, e1y = sin1 + t * cos1;
    const e2x = cos2 + t * sin2, e2y = sin2 - t * cos2;
    const map = (ex: number, ey: number): Vec => [
      cosP * rx * ex - sinP * ry * ey + cx,
      sinP * rx * ex + cosP * ry * ey + cy,
    ];
    const p = i === segs - 1 ? ([x2, y2] as Vec) : map(cos2, sin2);
    out.push({ c: "C", c1: map(e1x, e1y), c2: map(e2x, e2y), p });
    th += delta;
  }
  return out;
}

// ---------- serialise, transform, measure ----------

const f = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

export function serializePath(segs: Seg[]): string {
  const parts: string[] = [];
  for (const s of segs) {
    switch (s.c) {
      case "M": case "L": parts.push(`${s.c}${f(s.p[0])},${f(s.p[1])}`); break;
      case "Q": parts.push(`Q${f(s.c1[0])},${f(s.c1[1])} ${f(s.p[0])},${f(s.p[1])}`); break;
      case "C": parts.push(`C${f(s.c1[0])},${f(s.c1[1])} ${f(s.c2[0])},${f(s.c2[1])} ${f(s.p[0])},${f(s.p[1])}`); break;
      case "Z": parts.push("Z"); break;
    }
  }
  return parts.join(" ");
}

/** Parse and re-serialise: the stored form. */
export function canonicalPath(d: string): string {
  return serializePath(parsePath(d));
}

export function mapPath(segs: Seg[], fn: (p: Vec) => Vec): Seg[] {
  return segs.map((s) => {
    switch (s.c) {
      case "M": case "L": return { c: s.c, p: fn(s.p) };
      case "Q": return { c: "Q", c1: fn(s.c1), p: fn(s.p) };
      case "C": return { c: "C", c1: fn(s.c1), c2: fn(s.c2), p: fn(s.p) };
      case "Z": return s;
    }
  });
}

/** Reflect across the local Y axis (x → −x). Winding flips, which is fine
 *  under nonzero for a single contour and preserves holes made by reversed
 *  subpaths since both flip together. */
export function mirrorPath(segs: Seg[]): Seg[] {
  return mapPath(segs, ([x, y]) => [-x, y]);
}

function extrema1(p0: number, p1: number, p2: number, p3: number): number[] {
  // roots of derivative of cubic bezier in [0,1]
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Exact bounding box of the filled contour (curve extrema, not control hulls). */
export function pathBBox(segs: Seg[]): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  let cur: Vec = [0, 0];
  for (const s of segs) {
    if (s.c === "Z") continue;
    if (s.c === "M" || s.c === "L") { add(s.p[0], s.p[1]); cur = s.p; continue; }
    // promote quadratic to cubic
    const c1: Vec = s.c === "Q" ? [cur[0] + (2 / 3) * (s.c1[0] - cur[0]), cur[1] + (2 / 3) * (s.c1[1] - cur[1])] : s.c1;
    const c2: Vec = s.c === "Q" ? [s.p[0] + (2 / 3) * (s.c1[0] - s.p[0]), s.p[1] + (2 / 3) * (s.c1[1] - s.p[1])] : s.c2;
    add(s.p[0], s.p[1]);
    for (const t of extrema1(cur[0], c1[0], c2[0], s.p[0])) add(cubicAt(cur[0], c1[0], c2[0], s.p[0], t), cubicAt(cur[1], c1[1], c2[1], s.p[1], t));
    for (const t of extrema1(cur[1], c1[1], c2[1], s.p[1])) add(cubicAt(cur[0], c1[0], c2[0], s.p[0], t), cubicAt(cur[1], c1[1], c2[1], s.p[1], t));
    cur = s.p;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Flatten to polylines (one per subpath) for area checks and hit-testing. */
export function flattenPath(segs: Seg[], steps = 8): Vec[][] {
  const polys: Vec[][] = [];
  let poly: Vec[] = [];
  let cur: Vec = [0, 0];
  for (const s of segs) {
    switch (s.c) {
      case "M": if (poly.length) polys.push(poly); poly = [s.p]; cur = s.p; break;
      case "L": poly.push(s.p); cur = s.p; break;
      case "Q": case "C": {
        const c1: Vec = s.c === "Q" ? [cur[0] + (2 / 3) * (s.c1[0] - cur[0]), cur[1] + (2 / 3) * (s.c1[1] - cur[1])] : s.c1;
        const c2: Vec = s.c === "Q" ? [s.p[0] + (2 / 3) * (s.c1[0] - s.p[0]), s.p[1] + (2 / 3) * (s.c1[1] - s.p[1])] : s.c2;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          poly.push([cubicAt(cur[0], c1[0], c2[0], s.p[0], t), cubicAt(cur[1], c1[1], c2[1], s.p[1], t)]);
        }
        cur = s.p;
        break;
      }
      case "Z": if (poly.length) polys.push(poly); poly = []; break;
    }
  }
  if (poly.length) polys.push(poly);
  return polys;
}

/** Sum of |signed area| over subpaths. Zero means a degenerate contour. */
export function pathArea(segs: Seg[]): number {
  let total = 0;
  for (const poly of flattenPath(segs)) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      a += x1 * y2 - x2 * y1;
    }
    total += Math.abs(a) / 2;
  }
  return total;
}
