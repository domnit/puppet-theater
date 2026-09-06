// Milestone 0 harness: load fixture JSON from disk, play it, scrub it, step
// it, isolate one puppet, and toggle debug overlays. Reloads on file change.

import { Evaluator, STAGE_H, UNIT_FRACTION, type EvalOptions, type Frame } from "../engine/evaluate";
import { PuppetError, resolvePuppet, type ResolvedPuppet } from "../model/puppet";
import { PlaySchema, formatIssues, type Play } from "../model/types";
import { Stage, type OverlayOptions } from "../render/stage";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const FRAME = 1 / 60;

interface Persisted {
  fixture: string;
  t: number;
  view: "stage" | "puppet";
  puppetId: string | null;
  layers: EvalOptions & { rods: boolean };
  overlays: OverlayOptions;
  selected: { puppet: string; part: string } | null;
}

const state = {
  fixtures: [] as string[],
  fixture: "",
  play: null as Play | null,
  puppets: new Map<string, ResolvedPuppet>(),
  stageEval: null as Evaluator | null,
  puppetEval: null as Evaluator | null,
  t: 0,
  playing: false,
  lastTick: 0,
  view: "stage" as "stage" | "puppet",
  puppetId: null as string | null,
  layers: { idle: true, followThrough: true, swing: true, rods: true },
  overlays: { pivots: false, bounds: false, bboxes: false, caps: false } as OverlayOptions,
  selected: null as { puppet: string; part: string } | null,
  lastFrame: null as Frame | null,
  /** performance.now() of the last cast-panel render; far negative forces one. */
  treeStamp: -1e9,
};

// Subscribe to reloads before anything that can throw, so a boot crash still
// recovers on the next file change.
watch();

const stage = new Stage($("#stage-wrap"));

// ---------- persistence across code reloads ----------

function persist() {
  const p: Persisted = {
    fixture: state.fixture, t: state.t, view: state.view, puppetId: state.puppetId,
    layers: state.layers, overlays: state.overlays, selected: state.selected,
  };
  try { sessionStorage.setItem("harness", JSON.stringify(p)); } catch {}
}
function restore(): Partial<Persisted> {
  try { return JSON.parse(sessionStorage.getItem("harness") ?? "{}"); } catch { return {}; }
}

// ---------- loading ----------

function showErrors(lines: string[]) {
  const box = $("#errors");
  if (!lines.length) { box.hidden = true; box.textContent = ""; return; }
  box.hidden = false;
  box.textContent = lines.join("\n");
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  try { return await r.json(); } catch (e) { throw new Error(`${url}: ${(e as Error).message}`); }
}

async function loadFixture(name: string) {
  const errors: string[] = [];
  let raw: any;
  try {
    raw = await fetchJson(`/fixtures/plays/${name}`);
    // Harness convenience: a cast entry may be a string path under fixtures/ and is embedded on load.
    for (const [id, v] of Object.entries(raw?.cast ?? {})) {
      if (typeof v === "string") {
        const p = (await fetchJson(`/fixtures/${v}`)) as any;
        p.id = id;
        raw.cast[id] = p;
      }
    }
  } catch (e) {
    showErrors([(e as Error).message]);
    return;
  }
  const parsed = PlaySchema.safeParse(raw);
  if (!parsed.success) {
    showErrors(formatIssues(parsed.error));
    return;
  }
  const play = parsed.data;
  const puppets = new Map<string, ResolvedPuppet>();
  for (const [id, puppet] of Object.entries(play.cast)) {
    try {
      puppets.set(id, resolvePuppet({ ...puppet, id }));
    } catch (e) {
      errors.push(e instanceof PuppetError ? e.message : String(e));
    }
  }
  showErrors(errors);
  state.play = play;
  state.puppets = puppets;
  state.stageEval = new Evaluator(play, puppets, { ...state.layers });
  if (!state.puppetId || !puppets.has(state.puppetId)) state.puppetId = puppets.keys().next().value ?? null;
  buildPuppetEval();
  fillPuppetPicker();
  applyView();
  renderPlayInfo();
  state.treeStamp = -1e9;
  render();
}

