// The in-app chat: `POST /chat` runs the Anthropic tool runner in process over
// the same `TOOLS` the MCP server exposes (spec §4.5, §4.6), as the anonymous
// `public` principal, and streams the reply back as SSE.
//
// This is the one endpoint that spends money and it is unauthenticated, so
// every turn passes a fixed order of checks — in flight, dark, per session,
// per IP — before a single token is bought, and each response's usage is
// written to the spend ledger. A refusal is not an error: the page always gets
// a 200 event stream, and a failure state arrives as one `dark` frame with the
// sentence the visitor should read.
//
// Frames: `session` (always first), `text` (a piece of the reply), `play` (the
// page should show this play now), `dark` (a written failure state; the turn
// ends there), `done` (the turn finished). Sessions live in memory only — a
// restart forgets every conversation, which costs a visitor nothing.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";
import type { Store } from "../store/db";
import { TOOLS, type ToolContext } from "../tools";
import { createLimiter } from "./limit";
import { SYSTEM } from "./prompt";
import { costUsd, startOfDayUtc, usageOf } from "./spend";

export interface ChatOptions {
  store: Store;
  /** A ToolContext for the anonymous principal; the server builds it per request. */
  context: () => ToolContext;
  /** null: no key configured, the chat is dark. */
  apiKey: string | null;
  model: string;
  dailyUsd: number;
  perIpPerHour: number;
  perSession: number;
  maxIterations: number;
  /** Tests point the SDK at a fake API. */
  baseURL?: string;
}

export interface Chat {
  /** POST /chat. `ip` is the client address the server already resolved. */
  handle(req: Request, ip: string): Promise<Response>;
  /** The written failure state if the chat is dark right now, else null. */
  dark(): string | null;
  /** Open sessions, for logs and tests. */
  sessions(): number;
  close(): void;
}

/** `store.getSetting("chat") === "off"` darkens the chat without a restart. */
export const KILL_SWITCH_KEY = "chat";

const DARK = "The theatre is dark tonight.";
const IP_CAP = "Too many messages from this address; try again in an hour.";
const SESSION_CAP = "This conversation has reached its limit; reload the page to start another.";
const IN_FLIGHT = "The last message is still being answered.";
const STEP_LIMIT = "Stopped after too many steps in one turn; say what to do next.";

const MAX_MESSAGE = 2000;
const MAX_TOKENS = 16000;
const IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 2000;
const HOUR_MS = 3600_000;

interface Session {
  id: string;
  ip: string;
  messages: BetaMessageParam[];
  count: number;
  lastAt: number;
  busy: boolean;
}

interface Ask {
  session?: string;
  message: string;
  playId?: string;
}

type Send = (event: string, data: unknown) => void;

