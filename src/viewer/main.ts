// The public view of a play: /p/:id. Fetches the play, autoplays it once, holds
// on the final frame, and keeps up with edits pushed over SSE — applying them
// with the same applyEdits the server commits with, so a viewer watches a stage
// assemble in place. Chrome is a title, a hairline scrubber and one glyph.

import { applyEdits, type Scope } from "../doc/edit";
import { Evaluator, type EvalOptions } from "../engine/evaluate";
import { PuppetError, resolvePuppet, type ResolvedPuppet } from "../model/puppet";
import { PlaySchema, type Play } from "../model/types";
import { Stage, type DrawOptions } from "../render/stage";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const FRAME = 1 / 60;
const EPS = 1e-6;
/** How close to the bottom edge the pointer must come for the controls. */
const NEAR_PX = 120;
const IDLE_MS = 2000;

const EVAL_OPTS: EvalOptions = { idle: true, followThrough: true, swing: true };
const DRAW: DrawOptions = {
  rods: true,
  handRods: true,
  overlays: { pivots: false, bounds: false, bboxes: false, caps: false },
  selected: null,
};

const playId = decodeURIComponent(/^\/p\/([^/]+)/.exec(location.pathname)?.[1] ?? "");

const state = {
  play: null as Play | null,
  /** Cast JSON of the loaded play, to tell a cast change from a pose change. */
  castKey: "",
  puppets: new Map<string, ResolvedPuppet>(),
  ev: null as Evaluator | null,
  version: -1,
  /** Title from the store row; the doc's own title wins when it has one. */
  storeTitle: "",
  t: 0,
  playing: false,
  /** Playback ran to the end on its own (as opposed to the viewer pausing). */
  atEnd: false,
  lastTick: 0,
};

const stage = new Stage($("#stage-wrap"));
const playBtn = $<HTMLButtonElement>("#play");
const controls = $("#controls");
const track = $("#track");
const elapsed = $("#elapsed");
const head = $("#head");

// ---------- loading ----------

interface Fetched {
  play: Play;
  version: number;
  title: string;
}

