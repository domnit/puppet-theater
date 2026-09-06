// Evaluate a play at a time → world transforms for every part of every puppet.
//
// Three procedural layers run additively on top of keyed values (spec §5.3):
//   idle            breath (root bob) + sway (root rotation) + per-joint drift
//   follow-through  each depth level reads the keyed pose a few frames late,
//                   and children counter-rotate against the parent's velocity
//   swing           parts with `swing` are a damped pendulum driven by the
//                   world motion of their pivot, stepped at a fixed rate
//
// Everything is a pure function of (play, t) except the pendulum, which is a
// fixed-step simulation from t=0 with checkpoints, so scrubbing anywhere
// yields the same state as playing there.

import type { ResolvedPart, ResolvedPuppet } from "../model/puppet";
import type { Plane, Play } from "../model/types";
import {
  apply, det, hash01, headingOfY, magnitude, mul, rotate, scale, translate, wrap180, type Mat,
} from "./math";
import {
  buildTimeline, lampAt, poseAt, secondsToBeats, spanAt, type BeatSpan, type KeyedPose, type RootState, type Timeline,
} from "./timeline";

export const STAGE_W = 1600;
export const STAGE_H = 900;
/** A puppet of `unit` height stands this fraction of the stage at scale 1 on the mid plane. */
export const UNIT_FRACTION = 0.5;

export const PLANES: Record<Plane, { scale: number; blur: number; opacity: number }> = {
  far: { scale: 0.82, blur: 2.4, opacity: 0.72 },
  mid: { scale: 1.0, blur: 0.9, opacity: 0.88 },
  near: { scale: 1.15, blur: 0.2, opacity: 1.0 },
};
const PLANE_ORDER: Plane[] = ["far", "mid", "near"];

export interface EvalOptions {
  idle: boolean;
  followThrough: boolean;
  swing: boolean;
}

export interface FramePart {
  part: ResolvedPart;
  /** Total local rotation, degrees. */
  angle: number;
  world: Mat;
}
/** A control rod in stage pixels, from its attachment on the part to the
 *  puppeteer's hand below the stage. */
export interface FrameRod {
  part: ResolvedPart;
  /** Main rod (holds the root) as opposed to a hand wire. */
  main: boolean;
  x1: number; y1: number;
  x2: number; y2: number;
  width: number;
}
export interface FramePuppet {
  puppet: ResolvedPuppet;
  plane: Plane;
  opacity: number;
  root: Mat;
  rootState: RootState;
  /** Sorted for painting: z ascending, tree order on ties. */
  parts: FramePart[];
  rods: FrameRod[];
}
export interface Frame {
  t: number;
  beat: number;
  lamp: number;
  span?: BeatSpan;
  puppets: FramePuppet[];
}

interface Rig {
  rootState: RootState;
  root: Mat;
  angles: Map<string, number>;
  world: Map<string, Mat>;
}

// Tuning. Seconds, degrees, stage pixels.
const LAG = 0.045; // follow-through delay per depth level (~2.7 frames)
const DRAG_GAIN = 0.45; // child counter-rotation per degree of parent motion over LAG
const SWAY_DEG = 1.4;
const BOB_PX = 0.0035 * STAGE_H;
const GRAVITY = 2400; // px/s²
const SIM_DT = 1 / 240;
const SCENE_DIP_BEATS = 0.45; // lamp dips across scene boundaries (C6)
// Rods. A rod is held at a fixed point below the stage — directly under where
// its attachment sits at rest — so it stands vertical at rest and tilts as the
// hand moves. Widths are in stage pixels for a 100-unit puppet at scale 1.
export const ROD_REACH = 0.4 * STAGE_H; // hand-hold depth below the stage floor
const ROD_W_MAIN = 2.2;
const ROD_W_HAND = 1.0;

interface Pendulum {
  t: number;
  theta: number; // world angle from straight down, clockwise-positive
  omega: number;
  px: number; py: number;
  vx: number; vy: number;
  steps: number;
}

export class Evaluator {
  readonly tl: Timeline;
  private pendulums = new Map<string, Pendulum>();
  private checkpoints = new Map<string, Map<number, Pendulum>>();