/** One puppet, at rest, isolated and centred. */
function buildPuppetEval() {
  const p = state.puppetId ? state.puppets.get(state.puppetId) : null;
  if (!p || !state.play) { state.puppetEval = null; return; }
  const ext = p.extent;
  const k = (UNIT_FRACTION * STAGE_H) / p.unit; // px per local unit at scale 1
  const scale = Math.min(3, (0.74 * STAGE_H) / Math.max(1, ext.h * k));
  const y = 0.5 - ((ext.y + ext.h / 2) * k * scale) / STAGE_H;
  const x = 0.5 - ((ext.x + ext.w / 2) * k * scale) / (STAGE_H * (16 / 9));
  const play: Play = {
    id: "puppet-view", schemaVersion: 1, stage: { tempo: state.play.stage.tempo }, cast: { [p.id]: p.source },
    scenes: [{ id: "s", beats: [{ id: "b", length: 4, tracks: { [p.id]: [{ at: 0, pose: { root: { x, y, scale, plane: "near" } } }] } }] }],
  };
  state.puppetEval = new Evaluator(play, new Map([[p.id, p]]), { idle: false, followThrough: false, swing: false });
}

function activeEval(): Evaluator | null {
  return state.view === "puppet" ? state.puppetEval : state.stageEval;
}

function applyView() {
  const ev = activeEval();
  stage.setCast(ev ? ev.puppets.values() : []);
  $("#puppet-pick-wrap").hidden = state.view !== "puppet";
  document.querySelectorAll<HTMLButtonElement>("#view button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  state.t = Math.min(state.t, duration());
}

function duration(): number {
  return activeEval()?.durationSeconds ?? 0;
}

// ---------- UI wiring ----------

function fillFixturePicker() {
  const sel = $<HTMLSelectElement>("#fixture");
  sel.innerHTML = state.fixtures.map((f) => `<option value="${f}">${f.replace(/\.json$/, "")}</option>`).join("");
  sel.value = state.fixture;
}
function fillPuppetPicker() {
  const sel = $<HTMLSelectElement>("#puppet-pick");
  sel.innerHTML = [...state.puppets.values()].map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  if (state.puppetId) sel.value = state.puppetId;
}

$<HTMLSelectElement>("#fixture").addEventListener("change", (e) => {
  state.fixture = (e.target as HTMLSelectElement).value;
  state.t = 0; state.playing = false; state.selected = null;
  loadFixture(state.fixture);
  persist();
});
$<HTMLSelectElement>("#puppet-pick").addEventListener("change", (e) => {
  state.puppetId = (e.target as HTMLSelectElement).value;
  buildPuppetEval();
  applyView();
  persist();
});
$("#view").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  state.view = b.dataset.view as "stage" | "puppet";
  state.playing = false;
  applyView();
  persist();
  render();
});
document.querySelectorAll<HTMLInputElement>("input[data-layer]").forEach((cb) => {
  cb.addEventListener("change", () => {
    (state.layers as any)[cb.dataset.layer!] = cb.checked;
    if (state.stageEval) state.stageEval.opts = { ...state.layers };
    persist();
    render();
  });
});
document.querySelectorAll<HTMLInputElement>("input[data-overlay]").forEach((cb) => {
  cb.addEventListener("change", () => {
    (state.overlays as any)[cb.dataset.overlay!] = cb.checked;
    persist();
    render();
  });
});