async function fetchPlay(): Promise<Fetched> {
  const url = `/api/plays/${encodeURIComponent(playId)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const d = (await r.json()) as { play: unknown; version?: number; title?: string };
  return {
    play: PlaySchema.parse(d.play),
    version: Number(d.version ?? 0),
    title: typeof d.title === "string" ? d.title : "",
  };
}

let refetchSeq = 0;
async function refetch() {
  const seq = ++refetchSeq;
  try {
    const got = await fetchPlay();
    if (seq !== refetchSeq) return; // a newer refetch won
    state.storeTitle = got.title || state.storeTitle;
    adopt(got.play, got.version);
    notice("");
  } catch (e) {
    console.warn("refetch failed:", e);
  }
}

function resolveCast(play: Play): Map<string, ResolvedPuppet> {
  const out = new Map<string, ResolvedPuppet>();
  for (const [id, p] of Object.entries(play.cast)) {
    try {
      out.set(id, resolvePuppet({ ...p, id }));
    } catch (e) {
      // A puppet that will not resolve is left off the stage; the rest plays.
      console.warn(e instanceof PuppetError ? e.message : String(e));
    }
  }
  return out;
}

/**
 * Take a new document as the play being shown. The cast DOM is rebuilt only
 * when the cast actually changed; `t` survives, so an edit during playback
 * takes effect from the current frame on and a paused frame re-renders in
 * place. If playback had ended and the play grew, it resumes into the new
 * material; if it shrank past the playhead, we clamp to the new end and hold.
 */
function adopt(play: Play, version: number) {
  const key = JSON.stringify(play.cast);
  const castChanged = key !== state.castKey;
  if (castChanged) {
    state.castKey = key;
    state.puppets = resolveCast(play);
  }
  state.play = play;
  state.version = version;
  state.ev = new Evaluator(play, state.puppets, EVAL_OPTS);
  if (castChanged) stage.setCast(state.puppets.values());
  setTitle(play.title || state.storeTitle);
  const d = duration();
  if (state.t > d) {
    state.t = d;
    state.playing = false;
    state.atEnd = true;
  } else if (state.atEnd && d > state.t + EPS) {
    state.atEnd = false;
    setPlaying(true);
  }
  updateGlyph();
  render();
}

function setTitle(title: string) {
  const text = title || playId;
  $("#title").textContent = text;
  document.title = text ? `${text} — Puppet Theater` : "Puppet Theater";
}

function notice(text: string) {
  const el = $("#notice");
  el.textContent = text;
  el.hidden = !text;
}

// ---------- playback ----------

function duration(): number {
  return state.ev?.durationSeconds ?? 0;
}

function setPlaying(on: boolean) {
  const d = duration();
  if (on && d <= 0) return; // an empty play holds its lit scrim
  if (on && state.t >= d - EPS) state.t = 0; // play at the end restarts
  state.playing = on;
  state.atEnd = false;
  state.lastTick = performance.now();
  updateGlyph();
}

function seek(t: number) {
  state.t = Math.max(0, Math.min(duration(), t));
  state.atEnd = false;
  render();
}

function updateGlyph() {
  playBtn.classList.toggle("playing", state.playing);
  playBtn.setAttribute("aria-label", state.playing ? "Pause" : "Play");
}

function render() {
  if (!state.ev) return;
  stage.draw(state.ev.frame(state.t), DRAW);
  const d = duration();
  const u = d > 0 ? Math.max(0, Math.min(1, state.t / d)) : 0;
  elapsed.style.width = `${u * 100}%`;
  head.style.left = `${u * 100}%`;
  track.setAttribute("aria-valuenow", String(Math.round(u * 100)));
}

function tick(now: number) {
  if (state.playing) {
    state.t += (now - state.lastTick) / 1000;
    state.lastTick = now;
    const d = duration();
    if (state.t >= d) {
      state.t = d;
      state.playing = false;
      state.atEnd = true; // hold on the final frame; not a loop
      updateGlyph();
    }
    render();
  }
  requestAnimationFrame(tick);
}

// ---------- controls ----------

let hideTimer: ReturnType<typeof setTimeout> | undefined;
let dragging = false;
let nearControls = false;

/** Show the controls; they stay while the pointer rests near them, and fade
 *  after IDLE_MS only when it is elsewhere (a touch, say). */
function showControls() {
  controls.classList.add("on");
  clearTimeout(hideTimer);
  if (!nearControls) hideTimer = setTimeout(hideControls, IDLE_MS);
}
function hideControls() {
  if (dragging) return;
  clearTimeout(hideTimer);
  controls.classList.remove("on");
}

window.addEventListener("pointermove", (e) => {
  if (dragging) return;
  nearControls = e.clientY >= window.innerHeight - NEAR_PX;
  if (nearControls) showControls();
  else hideControls();
});
window.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") showControls();
});
document.addEventListener("pointerleave", () => hideControls());

playBtn.addEventListener("click", () => {
  setPlaying(!state.playing);
  showControls();
});

function seekTo(clientX: number) {
  const r = track.getBoundingClientRect();
  const u = r.width > 0 ? (clientX - r.left) / r.width : 0;
  seek(u * duration());
}

track.addEventListener("pointerdown", (e) => {
  dragging = true;
  track.setPointerCapture(e.pointerId);
  setPlaying(false); // scrubbing pauses
  seekTo(e.clientX);
  showControls();
});
track.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  seekTo(e.clientX);
  showControls();
});
const endDrag = (e: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
  showControls();
};
track.addEventListener("pointerup", endDrag);
track.addEventListener("pointercancel", endDrag);

window.addEventListener("keydown", (e) => {
  switch (e.key) {
    case " ":
      e.preventDefault();
      setPlaying(!state.playing);
      break;
    case "ArrowLeft":
      e.preventDefault();
      setPlaying(false);
      seek(state.t - FRAME);
      break;
    case "ArrowRight":
      e.preventDefault();
      setPlaying(false);
      seek(state.t + FRAME);
      break;
    default:
      return;
  }
  showControls();
});

// ---------- live edits ----------

interface EditMessage {
  version?: number;
  edits?: unknown[];
  doc?: unknown;
  scope?: Scope;
  author?: string;
}

/**
 * `edits` at exactly our next version apply locally; a whole `doc` replaces
 * (that is what a batch containing an import pushes); anything else is a gap
 * and we refetch.
 */
function onEdit(msg: EditMessage) {
  const version = Number(msg.version);
  if (!state.play || !Number.isFinite(version) || version <= state.version) return;
  if (msg.doc !== undefined) {
    try {
      adopt(PlaySchema.parse(msg.doc), version);
      return;
    } catch (e) {
      console.warn("pushed doc rejected, refetching:", e);
    }
  } else if (Array.isArray(msg.edits) && version === state.version + 1) {
    try {
      const { doc } = applyEdits(state.play, msg.edits as never, msg.scope ?? { kind: "play" });
      adopt(doc, version);
      return;
    } catch (e) {
      console.warn("pushed edits did not apply, refetching:", e);
    }
  }
  refetch();
}

function parseData<T>(e: MessageEvent): T | null {
  try {
    return JSON.parse(e.data) as T;
  } catch {
    return null;
  }
}

function connect() {
  // EventSource reconnects on its own; every connection opens with `hello`, so
  // that is where we notice we fell behind.
  const es = new EventSource(`/p/${encodeURIComponent(playId)}/events`);
  es.addEventListener("hello", (e) => {
    const d = parseData<{ version?: number }>(e as MessageEvent);
    if (d && Number.isFinite(Number(d.version)) && Number(d.version) !== state.version) refetch();
  });
  es.addEventListener("edit", (e) => {
    const d = parseData<EditMessage>(e as MessageEvent);
    if (d) onEdit(d);
  });
}

// ---------- boot ----------

(async () => {
  setTitle("");
  render();
  try {
    const got = await fetchPlay();
    state.storeTitle = got.title;
    adopt(got.play, got.version);
  } catch (e) {
    console.warn("could not load the play:", e);
    notice("This play could not be loaded.");
    requestAnimationFrame(tick);
    return;
  }
  setPlaying(true); // autoplay once
  requestAnimationFrame((n) => {
    state.lastTick = n;
    tick(n);
  });
  connect();
})();