  constructor(
    readonly play: Play,
    readonly puppets: Map<string, ResolvedPuppet>,
    public opts: EvalOptions = { idle: true, followThrough: true, swing: true },
  ) {
    this.tl = buildTimeline(play);
  }

  get durationSeconds(): number {
    return (this.tl.totalBeats * 60) / this.tl.tempo;
  }

  frame(t: number): Frame {
    const beat = secondsToBeats(this.tl, t);
    const puppets: FramePuppet[] = [];
    for (const [id, puppet] of this.puppets) {
      const rig = this.rig(puppet, t, true);
      if (!rig) continue;
      const parts: FramePart[] = puppet.ordered.map((part) => ({
        part, angle: rig.angles.get(part.id)!, world: rig.world.get(part.id)!,
      }));
      parts.sort((a, b) => a.part.z - b.part.z || a.part.order - b.part.order);
      puppets.push({
        puppet, plane: rig.rootState.plane, opacity: PLANES[rig.rootState.plane].opacity * puppet.opacity,
        root: rig.root, rootState: rig.rootState, parts, rods: this.rods(puppet, rig),
      });
      void id;
    }
    puppets.sort((a, b) => PLANE_ORDER.indexOf(a.plane) - PLANE_ORDER.indexOf(b.plane));
    return { t, beat, lamp: this.lamp(beat), span: spanAt(this.tl, beat), puppets };
  }

  private rods(puppet: ResolvedPuppet, rig: Rig): FrameRod[] {
    const px = magnitude(rig.root) * puppet.unit / 100;
    return puppet.rods.map((part) => {
      const at = part.rod!;
      const [x1, y1] = apply(rig.world.get(part.id)!, at);
      const [hx] = apply(rig.root, apply(puppet.rest.get(part.id)!, at));
      const main = part.depth === 0;
      return { part, main, x1, y1, x2: hx, y2: STAGE_H + ROD_REACH, width: (main ? ROD_W_MAIN : ROD_W_HAND) * px };
    });
  }

  private lamp(beat: number): number {
    let level = lampAt(this.tl, beat);
    // Dip across interior scene boundaries.
    for (let i = 1; i < this.tl.scenes.length; i++) {
      const edge = this.tl.scenes[i].start;
      const d = Math.abs(beat - edge);
      if (d < SCENE_DIP_BEATS) {
        const u = d / SCENE_DIP_BEATS; // 0 at the edge
        level *= 0.12 + 0.88 * (u * u * (3 - 2 * u));
      }
    }
    return level;
  }

  /** Root placement and every part's world matrix at time t. Null when the
   *  puppet has not entered yet. `withSwing` resolves pendulum parts. */
  rig(puppet: ResolvedPuppet, t: number, withSwing: boolean): Rig | null {
    const track = this.tl.tracks.get(puppet.id);
    const beat = secondsToBeats(this.tl, t);
    const now = poseAt(track, beat);
    if (!now) return null;

    // Keyed poses per depth level (follow-through reads the past).
    const maxDepth = puppet.ordered.reduce((m, p) => Math.max(m, p.depth), 0);
    const byDepth: KeyedPose[] = [now];
    for (let d = 1; d <= maxDepth; d++) {
      byDepth.push(this.opts.followThrough ? poseAt(track, secondsToBeats(this.tl, Math.max(0, t - d * LAG))) ?? now : now);
    }
    const lagged = this.opts.followThrough ? poseAt(track, secondsToBeats(this.tl, Math.max(0, t - LAG))) ?? now : now;

    const rs = now.root;
    const idleAmp = this.opts.idle ? puppet.idle : 0;
    const seed = hash01(puppet.id);
    const sway = SWAY_DEG * idleAmp * Math.sin((2 * Math.PI * t) / (4.6 + seed * 2.4) + seed * 6.283);
    const bob = BOB_PX * idleAmp * Math.sin((2 * Math.PI * t) / (2.9 + seed * 1.1) + seed * 3.1);
    const s = ((UNIT_FRACTION * STAGE_H) / puppet.unit) * PLANES[rs.plane].scale * rs.scale;
    const root = mul(mul(translate(rs.x * STAGE_W, rs.y * STAGE_H + bob), rotate(sway)), scale(s * rs.facing, s));

    const angles = new Map<string, number>();
    const world = new Map<string, Mat>();
    for (const part of puppet.ordered) {
      const rest = puppet.restPose[part.id] ?? 0;
      const keyed = byDepth[part.depth].joints[part.id] ?? 0;
      let drag = 0;
      if (this.opts.followThrough && part.parent) {
        const pNow = now.joints[part.parent] ?? 0;
        const pThen = lagged.joints[part.parent] ?? 0;
        drag = DRAG_GAIN * wrap180(pThen - pNow);
      }
      let micro = 0;
      if (idleAmp > 0 && part.parent) {
        const h = hash01(puppet.id + "/" + part.id);
        micro = idleAmp * (0.4 + 0.3 * part.depth) * Math.sin((2 * Math.PI * t) / (2.6 + h * 2.2) + h * 6.283);
      }
      let angle = rest + keyed + drag + micro;
      const parentM = part.parent ? world.get(part.parent)! : root;
      if (withSwing && this.opts.swing && part.swing > 0) {
        const theta = this.pendulum(puppet, part, t);
        const sign = det(parentM) < 0 ? -1 : 1;
        angle = sign * (theta - headingOfY(parentM)) + keyed;
      }
      angles.set(part.id, angle);
      world.set(part.id, mul(mul(parentM, translate(part.pivot[0], part.pivot[1])), rotate(angle)));
    }
    return { rootState: rs, root, angles, world };
  }

