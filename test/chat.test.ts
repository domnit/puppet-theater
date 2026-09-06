// The in-app chat end to end, against a fake Anthropic API on an ephemeral
// port: one scripted tool call, one scripted reply, and no money spent. The
// fake answers a plain user turn with a `create_play` tool_use and a turn
// carrying tool results with text, which is the shortest exchange that
// exercises the whole loop — the runner, the tools, the SSE frames and the
// spend ledger.

import { afterEach, describe, expect, test } from "bun:test";
import { createImportResolver } from "../src/doc/library";
import { PUBLIC } from "../src/server/auth";
import { createChat, KILL_SWITCH_KEY, type Chat, type ChatOptions } from "../src/server/chat";
import { openStore, type Store } from "../src/store/db";
import type { ToolContext } from "../src/tools";

const DARK = "The theatre is dark tonight.";
const USAGE = { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 };

// ---------- the fake API ----------

interface Call {
  messages: { role: string; content: unknown }[];
  system?: unknown;
  tools?: { name: string }[];
  tool_choice?: unknown;
}

interface Fake {
  url: string;
  calls: Call[];
  /** Set to 500 to make every further request fail. */
  status: number;
  stop(): void;
}

function sse(events: { event: string; data: unknown }[]): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify({ type: e.event, ...(e.data as object) })}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function turn(blocks: { start: unknown; deltas: unknown[] }[], stopReason: string): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...USAGE, output_tokens: 0 },
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    events.push({ event: "content_block_start", data: { index, content_block: block.start } });
    for (const delta of block.deltas) events.push({ event: "content_block_delta", data: { index, delta } });
    events.push({ event: "content_block_stop", data: { index } });
  });
  events.push({ event: "message_delta", data: { delta: { stop_reason: stopReason, stop_sequence: null }, usage: USAGE } });
  events.push({ event: "message_stop", data: {} });
  return events;
}

const TOOL_TURN = turn(
  [
    {
      start: { type: "tool_use", id: "toolu_fake", name: "create_play", input: {} },
      deltas: [{ type: "input_json_delta", partial_json: '{"title":"A Test"}' }],
    },
  ],
  "tool_use",
);

const TEXT_TURN = turn(
  [{ start: { type: "text", text: "" }, deltas: [{ type: "text_delta", text: "Done." }] }],
  "end_turn",
);

function startFake(): Fake {
  const calls: Call[] = [];
  const state = { status: 200 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/messages") return new Response("not found\n", { status: 404 });
      const body = (await req.json()) as Call;
      calls.push(body);
      if (state.status !== 200) {
        return Response.json({ type: "error", error: { type: "api_error", message: "boom" } }, { status: state.status });
      }
      const last = body.messages[body.messages.length - 1];
      const answering = Array.isArray(last?.content) && last.content.some((b) => (b as { type?: string }).type === "tool_result");
      return sse(answering ? TEXT_TURN : TOOL_TURN);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    calls,
    get status() {
      return state.status;
    },
    set status(v: number) {
      state.status = v;
    },
    stop() {
      server.stop(true);
    },
  };
}

// ---------- harness ----------

interface Rig {
  store: Store;
  fake: Fake;
  chat: Chat;
}

const open: Rig[] = [];

afterEach(() => {
  for (const rig of open.splice(0)) {
    rig.chat.close();
    rig.fake.stop();
    rig.store.close();
  }
});

function context(store: Store): ToolContext {
  return {
    store,
    principal: PUBLIC,
    baseUrl: "http://theater.test",
    imports: createImportResolver({ puppets: [], parts: [], play: (id) => store.getPlay(id) }),
    libraryIndex: [],
  };
}

function rig(over: Partial<ChatOptions> = {}): Rig {
  const store = openStore(":memory:");
  const fake = startFake();
  const chat = createChat({
    store,
    context: () => context(store),
    apiKey: "test",
    model: "claude-sonnet-5",
    dailyUsd: 1,
    perIpPerHour: 100,
    perSession: 20,
    maxIterations: 8,
    baseURL: fake.url,
    ...over,
  });
  const made = { store, fake, chat };
  open.push(made);
  return made;
}

interface Frame {
  event: string;
  data: Record<string, string>;
}

async function say(chat: Chat, body: unknown, ip = "1.2.3.4"): Promise<Response> {
  return chat.handle(new Request("http://theater.test/chat", { method: "POST", body: JSON.stringify(body) }), ip);
}

async function frames(res: Response): Promise<Frame[]> {
  const raw = await res.text();
  return raw
    .split("\n\n")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const lines = chunk.split("\n");
      return { event: lines[0].replace("event: ", ""), data: JSON.parse(lines[1].replace("data: ", "")) };
    });
}