function setPlaying(on: boolean) {
  if (on && state.t >= duration() - 1e-6) state.t = 0;
  state.playing = on && duration() > 0;
  state.lastTick = performance.now();
  $("#play").textContent = state.playing ? "Pause" : "Play";
}
function seek(t: number) {
  state.t = Math.max(0, Math.min(duration(), t));
  render();
  persist();
}
$("#play").addEventListener("click", () => setPlaying(!state.playing));
$("#to-start").addEventListener("click", () => { setPlaying(false); seek(0); });
$("#step-back").addEventListener("click", () => { setPlaying(false); seek(state.t - FRAME); });
$("#step-fwd").addEventListener("click", () => { setPlaying(false); seek(state.t + FRAME); });
$<HTMLInputElement>("#scrub").addEventListener("input", (e) => {
  setPlaying(false);
  seek((Number((e.target as HTMLInputElement).value) / 10000) * duration());
});
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "SELECT" || (e.target as HTMLElement).tagName === "INPUT") return;
  const beat = 60 / (activeEval()?.tl.tempo ?? 90);
  switch (e.key) {
    case " ": e.preventDefault(); setPlaying(!state.playing); break;
    case "ArrowLeft": e.preventDefault(); setPlaying(false); seek(state.t - (e.shiftKey ? beat : FRAME)); break;
    case "ArrowRight": e.preventDefault(); setPlaying(false); seek(state.t + (e.shiftKey ? beat : FRAME)); break;
    case "Home": e.preventDefault(); setPlaying(false); seek(0); break;
    case "End": e.preventDefault(); setPlaying(false); seek(duration()); break;
  }
});

stage.onPartClick((hit) => {
  state.selected = hit;
  state.treeStamp = -1e9;
  persist();
  render();
});

// ---------- panels ----------

function renderPlayInfo() {
  const p = state.play;
  const ev = state.stageEval;
  if (!p || !ev) { $("#playinfo").innerHTML = ""; return; }
  const beats = ev.tl.spans.length;
  $("#playinfo").innerHTML = `
    <div class="note">${esc(p.title ?? p.id)}</div>
    <dl>
      <dt>tempo</dt><dd>${p.stage.tempo} bpm</dd>
      <dt>length</dt><dd>${ev.tl.totalBeats} beats · ${ev.durationSeconds.toFixed(2)} s</dd>
      <dt>scenes</dt><dd>${p.scenes.length} · ${beats} beat${beats === 1 ? "" : "s"}</dd>
      <dt>cast</dt><dd>${Object.keys(p.cast).length}</dd>
    </dl>`;
}

function renderTree(frame: Frame) {
  const ev = activeEval();
  if (!ev) { $("#tree").innerHTML = ""; return; }
  const angles = new Map<string, Map<string, number>>();
  for (const fp of frame.puppets) angles.set(fp.puppet.id, new Map(fp.parts.map((p) => [p.part.id, p.angle])));
  let html = "";
  for (const p of ev.puppets.values()) {
    const a = angles.get(p.id);
    const ext = p.extent;
    html += `<div class="puppet"><div class="head">${esc(p.name)} <small>· ${p.id} · unit ${p.unit} · cap ${p.cap} · extent ${ext.w.toFixed(0)}×${ext.h.toFixed(0)}${a ? "" : " · off stage"}</small></div>`;
    if (p.note) html += `<div class="pnote">${esc(p.note)}</div>`;
    for (const part of p.ordered) {
      const sel = state.selected && state.selected.puppet === p.id && state.selected.part === part.id;
      const tags = [
        part.mirrored ? `↔ ${part.mirrorOf}` : part.mirrorOf ? `↔ ${part.mirrorOf} (overridden)` : "",
        part.swing ? `swing ${part.swing}` : "",
      ].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
      const ang = a?.get(part.id);
      html += `<div class="part${sel ? " sel" : ""}" data-puppet="${p.id}" data-part="${part.id}" style="padding-left:${6 + part.depth * 14}px">
        <span class="id">${esc(part.id)}${tags}</span><span class="ang">${ang === undefined ? "" : ang.toFixed(1) + "°"}</span></div>`;
    }
    html += `</div>`;
  }
  $("#tree").innerHTML = html;
}
$("#tree").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".part");
  if (!row) return;
  state.selected = { puppet: row.dataset.puppet!, part: row.dataset.part! };
  state.treeStamp = -1e9;
  persist();
  render();
});

