// Whole-document validation and normalisation — spec §2.3. The zod schema, then
// the checks that need geometry (resolvePuppet), then the ones that need the
// whole play (ids addressable by a selector, tracks naming real cast members,
// bounds). Returns the *normalised* doc: canonical paths, tracks and fx sorted
// by `at`. Runs once per edit batch, never per edit.

import { canonicalPath } from "../model/path";
import { PuppetError, resolvePuppet } from "../model/puppet";
import { PlaySchema, formatIssues, type Play } from "../model/types";

/** At play level a first selector segment is a scene id unless it is one of these. */
export const RESERVED_PLAY: ReadonlySet<string> = new Set([
  "title", "stage", "meta", "mode", "cast", "scenes", "schemaVersion", "version", "id",
]);
/** Inside a scene a first segment is a beat id unless it is one of these. */
export const RESERVED_SCENE: ReadonlySet<string> = new Set(["title", "beats", "id"]);

export const LIMITS = { puppets: 24, scenes: 64, beats: 256, keys: 64, bytes: 512 * 1024 };

export type Validation = { ok: true; doc: Play } | { ok: false; error: string };

export function validatePlay(doc: unknown): Validation {
  const parsed = PlaySchema.safeParse(doc);
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error).join("; ") };
  const play = parsed.data;
  try {
    check(play);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const out = normalise(play);
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  if (bytes > LIMITS.bytes) {
    return { ok: false, error: `document is ${Math.round(bytes / 1024)} KiB, over the ${LIMITS.bytes / 1024} KiB limit` };
  }
  return { ok: true, doc: out };
}

function fail(message: string): never {
  throw new Error(message);
}

/** An id that a selector has to be able to name. */
function checkId(id: string, what: string, reserved: ReadonlySet<string>, where: string): void {
  if (id.includes(".")) fail(`${where}: ${what} id '${id}' contains a '.' — no selector could address it`);
  if (reserved.has(id)) fail(`${where}: ${what} id '${id}' is a reserved selector word`);
}

function check(play: Play): void {
  const cast = Object.entries(play.cast);
  if (cast.length > LIMITS.puppets) fail(`${cast.length} puppets, over the ${LIMITS.puppets} limit`);
  for (const [key, puppet] of cast) {
    if (key !== puppet.id) fail(`cast.${key}: the puppet's id is '${puppet.id}'`);
    checkId(key, "puppet", new Set(), "cast");
    for (const part of puppet.parts) checkId(part.id, "part", new Set(), `cast.${key}`);
    try {
      resolvePuppet(puppet);
    } catch (e) {
      if (e instanceof PuppetError) fail(e.message);
      throw e;
    }
  }

  if (play.scenes.length > LIMITS.scenes) fail(`${play.scenes.length} scenes, over the ${LIMITS.scenes} limit`);
  const sceneIds = new Set<string>();
  let beats = 0;
  for (const scene of play.scenes) {
    checkId(scene.id, "scene", RESERVED_PLAY, "scenes");
    if (sceneIds.has(scene.id)) fail(`duplicate scene id '${scene.id}'`);
    sceneIds.add(scene.id);
    const beatIds = new Set<string>();
    for (const beat of scene.beats) {
      checkId(beat.id, "beat", RESERVED_SCENE, scene.id);
      if (beatIds.has(beat.id)) fail(`${scene.id}: duplicate beat id '${beat.id}'`);
      beatIds.add(beat.id);
      beats++;
      for (const [puppetId, keys] of Object.entries(beat.tracks ?? {})) {
        if (!(puppetId in play.cast)) fail(`${scene.id}/${beat.id}: a track for '${puppetId}', who is not in the cast`);
        if (keys.length > LIMITS.keys) fail(`${scene.id}/${beat.id}:${puppetId}: ${keys.length} keys, over the ${LIMITS.keys} limit`);
      }
    }
  }
  if (beats > LIMITS.beats) fail(`${beats} beats, over the ${LIMITS.beats} limit`);
}

/** Paths to canonical absolute form; `at`-ordered lists actually in `at` order. */
function normalise(play: Play): Play {
  const out = structuredClone(play);
  for (const puppet of Object.values(out.cast)) {
    for (const part of puppet.parts) {
      if (typeof part.path === "string" && part.path.trim()) part.path = canonicalPath(part.path);
    }
  }
  for (const scene of out.scenes) {
    for (const beat of scene.beats) {
      for (const keys of Object.values(beat.tracks ?? {})) keys.sort((a, b) => a.at - b.at);
      beat.fx?.sort((a, b) => a.at - b.at);
    }
  }
  return out;
}
