// The `read_play` projection — spec §3. Projects a Play doc into plain JSON,
// narrowed by an optional selector and shaped by a depth. Never returns raw
// part `path` data unless the caller asked for it by id (`include_paths`);
// puppet/part reads carry derived rest geometry from `resolvePuppet`, and the
// unheld-motion warning ported from `src/harness/main.ts`'s `stillKeyedRange`.

import { apply, headingOfY, wrap180 } from "../engine/math";
import { STAGE_H, STAGE_W } from "../engine/evaluate";
import { buildTimeline } from "../engine/timeline";
import type { BBox } from "../model/path";
import { PuppetError, resolvePuppet, type ResolvedPart, type ResolvedPuppet } from "../model/puppet";
import type { Beat, Keyframe, Play, Puppet, Scene } from "../model/types";
import { parseSelector, resolveValue } from "./selector";

export type Depth = "play" | "scene" | "beat" | "key";

export interface ReadOptions {
  sel?: string;
  depth?: Depth;
  include_paths?: string[];
}

/** Largest keyed step of a joint between consecutive keys while the root
 *  stands still, degrees — spec §1.1's "unheld motion" check. */
const UNHELD_WARN_DEG = 12;
const STILL_PX = 4;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundBBox(b: BBox): BBox {
  return { x: round1(b.x), y: round1(b.y), w: round1(b.w), h: round1(b.h) };
}

// ---------- per-puppet resolution + warnings, over the whole doc ----------

interface PuppetInfo {
  resolved: ResolvedPuppet | null;
  warnings: string[];
}

/** Resolve every cast member and compute unheld-motion warnings from the
 *  play's full timeline. Always over the whole doc, even when a `sel` will
 *  only surface one puppet — the check needs every key on the puppet's track. */
function analyzeCast(doc: Play): Map<string, PuppetInfo> {
  const out = new Map<string, PuppetInfo>();
  const timeline = buildTimeline(doc);
  for (const [id, puppetDoc] of Object.entries(doc.cast)) {
    let resolved: ResolvedPuppet;
    try {
      resolved = resolvePuppet(puppetDoc);
    } catch (e) {
      out.set(id, { resolved: null, warnings: [e instanceof PuppetError ? e.message : String(e)] });
      continue;
    }
    const warnings: string[] = [];
    const track = timeline.tracks.get(id) ?? [];
    const worst = new Map<string, number>();
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1], b = track[i];
      const moved = Math.abs(b.root.x - a.root.x) * STAGE_W + Math.abs(b.root.y - a.root.y) * STAGE_H;
      if (moved > STILL_PX) continue;
      for (const j of new Set([...Object.keys(a.joints), ...Object.keys(b.joints)])) {
        const d = Math.abs(wrap180((b.joints[j] ?? 0) - (a.joints[j] ?? 0)));
        if (d > (worst.get(j) ?? 0)) worst.set(j, d);
      }
    }
    for (const [partId, deg] of worst) {
      const part = resolved.parts.get(partId);
      if (!part || part.drivenBy.length > 0 || deg <= UNHELD_WARN_DEG) continue;
      warnings.push(`${partId}: keyed ${round1(deg)}° from a standstill with nothing holding it — add a rod or let it swing`);
    }
    out.set(id, { resolved, warnings });
  }
  return out;
}

// ---------- puppet / part projections ----------

function summarizePuppet(p: Puppet, info: PuppetInfo): unknown {
  if (!info.resolved) return { id: p.id, name: p.name ?? p.id, note: p.note ?? "", warnings: info.warnings };
  return {
    id: p.id,
    name: info.resolved.name,
    note: info.resolved.note,
    parts: info.resolved.ordered.length,
    extent: roundBBox(info.resolved.extent),
    warnings: info.warnings,
  };
}

function projectPart(part: ResolvedPart, resolved: ResolvedPuppet, includePaths: Set<string>): Record<string, unknown> {
  const m = resolved.rest.get(part.id)!;
  const [rx, ry] = apply(m, [0, 0]);
  const rawPart = resolved.source.parts.find((x) => x.id === part.id) as { path?: string; from?: string } | undefined;
  const out: Record<string, unknown> = {
    id: part.id,
    parent: part.parent,
    pivot: part.pivot,
    z: part.z,
    note: part.note,
  };
  if (part.mirrorOf) out.mirrorOf = part.mirrorOf;
  if (part.swing) out.swing = part.swing;
  if (part.rod) out.rod = part.rod;
  if (rawPart?.from) out.from = rawPart.from;
  out.bbox = roundBBox(part.bbox);
  out.rest = { x: round1(rx), y: round1(ry), angle: round1(headingOfY(m)) };
  if (includePaths.has(part.id) && !part.mirrored && typeof rawPart?.path === "string") out.path = rawPart.path;
  return out;
}

function projectPuppet(p: Puppet, info: PuppetInfo, includePaths: Set<string>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: p.id,
    name: p.name ?? p.id,
    note: p.note ?? "",
    unit: p.unit,
    cap: p.cap,
    from: p.from,
    restPose: p.restPose ?? {},
    look: p.look ?? {},
  };
  if (!info.resolved) return { ...base, warnings: info.warnings };
  return {
    ...base,
    extent: roundBBox(info.resolved.extent),
    warnings: info.warnings,
    parts: info.resolved.ordered.map((part) => projectPart(part, info.resolved!, includePaths)),
  };
}

