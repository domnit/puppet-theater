// Document schemas — mirrors notes/spec.md §1. Zod is the single source of
// truth: the TS types are inferred from it, the harness validates fixture JSON
// with it, and the MCP tools (Milestone 2) will take these same schemas as
// their input shapes. Semantic checks that need geometry (path grammar,
// tree acyclicity, contour area) live in puppet.ts.

import { z } from "zod";

export const VecSchema = z.tuple([z.number(), z.number()]);
export const EaseSchema = z.enum(["linear", "in", "out", "inOut", "hold"]);
export const PlaneSchema = z.enum(["far", "mid", "near"]);

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "ids are [A-Za-z0-9_.-]");

export const PartSchema = z.object({
  id,
  parent: id.nullable(),
  /** In the parent's frame; also the origin of this part's own frame. */
  pivot: VecSchema,
  z: z.number().default(0),
  /** SVG path data in the part-local frame. Absent when `mirrorOf` supplies it. */
  path: z.string().optional(),
  note: z.string().max(400).optional(),
  /** Reflect another part's contour across this part's local Y axis instead of drawing one. */
  mirrorOf: id.optional(),
  /** Pendulum looseness, 0..1, for hanging things. */
  swing: z.number().min(0).max(1).optional(),
  /** Control rod attached here, in this part's frame. The rod drives this
   *  part and every part between it and the root (the hand rod moves the
   *  whole arm). The root part always has a main rod at its pivot; give the
   *  root a `rod` to move that attachment. */
  rod: VecSchema.optional(),
});

export const PuppetSchema = z.object({
  id,
  name: z.string().max(120).optional(),
  note: z.string().max(400).optional(),
  /** Puppet height in local units. */
  unit: z.number().positive(),
  /** Joint disc radius, local units. */
  cap: z.number().min(0),
  from: z.string().optional(),
  restPose: z.record(id, z.number()).optional(),
  look: z.object({ opacity: z.number().min(0).max(1).optional(), idle: z.number().min(0).max(2).optional() }).optional(),
  parts: z.array(PartSchema).min(1).max(64),
});

export const RootPoseSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().positive().optional(),
  facing: z.union([z.literal(1), z.literal(-1)]).optional(),
  plane: PlaneSchema.optional(),
});

export const PoseSchema = z.object({
  joints: z.record(id, z.number()).optional(),
  root: RootPoseSchema.optional(),
});

export const KeyframeSchema = z.object({
  /** Offset within the beat, in beats. */
  at: z.number().min(0),
  /** Easing of the motion *into* this keyframe from the previous one. */
  ease: EaseSchema.optional(),
  pose: PoseSchema,
});

export const CueSchema = z.object({
  at: z.number().min(0),
  type: z.string(),
  to: z.number().optional(),
  over: z.number().min(0).optional(),
}).passthrough();

export const BeatSchema = z.object({
  id,
  label: z.string().max(200).optional(),
  length: z.number().min(0),
  tracks: z.record(id, z.array(KeyframeSchema)).optional(),
  fx: z.array(CueSchema).optional(),
});

export const SceneSchema = z.object({
  id,
  title: z.string().max(200).optional(),
  beats: z.array(BeatSchema),
});

export const PlaySchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  version: z.number().int().optional(),
  title: z.string().max(200).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  stage: z.object({ tempo: z.number().positive(), backdrop: z.string().optional() }),
  cast: z.record(id, PuppetSchema),
  scenes: z.array(SceneSchema),
});

export type Vec = z.infer<typeof VecSchema>;
export type Ease = z.infer<typeof EaseSchema>;
export type Plane = z.infer<typeof PlaneSchema>;
export type Part = z.infer<typeof PartSchema>;
export type Puppet = z.infer<typeof PuppetSchema>;
export type RootPose = z.infer<typeof RootPoseSchema>;
export type Pose = z.infer<typeof PoseSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type Cue = z.infer<typeof CueSchema>;
export type Beat = z.infer<typeof BeatSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Play = z.infer<typeof PlaySchema>;

/** Format a zod error as one line per problem, with the JSON path. */
export function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}