function only(fs: Frame[], event: string): Frame[] {
  return fs.filter((f) => f.event === event);
}

// ---------- the turn ----------

describe("a turn", () => {
  test("streams a session, the play the tool made, the reply, and done", async () => {
    const { store, fake, chat } = rig();
    const res = await say(chat, { message: "stage me something" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const fs = await frames(res);
    expect(fs[0].event).toBe("session");
    expect(fs[0].data.id.length).toBeGreaterThanOrEqual(16);
    expect(fs[fs.length - 1].event).toBe("done");

    const played = only(fs, "play");
    expect(played).toHaveLength(1);
    const got = store.getPlay(played[0].data.play_id);
    expect(got?.doc.title).toBe("A Test");
    expect(got?.row.creator).toBe("public");
    expect(got?.row.mode).toBe("open");

    expect(only(fs, "text").map((f) => f.data.delta).join("")).toBe("Done.");
    expect(only(fs, "dark")).toHaveLength(0);
    expect(chat.sessions()).toBe(1);

    // Two API calls — the tool call and the answer — both in the ledger.
    expect(fake.calls).toHaveLength(2);
    const spend = store.spendSince(0);
    expect(spend.calls).toBe(2);
    expect(spend.usd).toBeGreaterThan(0);
    expect(spend.inputTokens).toBe(200);
    expect(spend.cacheReadTokens).toBe(10);
  });

  test("sends only the six tools, with the system prompt cached", async () => {
    const { fake, chat } = rig();
    await frames(await say(chat, { message: "hello" }));
    const names = (fake.calls[0].tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["create_play", "edit_cast", "edit_play", "edit_scene", "list_plays", "read_play"]);
    expect(fake.calls[0].tool_choice).toBeUndefined();
    expect(fake.calls[0].system).toMatchObject([{ type: "text", cache_control: { type: "ephemeral" } }]);
  });

  test("a play_id in the first message becomes a bracketed line inside the user turn", async () => {
    const { store, fake, chat } = rig();
    const seed = store.createPlay({ creator: "public", mode: "open", doc: { id: "", schemaVersion: 1, title: "The Lamp", meta: {}, stage: { tempo: 96 }, cast: {}, scenes: [] } });
    const fs = await frames(await say(chat, { message: "add a fox", play_id: seed.id }));
    expect(fs[0].event).toBe("session");
    expect(fake.calls[0].messages[0].content).toBe(`[Looking at play ${seed.id}, "The Lamp", open]\nadd a fox`);
    // The prefix never touches the cached system prompt.
    expect(JSON.stringify(fake.calls[0].system)).not.toContain(seed.id);

    // An unknown id gets no prefix at all.
    const other = await frames(await say(chat, { message: "hello", play_id: "pl_nope" }));
    expect(other[0].event).toBe("session");
    expect(fake.calls[2].messages[0].content).toBe("hello");
  });

  test("a second message on the same session keeps the transcript", async () => {
    const { fake, chat } = rig();
    const first = await frames(await say(chat, { message: "stage me something" }));
    const session = first[0].data.id;

    const second = await frames(await say(chat, { message: "now a fox", session }));
    expect(second[0].data.id).toBe(session);
    expect(second[second.length - 1].event).toBe("done");
    expect(chat.sessions()).toBe(1);

    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[0].messages).toHaveLength(1);
    expect(fake.calls[2].messages.length).toBeGreaterThan(fake.calls[0].messages.length);
    expect(fake.calls[2].messages[fake.calls[2].messages.length - 1]).toMatchObject({ role: "user", content: "now a fox" });
  });

  test("an unknown session id gets a fresh one rather than an error", async () => {
    const { chat } = rig();
    const fs = await frames(await say(chat, { message: "hello", session: "no-such-session" }));
    expect(fs[0].event).toBe("session");
    expect(fs[0].data.id).not.toBe("no-such-session");
    expect(fs[fs.length - 1].event).toBe("done");
  });

  test("the step limit ends the turn with a sentence, and leaves a valid transcript", async () => {
    const { fake, chat } = rig({ maxIterations: 1 });
    const fs = await frames(await say(chat, { message: "stage me something" }));
    expect(fake.calls).toHaveLength(1);
    expect(only(fs, "text").map((f) => f.data.delta).join("")).toContain("too many steps");
    expect(fs[fs.length - 1].event).toBe("done");

    // The next turn still starts from a conversation the API would accept.
    await frames(await say(chat, { message: "carry on", session: fs[0].data.id }));
    const sent = fake.calls[1].messages;
    const results = sent.filter((m) => Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === "tool_result"));
    expect(results).toHaveLength(1);
  });
});