  // ---------- pendulum ----------

  private pendulum(puppet: ResolvedPuppet, part: ResolvedPart, t: number): number {
    const key = puppet.id + "/" + part.id;
    let st = this.pendulums.get(key);
    if (!st || t < st.t - 1e-9 || t - st.t > 0.5) {
      // Restart from the nearest checkpoint at or before t.
      const cps = this.checkpoints.get(key);
      let best: Pendulum | undefined;
      if (cps) for (const [sec, cp] of cps) if (sec <= t && (!best || cp.t > best.t)) best = cp;
      st = best ? { ...best } : { t: 0, theta: 0, omega: 0, px: 0, py: 0, vx: 0, vy: 0, steps: 0 };
      this.pendulums.set(key, st);
    }
    // Guard against absurd catch-up (a very long play scrubbed to its end).
    const maxSteps = 240 * 120;
    let n = 0;
    while (st.t + SIM_DT <= t && n++ < maxSteps) this.step(puppet, part, st, key);
    return st.theta;
  }

  private step(puppet: ResolvedPuppet, part: ResolvedPart, st: Pendulum, key: string) {
    const s = st.t + SIM_DT;
    const rig = this.rig(puppet, s, false);
    const prevSec = Math.floor(st.t);
    if (rig) {
      const parentM = part.parent ? rig.world.get(part.parent)! : rig.root;
      const [px, py] = apply(parentM, part.pivot);
      const vx = (px - st.px) / SIM_DT, vy = (py - st.py) / SIM_DT;
      const ax = st.steps >= 2 ? (vx - st.vx) / SIM_DT : 0;
      const ay = st.steps >= 2 ? (vy - st.vy) / SIM_DT : 0;
      const L = Math.max(8, 0.7 * (part.bbox.y + part.bbox.h) * magnitude(parentM));
      const w0 = Math.sqrt(GRAVITY / L);
      const zeta = 0.06 + (1 - Math.min(1, part.swing)) * 0.5;
      const drive = 0.35 + 0.65 * Math.min(1, part.swing);
      const th = st.theta;
      // θ'' = (ax cosθ − (g − ay) sinθ)/L − cθ'
      const acc = (drive * ax * Math.cos(th) - (GRAVITY - drive * ay) * Math.sin(th)) / L - 2 * zeta * w0 * st.omega;
      st.omega += acc * SIM_DT;
      st.theta += st.omega * SIM_DT;
      st.px = px; st.py = py; st.vx = vx; st.vy = vy;
      st.steps = st.steps >= 2 ? 2 : st.steps + 1;
    }
    st.t = s;
    if (Math.floor(s) > prevSec) {
      if (!this.checkpoints.has(key)) this.checkpoints.set(key, new Map());
      this.checkpoints.get(key)!.set(Math.floor(s), { ...st });
    }
  }
}
