// Resolve a puppet document into something the renderer can walk: canonical
// paths, mirrored contours materialised, tree order, depth, bounding boxes.
// Also the "only what the renderer cannot survive" checks from spec §2.3.

import type { BBox, Seg } from "./path";
import { mirrorPath, parsePath, pathArea, pathBBox, serializePath } from "./path";
import type { Part, Puppet, Vec } from "./types";

export interface ResolvedPart {
  id: string;
  parent: string | null;
  pivot: Vec;
  z: number;
  note: string;
  swing: number;
  /** Control rod attach point in this part's frame, when the part carries one. */
  rod?: Vec;
  /** Rod-bearing parts in this part's subtree (including itself) — what drives
   *  it. Empty means nothing holds this part: it can only swing. */
  drivenBy: string[];
  /** True when the contour came from `mirrorOf` rather than an own `path`. */
  mirrored: boolean;
  mirrorOf?: string;
  segs: Seg[];
  /** Canonical path data string, ready for a `d` attribute. */
  d: string;
  /** Local-frame bounding box of the contour unioned with the cap disc. */
  bbox: BBox;
  depth: number;
  children: string[];
  /** Index in tree (pre-order) — stable ordering when z ties. */
  order: number;
}

export interface ResolvedPuppet {
  id: string;
  name: string;
  note: string;
  unit: number;
  cap: number;
  restPose: Record<string, number>;
  idle: number;
  opacity: number;
  parts: Map<string, ResolvedPart>;
  /** Pre-order traversal from roots. */
  ordered: ResolvedPart[];
  roots: ResolvedPart[];
  /** Rod-bearing parts, main rods first, in tree order. */
  rods: ResolvedPart[];
  /** Rest-pose matrix of every part in the root frame, local units. */
  rest: Map<string, Mat>;
  /** Whole-puppet extent at rest, in local units of the root frame. */
  extent: BBox;
  source: Puppet;
}

export class PuppetError extends Error {
  constructor(public puppetId: string, public partId: string | null, message: string) {
    super(partId ? `${puppetId}/${partId}: ${message}` : `${puppetId}: ${message}`);
  }
}

const MAX_PARTS = 64;

