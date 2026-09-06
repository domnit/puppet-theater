// The chat affordance (spec §5.6): one button in the lower-right corner and a
// small panel above it. The panel owns nothing but its own DOM and the wire to
// `POST /chat` — playback belongs to main.ts and reaches this file only through
// the host handle.
//
// The wire: `POST /chat` with `{ session?, message, play_id?, landing? }` and a
// `text/event-stream` reply. EventSource cannot POST, so the body is read with
// fetch + a reader and the frames are parsed here: blank-line separated, each
// with `event:` and `data:` lines, buffered across chunks.

import type { PartHit } from "../render/stage";

export interface ChatHost {
  /** Show a play and start its live feed; main.ts owns the playback. */
  showPlay(id: string, opts: { live: boolean }): Promise<void>;
  /** The play the page is showing, if any — sent with every message. */
  currentPlayId(): string | null;
  /** True while the page is still showing the landing pick. */
  isLanding(): boolean;
  /** The visitor's own play has taken over: drop the landing byline. */
  onLeaveLanding(): void;
}

export interface ChatHandle {
  /** A click on the stage: a part aims the next message, empty stage clears it. */
  pointAt(hit: PartHit | null): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const SEEN_KEY = "puppet-theater:chat-seen";
const SESSION_KEY = "puppet-theater:chat-session";
/** Both ceilings and the kill switch render this, and so does a dead network. */
const DARK = "The theatre is dark tonight.";
/** A bracketed aim already at the head of the input — never stack a second. */
const AIMED = /^\[[^\]]*\]\s*/;
/** The textarea grows to about four lines and then scrolls. */
const INPUT_MAX_PX = 96;

// Storage is a nicety, not a dependency: a locked-down browser throws on the
// first read and the chat has to keep working.
function readStore(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(store: Storage, key: string, value: string) {
  try {
    store.setItem(key, value);
  } catch {
    /* private mode, or storage disabled */
  }
}

interface Frame {
  event: string;
  data: string;
}

/** Split an SSE body into frames, buffering whatever a chunk cut in half. */
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const sep = /\r?\n\r?\n/;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let m = sep.exec(buf); m; m = sep.exec(buf)) {
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const f = parseFrame(raw);
      if (f) yield f;
    }
  }
  const last = parseFrame(buf); // a final frame with no blank line after it
  if (last) yield last;
}

function parseFrame(raw: string): Frame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":") || !line.trim()) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length || event !== "message" ? { event, data: data.join("\n") } : null;
}

function parseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function mountChat(host: ChatHost): ChatHandle {
  const button = $<HTMLButtonElement>("#chat-open");
  const panel = $("#chat");
  const log = $("#chat-log");
  const form = $<HTMLFormElement>("#chat-form");
  const input = $<HTMLTextAreaElement>("#chat-input");

  let open = false;
  let busy = false;
  let session = readStore(sessionStorage, SESSION_KEY) ?? "";

  // It pulses until the first click, ever — the state outlives the session.
  if (!readStore(localStorage, SEEN_KEY)) button.classList.add("pulse");

  // ---------- the panel ----------

  function setOpen(on: boolean) {
    open = on;
    panel.hidden = !on;
    button.setAttribute("aria-expanded", String(on));
    if (on) {
      button.classList.remove("pulse");
      writeStore(localStorage, SEEN_KEY, "1");
      input.focus();
      scrollDown();
    }
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_PX)}px`;
  }

  /** Everything in the transcript is plain text; nothing here renders markup. */
  function line(cls: string, text: string): HTMLElement {
    log.querySelector(".empty")?.remove();
    const el = document.createElement("p");
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    scrollDown();
    return el;
  }

  function setBusy(on: boolean) {
    busy = on;
    input.disabled = on;
    if (!on) input.focus();
  }

  // ---------- a turn ----------

  async function send(message: string) {
    if (busy) return;
    line("you", message);
    input.value = "";
    autosize();
    setBusy(true);
    // A quiet in-progress state rather than a spinner; it goes on the first
    // delta, or is replaced by whatever went wrong.
    let waiting: HTMLElement | null = line("wait", "…");
    let reply: HTMLElement | null = null;
    const clearWait = () => {
      waiting?.remove();
      waiting = null;
    };
    const say = (delta: string) => {
      clearWait();
      if (!reply) reply = line("them", "");
      reply.textContent += delta;
      scrollDown();
    };
    // The house going dark is its own line: prose the visitor has already read
    // should not dim retroactively.
    const dark = (text: string) => {
      clearWait();
      reply = null;
      line("them dark", text);
    };

    try {
      const r = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: session || undefined,
          message,
          play_id: host.currentPlayId() ?? undefined,
          landing: host.isLanding(),
        }),
      });
      if (!r.ok || !r.body) {
        // A 400 carries a written client error; a silent failure is the dark
        // house. Either way it reads as a reply, dimmed, and the page lives on.
        const body = (await r.text().catch(() => "")).trim();
        dark(body || DARK);
        return;
      }
      for await (const f of readFrames(r.body)) {
        if (f.event === "session") {
          const d = parseJson<{ id?: string }>(f.data);
          if (d?.id) {
            session = d.id;
            writeStore(sessionStorage, SESSION_KEY, session);
          }
        } else if (f.event === "text") {
          const d = parseJson<{ delta?: string }>(f.data);
          if (d?.delta) say(d.delta);
        } else if (f.event === "play") {
          const d = parseJson<{ play_id?: string }>(f.data);
          if (d?.play_id) await adopt(d.play_id);
        } else if (f.event === "dark") {
          const d = parseJson<{ text?: string }>(f.data);
          dark(d?.text || DARK);
          break;
        } else if (f.event === "done") {
          break;
        }
      }
    } catch (e) {
      console.warn("chat failed:", e);
      dark(DARK);
    } finally {
      clearWait();
      setBusy(false);
    }
  }

  /** The reply named a play: the page becomes that play's page. */
  async function adopt(playId: string) {
    try {
      await host.showPlay(playId, { live: true });
      history.replaceState(null, "", `/p/${encodeURIComponent(playId)}`);
      host.onLeaveLanding();
    } catch (e) {
      console.warn("could not show the play the chat named:", e);
    }
  }

  // ---------- wiring ----------

  button.addEventListener("click", () => setOpen(!open));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (message) void send(message);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener("input", autosize);

  // The panel is over the stage, so its keys are its own.
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      button.focus();
    } else if (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.stopPropagation(); // typing a space is not play/pause
    }
  });

  return {
    pointAt(hit) {
      if (!hit) {
        input.value = input.value.replace(AIMED, "");
        autosize();
        return;
      }
      if (!open) setOpen(true);
      // The prefix is ordinary text: the server's prompt explains it to the
      // model. Pointing again points somewhere else; an empty-stage click erases.
      input.value = `[${hit.puppet} / ${hit.part}] ${input.value.replace(AIMED, "")}`;
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  };
}
