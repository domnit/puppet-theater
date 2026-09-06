// Flatten a play's scenes and beats onto one beat axis, resolve sparse poses
// into full keyframes per puppet, and answer "what is the keyed pose at beat b".

import type { Beat, Ease, Play, Plane, Scene } from "../model/types";
import { ease as easeFn, lerp, lerpAngle } from "./math";

export interface RootState {
  x: number;
  y: number;
  scale: number;
  facing: 1 | -1;
  plane: Plane;
}

export interface ResolvedKey {
  /** Absolute position on the beat axis. */
  at: number;
  /** Easing of the motion into this key. */
  ease: Ease;
  /** Full joint map, carried forward from earlier keys. */
  joints: Record<string, number>;
  root: RootState;
}

export interface BeatSpan {
  sceneIndex: number;
  beatIndex: number;
  scene: Scene;
  beat: Beat;
  start: number;
  end: number;
}

export interface SceneSpan {
  index: number;
  scene: Scene;
  start: number;
  end: number;
}

export interface LampCue {
  at: number;
  to: number;
  over: number;
}

export interface Timeline {
  tempo: number;
  totalBeats: number;
  spans: BeatSpan[];
  scenes: SceneSpan[];
  tracks: Map<string, ResolvedKey[]>;
  lampCues: LampCue[];
}

export const DEFAULT_ROOT: RootState = { x: 0.5, y: 0.5, scale: 1, facing: 1, plane: "mid" };

export function buildTimeline(play: Play): Timeline {
  const spans: BeatSpan[] = [];
  const scenes: SceneSpan[] = [];
  const raw = new Map<string, { at: number; ease: Ease; joints?: Record<string, number>; root?: Partial<RootState> }[]>();
  const lampCues: LampCue[] = [];
  let cursor = 0;
  (play.scenes ?? []).forEach((scene, si) => {
    const sStart = cursor;
    (scene.beats ?? []).forEach((beat, bi) => {
      const len = Math.max(0, Number(beat.length) || 0);
      spans.push({ sceneIndex: si, beatIndex: bi, scene, beat, start: cursor, end: cursor + len });
      for (const [puppetId, keys] of Object.entries(beat.tracks ?? {})) {
        if (!raw.has(puppetId)) raw.set(puppetId, []);
        const list = raw.get(puppetId)!;
        for (const k of keys ?? []) {
          list.push({
            at: cursor + (Number(k.at) || 0),
            ease: k.ease ?? "inOut",
            joints: k.pose?.joints,
            root: k.pose?.root as Partial<RootState> | undefined,
          });
        }
      }
      for (const cue of beat.fx ?? []) {
        if (cue.type === "lamp") {
          lampCues.push({ at: cursor + (Number(cue.at) || 0), to: Number(cue.to ?? 1), over: Math.max(0, Number(cue.over ?? 0)) });
        }
      }
      cursor += len;
    });
    scenes.push({ index: si, scene, start: sStart, end: cursor });
  });
  const tracks = new Map<string, ResolvedKey[]>();
  for (const [puppetId, list] of raw) {
    list.sort((a, b) => a.at - b.at);
    let joints: Record<string, number> = {};
    let root: RootState = { ...DEFAULT_ROOT };
    const resolved: ResolvedKey[] = [];
    for (const k of list) {
      joints = { ...joints, ...(k.joints ?? {}) };
      root = { ...root, ...(k.root ?? {}) } as RootState;
      resolved.push({ at: k.at, ease: k.ease, joints, root });
    }
    tracks.set(puppetId, resolved);
  }
  lampCues.sort((a, b) => a.at - b.at);
  return { tempo: Number(play.stage?.tempo) || 90, totalBeats: cursor, spans, scenes, tracks, lampCues };
}

export function spanAt(tl: Timeline, beat: number): BeatSpan | undefined {
  for (const s of tl.spans) if (beat >= s.start && beat < s.end) return s;
  return tl.spans.length && beat >= tl.totalBeats ? tl.spans[tl.spans.length - 1] : undefined;
}

export function secondsToBeats(tl: Timeline, t: number): number {
  return (t * tl.tempo) / 60;
}
export function beatsToSeconds(tl: Timeline, b: number): number {
  return (b * 60) / tl.tempo;
}

/** Lamp level from cues: starts at 1, each cue ramps to `to` over `over` beats. */
export function lampAt(tl: Timeline, beat: number): number {
  let level = 1;
  for (const cue of tl.lampCues) {
    if (beat < cue.at) break;
    const from = level;
    const t = cue.over > 0 ? Math.min(1, (beat - cue.at) / cue.over) : 1;
    level = lerp(from, cue.to, easeFn("inOut", t));
  }
  return level;
}

export interface KeyedPose {
  joints: Record<string, number>;
  root: RootState;
  /** 0..1 progress inside the current segment, after easing. */
  progress: number;
}

/** Keyed pose at an absolute beat. Null before the first key (not on stage yet). */
export function poseAt(track: ResolvedKey[] | undefined, beat: number): KeyedPose | null {
  if (!track || track.length === 0) return null;
  if (beat < track[0].at) return null;
  let i = 0;
  while (i + 1 < track.length && track[i + 1].at <= beat) i++;
  const a = track[i];
  const b = track[i + 1];
  if (!b || b.at <= a.at) return { joints: a.joints, root: a.root, progress: 1 };
  const u = easeFn(b.ease, (beat - a.at) / (b.at - a.at));
  const joints: Record<string, number> = {};
  for (const id of new Set([...Object.keys(a.joints), ...Object.keys(b.joints)])) {
    const av = a.joints[id] ?? b.joints[id] ?? 0;
    const bv = b.joints[id] ?? av;
    joints[id] = lerpAngle(av, bv, u);
  }
  const root: RootState = {
    x: lerp(a.root.x, b.root.x, u),
    y: lerp(a.root.y, b.root.y, u),
    scale: lerp(a.root.scale, b.root.scale, u),
    // Discrete: flip at the midpoint so a turn reads as a turn, not a slide.
    facing: u < 0.5 ? a.root.facing : b.root.facing,
    plane: u < 0.5 ? a.root.plane : b.root.plane,
  };
  return { joints, root, progress: u };
}