function renderDetail(frame: Frame) {
  const box = $("#detail");
  const s = state.selected;
  const ev = activeEval();
  const p = s && ev ? ev.puppets.get(s.puppet) : null;
  const part = p?.parts.get(s!.part);
  if (!p || !part) { box.className = "info muted"; box.textContent = "Click a part on the stage or in the cast list."; return; }
  const fp = frame.puppets.find((f) => f.puppet.id === p.id);
  const live = fp?.parts.find((x) => x.part.id === part.id);
  const b = part.bbox;
  box.className = "info";
  box.innerHTML = `
    <div><strong>${esc(p.id)}/${esc(part.id)}</strong></div>
    <div class="note">${esc(part.note || (part.mirrored ? `mirror of ${part.mirrorOf}` : "(no note)"))}</div>
    <dl>
      <dt>parent</dt><dd>${part.parent ?? "— (root)"}</dd>
      <dt>pivot</dt><dd>${part.pivot[0]}, ${part.pivot[1]}</dd>
      <dt>z</dt><dd>${part.z}</dd>
      <dt>rest</dt><dd>${(p.restPose[part.id] ?? 0).toFixed(1)}°</dd>
      <dt>now</dt><dd>${live ? live.angle.toFixed(2) + "°" : "—"}</dd>
      <dt>bbox</dt><dd>${b.x.toFixed(1)}, ${b.y.toFixed(1)} · ${b.w.toFixed(1)}×${b.h.toFixed(1)}</dd>
      ${part.swing ? `<dt>swing</dt><dd>${part.swing}</dd>` : ""}
      ${part.mirrorOf ? `<dt>mirrorOf</dt><dd>${part.mirrorOf}${part.mirrored ? "" : " (own path wins)"}</dd>` : ""}
    </dl>
    <div><code>${esc(part.d)}</code></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// ---------- frame loop ----------

function render() {
  const ev = activeEval();
  if (!ev) return;
  const frame = ev.frame(state.t);
  state.lastFrame = frame;
  stage.draw(frame, { rods: state.layers.rods, overlays: state.overlays, selected: state.selected });
  const d = duration();
  $<HTMLInputElement>("#scrub").value = String(d > 0 ? Math.round((state.t / d) * 10000) : 0);
  $("#time").textContent = `${state.t.toFixed(2)} s`;
  $("#beat").textContent = `beat ${frame.beat.toFixed(2)}`;
  const sp = frame.span;
  $("#where").textContent = sp
    ? `${sp.scene.title ?? sp.scene.id} · ${sp.beat.label ?? sp.beat.id}${frame.lamp < 0.999 ? ` · lamp ${Math.round(frame.lamp * 100)}%` : ""}`
    : "";
  const now = performance.now();
  if (now - state.treeStamp > 120) {
    state.treeStamp = now;
    renderTree(frame);
    renderDetail(frame);
  }
}

function tick(now: number) {
  if (state.playing) {
    state.t += (now - state.lastTick) / 1000;
    state.lastTick = now;
    if (state.t >= duration()) {
      state.t = duration();
      setPlaying(false);
    }
    render();
  }
  requestAnimationFrame(tick);
}

// ---------- live reload ----------

function watch() {
  const es = new EventSource("/events");
  es.addEventListener("fixture", () => {
    refreshFixtureList().then(() => loadFixture(state.fixture));
  });
  es.addEventListener("code", () => {
    persist();
    location.reload();
  });
}

async function refreshFixtureList() {
  state.fixtures = (await fetchJson("/api/fixtures")) as string[];
  if (!state.fixtures.includes(state.fixture)) state.fixture = state.fixtures[0] ?? "";
  fillFixturePicker();
}

// ---------- boot ----------

(async () => {
  const saved = restore();
  if (saved.layers) state.layers = { ...state.layers, ...saved.layers };
  if (saved.overlays) state.overlays = { ...state.overlays, ...saved.overlays };
  if (saved.view) state.view = saved.view;
  if (saved.puppetId) state.puppetId = saved.puppetId;
  if (saved.selected) state.selected = saved.selected;
  if (typeof saved.t === "number") state.t = saved.t;
  document.querySelectorAll<HTMLInputElement>("input[data-layer]").forEach((cb) => (cb.checked = (state.layers as any)[cb.dataset.layer!]));
  document.querySelectorAll<HTMLInputElement>("input[data-overlay]").forEach((cb) => (cb.checked = (state.overlays as any)[cb.dataset.overlay!]));
  state.fixture = saved.fixture ?? "";
  await refreshFixtureList();
  await loadFixture(state.fixture);
  requestAnimationFrame((n) => { state.lastTick = n; tick(n); });
})();