// ---------- scene / beat / track projections ----------

function summarizeKey(kf: Keyframe): unknown {
  return { at: kf.at, ease: kf.ease, joints: Object.keys(kf.pose.joints ?? {}), root: Object.keys(kf.pose.root ?? {}) };
}

function projectBeat(beat: Beat, depth: Depth): unknown {
  if (depth === "play" || depth === "scene") {
    return {
      id: beat.id,
      label: beat.label,
      length: beat.length,
      tracks: Object.keys(beat.tracks ?? {}),
      fx: (beat.fx ?? []).length,
    };
  }
  const tracks: Record<string, unknown> = {};
  for (const [puppetId, keys] of Object.entries(beat.tracks ?? {})) {
    tracks[puppetId] = depth === "key" ? keys : keys.map(summarizeKey);
  }
  return { id: beat.id, label: beat.label, length: beat.length, tracks, fx: beat.fx ?? [] };
}

function projectScene(scene: Scene, depth: Depth): unknown {
  if (depth === "play") {
    return {
      id: scene.id,
      title: scene.title,
      beats: scene.beats.length,
      length: scene.beats.reduce((sum, b) => sum + (Number(b.length) || 0), 0),
    };
  }
  return { id: scene.id, title: scene.title, beats: scene.beats.map((b) => projectBeat(b, depth)) };
}

function projectPlay(doc: Play, depth: Depth, info: Map<string, PuppetInfo>): unknown {
  return {
    id: doc.id,
    title: doc.title,
    stage: doc.stage,
    meta: doc.meta,
    cast: Object.values(doc.cast).map((p) => summarizePuppet(p, info.get(p.id)!)),
    scenes: doc.scenes.map((s) => projectScene(s, depth)),
  };
}

// ---------- entry point ----------

export function readPlay(doc: Play, opts: ReadOptions = {}): unknown {
  const depth: Depth = opts.depth ?? "scene";
  const includePaths = new Set(opts.include_paths ?? []);
  let cachedInfo: Map<string, PuppetInfo> | null = null;
  const info = () => (cachedInfo ??= analyzeCast(doc));

  const steps = parseSelector(opts.sel ?? "", { kind: "play" });
  if (steps.length === 0) return projectPlay(doc, depth, info());

  const isCastProp = (i: number) => steps[i]?.kind === "prop" && (steps[i] as { name: string }).name === "cast";
  const isPartsProp = (i: number) => steps[i]?.kind === "prop" && (steps[i] as { name: string }).name === "parts";

  // scene
  if (steps.length === 1 && steps[0].kind === "scene") {
    const scene = doc.scenes.find((s) => s.id === (steps[0] as { id: string }).id);
    return scene ? projectScene(scene, depth) : undefined;
  }
  // scene/beat
  if (steps.length === 2 && steps[0].kind === "scene" && steps[1].kind === "beat") {
    const scene = doc.scenes.find((s) => s.id === (steps[0] as { id: string }).id);
    const beat = scene?.beats.find((b) => b.id === (steps[1] as { id: string }).id);
    return beat ? projectBeat(beat, depth) : undefined;
  }
  // scene/beat:track
  if (steps.length === 3 && steps[0].kind === "scene" && steps[1].kind === "beat" && steps[2].kind === "track") {
    const scene = doc.scenes.find((s) => s.id === (steps[0] as { id: string }).id);
    const beat = scene?.beats.find((b) => b.id === (steps[1] as { id: string }).id);
    const puppetId = (steps[2] as { puppet: string }).puppet;
    const keys = beat?.tracks?.[puppetId];
    if (!keys) return undefined;
    return depth === "key" ? keys : keys.map(summarizeKey);
  }
  // cast
  if (steps.length === 1 && isCastProp(0)) {
    return Object.values(doc.cast).map((p) => projectPuppet(p, info().get(p.id)!, includePaths));
  }
  // cast.fox
  if (steps.length === 2 && isCastProp(0) && steps[1].kind === "puppet") {
    const id = (steps[1] as { id: string }).id;
    const p = doc.cast[id];
    return p ? projectPuppet(p, info().get(id)!, includePaths) : undefined;
  }
  // cast.fox.parts
  if (steps.length === 3 && isCastProp(0) && steps[1].kind === "puppet" && isPartsProp(2)) {
    const id = (steps[1] as { id: string }).id;
    const p = doc.cast[id];
    if (!p) return undefined;
    return (projectPuppet(p, info().get(id)!, includePaths) as { parts?: unknown[] }).parts;
  }
  // cast.fox.parts.ear_l
  if (steps.length === 4 && isCastProp(0) && steps[1].kind === "puppet" && isPartsProp(2) && steps[3].kind === "part") {
    const puppetId = (steps[1] as { id: string }).id;
    const partId = (steps[3] as { id: string }).id;
    const p = doc.cast[puppetId];
    if (!p) return undefined;
    const parts = (projectPuppet(p, info().get(puppetId)!, includePaths) as { parts?: Array<{ id: string }> }).parts;
    return parts?.find((x) => x.id === partId);
  }

  // Anything else (scene/beat fields, joints/root inside a key, a single
  // keyframe, a part's own field, play globals) is a leaf: the raw stored value.
  return resolveValue(doc, steps);
}