// ---------- the ways it goes dark ----------

describe("failure states", () => {
  test("no key configured", async () => {
    const { fake, chat } = rig({ apiKey: null });
    expect(chat.dark()).toBe(DARK);
    const fs = await frames(await say(chat, { message: "hello" }));
    expect(fs.map((f) => f.event)).toEqual(["session", "dark"]);
    expect(fs[1].data.text).toBe(DARK);
    expect(fake.calls).toHaveLength(0);
  });

  test("the kill switch", async () => {
    const { store, fake, chat } = rig();
    expect(chat.dark()).toBeNull();
    store.setSetting(KILL_SWITCH_KEY, "off");
    expect(chat.dark()).toBe(DARK);
    const fs = await frames(await say(chat, { message: "hello" }));
    expect(fs.map((f) => f.event)).toEqual(["session", "dark"]);
    expect(fake.calls).toHaveLength(0);
  });

  test("the daily ceiling, once a call has been recorded", async () => {
    const { store, chat } = rig({ dailyUsd: 0.0005 });
    expect(chat.dark()).toBeNull();
    await frames(await say(chat, { message: "stage me something" }));
    expect(store.spendSince(0).usd).toBeGreaterThan(0.0005);
    expect(chat.dark()).toBe(DARK);
    const fs = await frames(await say(chat, { message: "again" }));
    expect(fs.map((f) => f.event)).toEqual(["session", "dark"]);
  });

  test("the per-session cap", async () => {
    const { chat } = rig({ perSession: 1 });
    const first = await frames(await say(chat, { message: "stage me something" }));
    expect(first[first.length - 1].event).toBe("done");
    const second = await frames(await say(chat, { message: "and again", session: first[0].data.id }));
    expect(second.map((f) => f.event)).toEqual(["session", "dark"]);
    expect(second[1].data.text).toContain("reload the page");
  });

  test("the per-address cap, across sessions", async () => {
    const { chat } = rig({ perIpPerHour: 1 });
    const first = await frames(await say(chat, { message: "stage me something" }, "9.9.9.9"));
    expect(first[first.length - 1].event).toBe("done");
    const second = await frames(await say(chat, { message: "again, new tab" }, "9.9.9.9"));
    expect(second.map((f) => f.event)).toEqual(["session", "dark"]);
    expect(second[1].data.text).toContain("try again in an hour");
    // Another address is unaffected.
    const elsewhere = await frames(await say(chat, { message: "hello" }, "8.8.8.8"));
    expect(elsewhere[elsewhere.length - 1].event).toBe("done");
  });

  test("a request already in flight on the session", async () => {
    const { chat } = rig();
    const first = say(chat, { message: "stage me something" });
    const started = await frames(await first);
    const session = started[0].data.id;

    // Hold the session busy by starting a turn and not reading its body.
    const slow = await say(chat, { message: "one", session });
    const clash = await frames(await say(chat, { message: "two", session }));
    expect(clash.map((f) => f.event)).toEqual(["session", "dark"]);
    expect(clash[1].data.text).toContain("still being answered");
    await frames(slow);
  });

  test("an API error mid-turn: dark, and the turn is not kept", async () => {
    const { fake, chat } = rig();
    fake.status = 500;
    const fs = await frames(await say(chat, { message: "stage me something" }));
    expect(fs[0].event).toBe("session");
    expect(fs[fs.length - 1].event).toBe("dark");
    expect(fs[fs.length - 1].data.text).toBe(DARK);
    expect(only(fs, "done")).toHaveLength(0);

    // The failed turn left nothing behind: the next message is the whole history.
    fake.status = 200;
    const before = fake.calls.length;
    await frames(await say(chat, { message: "try again", session: fs[0].data.id }));
    expect(fake.calls[before].messages).toHaveLength(1);
    expect(fake.calls[before].messages[0]).toMatchObject({ role: "user", content: "try again" });
  }, 20_000);
});

// ---------- the request itself ----------

describe("bad requests", () => {
  test("400 for an empty message, a missing one, an oversized one, and bad JSON", async () => {
    const { fake, chat } = rig();
    for (const body of [{ message: "" }, { message: "   " }, {}, { message: "x".repeat(2001) }]) {
      const res = await say(chat, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("text/plain");
    }
    const malformed = await chat.handle(new Request("http://theater.test/chat", { method: "POST", body: "{oops" }), "1.2.3.4");
    expect(malformed.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    expect(chat.sessions()).toBe(0);

    // The longest message that is still allowed goes through.
    const ok = await say(chat, { message: "x".repeat(2000) });
    expect(ok.status).toBe(200);
    await frames(ok);
  });
});
