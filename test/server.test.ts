// The server end to end on an ephemeral port: the read API, the MCP endpoint
// through the real SDK client with a bearer token minted straight into the
// store, and the change feed. The OAuth flow that mints tokens for real is in
// oauth.test.ts.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createImportResolver } from "../src/doc/library";
import { startServer, type RunningServer } from "../src/server";
import { openStore, type Store } from "../src/store/db";
import { create_play, edit_play, type ToolContext } from "../src/tools";

let running: RunningServer;
let store: Store;
let base: string;
let creds: { id: string; secret: string };
let token: string;
let playId: string;

function ctx(): ToolContext {
  return {
    store,
    principal: { id: creds.id, role: "user" },
    baseUrl: base,
    imports: createImportResolver({ puppets: [], parts: [], play: (id) => store.getPlay(id) }),
    libraryIndex: [],
  };
}

function bearer(): string {
  return `Bearer ${token}`;
}

beforeAll(() => {
  store = openStore(":memory:");
  running = startServer({ store, port: 0 });
  base = running.url;
  creds = store.createUser({ name: "tester", role: "user" });
  token = "test-access-token";
  store.createToken({ token, kind: "access", clientId: "test-client", userId: creds.id, ttlMs: 60_000 });
  playId = create_play(ctx(), { title: "The Lamp" }).play_id;
});

afterAll(() => {
  running.stop();
  store.close();
});

describe("read routes", () => {
  test("GET /api/plays/:id serves the head document", async () => {
    const res = await fetch(`${base}/api/plays/${playId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { play: { title: string }; version: number; mode: string; creator: string };
    expect(body.play.title).toBe("The Lamp");
    expect(body.version).toBe(1);
    expect(body.mode).toBe("open");
    expect(body.creator).toBe(creds.id);

    expect((await fetch(`${base}/api/plays/pl_nope`)).status).toBe(404);
  });

  test("the index lists the play and links to its stage", async () => {
    const html = await (await fetch(base)).text();
    expect(html).toContain(`/p/${playId}`);
    expect(html).toContain("The Lamp");
  });
});

describe("mcp", () => {
  test("POST /mcp without a token is a 401 that points at the resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(res.headers.get("www-authenticate")).not.toContain("invalid_token");

    const stale = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(stale.status).toBe(401);
    expect(stale.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("initialize, tools/list and one tools/call over the SDK client", async () => {
    const client = new Client({ name: "puppet-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: bearer() } } }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(["create_play", "edit_cast", "edit_play", "edit_scene", "list_plays", "read_play"]);

    const called = await client.callTool({ name: "read_play", arguments: { play_id: playId, depth: "play" } });
    const text = (called.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toMatchObject({ title: "The Lamp", version: 1, mode: "open" });
    await client.close();
  });

  test("a tool that refuses comes back as an error result, not a transport failure", async () => {
    const client = new Client({ name: "puppet-test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: bearer() } } }),
    );
    const called = await client.callTool({ name: "read_play", arguments: { play_id: "pl_nope" } });
    expect(called.isError).toBe(true);
    await client.close();
  });
});

test("the change feed says hello and then carries the next commit", async () => {
  const res = await fetch(`${base}/p/${playId}/events`);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  async function nextEvent(): Promise<string> {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out waiting for an event")), 2000)),
    ]);
    return decoder.decode(chunk.value);
  }

  expect(await nextEvent()).toContain("event: hello");
  edit_play(ctx(), { play_id: playId, edits: [{ op: "set", sel: "stage.tempo", value: 120 }] });
  const edit = await nextEvent();
  expect(edit).toContain("event: edit");
  expect(JSON.parse(edit.slice(edit.indexOf("data: ") + 6))).toMatchObject({
    version: 2,
    edits: [{ op: "set", sel: "stage.tempo", value: 120 }],
  });
  await reader.cancel();
});