export function resolvePuppet(p: Puppet): ResolvedPuppet {
  if (!Array.isArray(p.parts) || p.parts.length === 0) throw new PuppetError(p.id, null, "puppet has no parts");
  if (p.parts.length > MAX_PARTS) throw new PuppetError(p.id, null, `too many parts (${p.parts.length} > ${MAX_PARTS})`);
  const byId = new Map<string, Part>();
  for (const part of p.parts) {
    if (byId.has(part.id)) throw new PuppetError(p.id, part.id, "duplicate part id");
    byId.set(part.id, part);
  }
  // Parent resolution and acyclicity.
  for (const part of p.parts) {
    if (part.parent !== null && part.parent !== undefined && !byId.has(part.parent)) {
      throw new PuppetError(p.id, part.id, `parent '${part.parent}' does not exist`);
    }
    const seen = new Set<string>([part.id]);
    let cur = part.parent ?? null;
    while (cur) {
      if (seen.has(cur)) throw new PuppetError(p.id, part.id, "part tree has a cycle");
      seen.add(cur);
      cur = byId.get(cur)!.parent ?? null;
    }
  }
  // Contours: own path wins; otherwise mirror; the mirror source must have a path of its own.
  const segsOf = new Map<string, Seg[]>();
  for (const part of p.parts) {
    let segs: Seg[];
    if (typeof part.path === "string" && part.path.trim()) {
      try {
        segs = parsePath(part.path);
      } catch (e) {
        throw new PuppetError(p.id, part.id, (e as Error).message);
      }
    } else if (part.mirrorOf) {
      const src = byId.get(part.mirrorOf);
      if (!src) throw new PuppetError(p.id, part.id, `mirrorOf '${part.mirrorOf}' does not exist`);
      if (typeof src.path !== "string" || !src.path.trim()) throw new PuppetError(p.id, part.id, `mirrorOf '${part.mirrorOf}' has no path of its own`);
      try {
        segs = mirrorPath(parsePath(src.path));
      } catch (e) {
        throw new PuppetError(p.id, src.id, (e as Error).message);
      }
    } else {
      throw new PuppetError(p.id, part.id, "part has neither path nor mirrorOf");
    }
    if (pathArea(segs) < 1e-6) throw new PuppetError(p.id, part.id, "contour has no area");
    segsOf.set(part.id, segs);
  }

  const cap = Number(p.cap) || 0;
  const parts = new Map<string, ResolvedPart>();
  const childrenOf = new Map<string | null, Part[]>();
  for (const part of p.parts) {
    const key = part.parent ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(part);
  }
  const ordered: ResolvedPart[] = [];
  const visit = (part: Part, depth: number) => {
    const segs = segsOf.get(part.id)!;
    const pb = pathBBox(segs) ?? { x: 0, y: 0, w: 0, h: 0 };
    const minX = Math.min(pb.x, -cap), minY = Math.min(pb.y, -cap);
    const maxX = Math.max(pb.x + pb.w, cap), maxY = Math.max(pb.y + pb.h, cap);
    const rp: ResolvedPart = {
      id: part.id,
      parent: part.parent ?? null,
      pivot: [Number(part.pivot?.[0]) || 0, Number(part.pivot?.[1]) || 0],
      z: Number(part.z) || 0,
      note: part.note ?? "",
      swing: Number(part.swing) || 0,
      rod: part.rod ? [Number(part.rod[0]) || 0, Number(part.rod[1]) || 0] : depth === 0 ? [0, 0] : undefined,
      drivenBy: [],
      mirrored: !(typeof part.path === "string" && part.path.trim()) && !!part.mirrorOf,
      mirrorOf: part.mirrorOf,
      segs,
      d: serializePath(segs),
      bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      depth,
      children: (childrenOf.get(part.id) ?? []).map((c) => c.id),
      order: ordered.length,
    };
    parts.set(part.id, rp);
    ordered.push(rp);
    for (const c of childrenOf.get(part.id) ?? []) visit(c, depth + 1);
  };
  const roots = childrenOf.get(null) ?? [];
  if (roots.length === 0) throw new PuppetError(p.id, null, "puppet has no root part");
  for (const r of roots) visit(r, 0);
  // A rod at a part holds that part and the whole chain up to the root.
  for (const part of ordered) {
    if (!part.rod) continue;
    for (let cur: ResolvedPart | undefined = part; cur; cur = cur.parent ? parts.get(cur.parent) : undefined) cur.drivenBy.push(part.id);
  }

  const resolved: ResolvedPuppet = {
    id: p.id,
    name: p.name ?? p.id,
    note: p.note ?? "",
    unit: Number(p.unit) || 100,
    cap,
    restPose: p.restPose ?? {},
    idle: p.look?.idle ?? 1,
    opacity: p.look?.opacity ?? 1,
    parts,
    ordered,
    roots: roots.map((r) => parts.get(r.id)!),
    rods: ordered.filter((x) => x.rod).sort((a, b) => Number(b.depth === 0) - Number(a.depth === 0) || a.order - b.order),
    rest: new Map(),
    extent: { x: 0, y: 0, w: 0, h: 0 },
    source: p,
  };
  resolved.rest = restMatrices(resolved);
  resolved.extent = restExtent(resolved);
  return resolved;
}

// ---------- rest geometry (local units, root frame) ----------

import { apply, mul, rotate, translate, type Mat } from "../engine/math";

/** World-of-root matrices for every part in the rest pose, in local units. */
export function restMatrices(p: ResolvedPuppet): Map<string, Mat> {
  const out = new Map<string, Mat>();
  for (const part of p.ordered) {
    const parentM: Mat = part.parent ? out.get(part.parent)! : [1, 0, 0, 1, 0, 0];
    const a = p.restPose[part.id] ?? 0;
    out.set(part.id, mul(mul(parentM, translate(part.pivot[0], part.pivot[1])), rotate(a)));
  }
  return out;
}

export function restExtent(p: ResolvedPuppet): BBox {
  const ms = p.rest.size ? p.rest : restMatrices(p);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of p.ordered) {
    const m = ms.get(part.id)!;
    const b = part.bbox;
    for (const c of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]] as Vec[]) {
      const [x, y] = apply(m, c);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