export function createChat(opts: ChatOptions): Chat {
  const enc = new TextEncoder();
  const sessions = new Map<string, Session>();
  const inFlight = new Set<AbortController>();
  const perIp = createLimiter(opts.perIpPerHour, HOUR_MS);
  const client = opts.apiKey
    ? new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) })
    : null;

  function dark(): string | null {
    if (!client) return DARK;
    if (opts.store.getSetting(KILL_SWITCH_KEY) === "off") return DARK;
    if (opts.store.spendSince(startOfDayUtc()).usd >= opts.dailyUsd) return DARK;
    return null;
  }

  /** Conversations nobody came back to, dropped on every request. */
  function sweep(): void {
    const now = Date.now();
    for (const [id, s] of sessions) if (!s.busy && now - s.lastAt > IDLE_MS) sessions.delete(id);
  }

  /** The named session if we still hold it, else a fresh one — never an error. */
  function open(id: string | undefined, ip: string): Session {
    const known = id ? sessions.get(id) : undefined;
    if (known) {
      known.lastAt = Date.now();
      return known;
    }
    // Room for one more: the least recently used goes, which is never one with
    // a turn in flight (those were touched just now).
    while (sessions.size >= MAX_SESSIONS) {
      let oldest: Session | null = null;
      for (const s of sessions.values()) if (!oldest || s.lastAt < oldest.lastAt) oldest = s;
      if (!oldest) break;
      sessions.delete(oldest.id);
    }
    const fresh: Session = { id: newId(), ip, messages: [], count: 0, lastAt: Date.now(), busy: false };
    sessions.set(fresh.id, fresh);
    return fresh;
  }

  /** The failure state this request stops at, in the order of spec §4.5. */
  function refuse(session: Session, ip: string): string | null {
    if (session.busy) return IN_FLIGHT;
    const off = dark();
    if (off) return off;
    if (session.count >= opts.perSession) return SESSION_CAP;
    if (perIp(ip)) return IP_CAP;
    return null;
  }

  /**
   * The first user turn. The page context travels here rather than in `system`,
   * which must stay byte-stable for the cache breakpoint (spec §4.5).
   */
  function firstTurn(session: Session, ask: Ask): string {
    if (session.messages.length > 0 || !ask.playId) return ask.message;
    const got = opts.store.getPlay(ask.playId);
    if (!got) return ask.message;
    const named = got.row.title && got.row.title !== "Untitled" ? ` "${got.row.title}",` : "";
    return `[Looking at play ${got.row.id},${named} ${got.row.mode}]\n${ask.message}`;
  }

  /**
   * The six tools, wrapped so a commit also tells the page which play to show.
   * Nothing else is declared: no server-side tool, and `tool_choice` stays auto.
   */
  function toolsFor(ask: Ask, send: Send) {
    const announced = new Set<string>();
    const show = (id: unknown): void => {
      if (typeof id !== "string" || !id || announced.has(id)) return;
      announced.add(id);
      send("play", { play_id: id });
    };
    return TOOLS.map((tool) =>
      betaZodTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.schema,
        run: async (args: unknown) => {
          // A ToolError thrown here becomes an error tool_result and the loop
          // carries on, which is what the model should see.
          const result = tool.run(opts.context(), args);
          const out = result as { play_id?: unknown; rejected?: unknown[] } | null;
          if (tool.name === "create_play") show(out?.play_id);
          else if (tool.name.startsWith("edit_") && out?.rejected?.length === 0) {
            const target = (args as { play_id?: unknown }).play_id;
            if (target !== ask.playId) show(target);
          }
          return JSON.stringify(result);
        },
      }),
    );
  }

  async function run(session: Session, ask: Ask, send: Send, abort: AbortController): Promise<void> {
    const model = opts.model;
    const messages: BetaMessageParam[] = [...session.messages, { role: "user", content: firstTurn(session, ask) }];
    const runner = client!.beta.messages.toolRunner(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        tools: toolsFor(ask, send),
        messages,
        max_iterations: opts.maxIterations,
        stream: true,
      },
      { signal: abort.signal },
    );

    let iterations = 0;
    let stopReason: string | null = null;
    for await (const stream of runner) {
      iterations++;
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") send("text", { delta: ev.delta.text });
      }
      const msg = await stream.finalMessage();
      stopReason = msg.stop_reason;
      const usage = usageOf(msg);
      opts.store.recordSpend({ session: session.id, model, ...usage, usd: costUsd(model, usage) });
    }

    const transcript = runner.params.messages as BetaMessageParam[];
    if (stopReason === "tool_use" && iterations >= opts.maxIterations) {
      // The loop was cut off mid-turn: close any tool call left without a
      // result so the next message still starts from a valid conversation.
      const stopped = danglingResults(transcript);
      if (stopped) transcript.push(stopped);
      send("text", { delta: STEP_LIMIT });
    }
    session.messages = transcript;
    session.count += 1;
    session.lastAt = Date.now();
    send("done", {});
  }

  function body(session: Session, ask: Ask, refusal: string | null): ReadableStream<Uint8Array> {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const abort = new AbortController();
    const send: Send = (event, data) => {
      if (!controller) return;
      try {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        controller = null; // the visitor navigated away mid-turn
      }
    };
    const close = (): void => {
      try {
        controller?.close();
      } catch {
        /* already gone */
      }
      controller = null;
    };
    return new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        send("session", { id: session.id });
        if (refusal) {
          send("dark", { text: refusal });
          close();
          return;
        }
        inFlight.add(abort);
        // Not awaited: the response is already on its way, and frames are
        // written as the run produces them.
        run(session, ask, send, abort)
          .catch((e) => {
            // Whatever streamed stays on screen; the turn itself is discarded,
            // so `session.messages` is left as it was before this message.
            if (!abort.signal.aborted) {
              console.error("chat turn failed", e);
              send("dark", { text: DARK });
            }
          })
          .finally(() => {
            inFlight.delete(abort);
            session.busy = false;
            close();
          });
      },
      cancel() {
        controller = null;
        abort.abort();
      },
    });
  }

  return {
    async handle(req, ip) {
      const ask = await readAsk(req);
      if (!ask) return text("a JSON body with a message of 1-2000 characters is required", 400);
      sweep();
      const session = open(ask.session, ip);
      const refusal = refuse(session, ip);
      if (!refusal) session.busy = true;
      return new Response(body(session, ask, refusal), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    },

    dark,

    sessions() {
      return sessions.size;
    },

    close() {
      for (const abort of inFlight) abort.abort();
      inFlight.clear();
      sessions.clear();
    },
  };
}

// ---------- plumbing ----------

async function readAsk(req: Request): Promise<Ask | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as { session?: unknown; message?: unknown; play_id?: unknown };
  if (typeof b.message !== "string" || b.message.trim() === "" || b.message.length > MAX_MESSAGE) return null;
  return {
    session: typeof b.session === "string" ? b.session : undefined,
    message: b.message,
    playId: typeof b.play_id === "string" ? b.play_id : undefined,
  };
}

/**
 * A `user` turn answering every tool call the assistant's last message left
 * open, or null if it left none. Only the trailing assistant turn can be
 * unanswered — everything before it was answered as the loop ran.
 */
function danglingResults(messages: BetaMessageParam[]): BetaMessageParam | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return null;
  const calls = last.content.filter((block) => block.type === "tool_use");
  if (calls.length === 0) return null;
  return {
    role: "user",
    content: calls.map((call) => ({
      type: "tool_result" as const,
      tool_use_id: call.id,
      is_error: true,
      content: "stopped: the turn's step limit was reached",
    })),
  };
}

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function text(message: string, status: number): Response {
  return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain" } });
}
