// The product server: the landing page and the viewer page with its change
// feed, the in-app chat, a small read API, the MCP endpoint and the OAuth
// endpoints that guard it, and a plain index of plays. `bun run serve`.
//
// Env: PORT (4300), PUPPET_DB (data/theater.sqlite), PUPPET_BASE_URL (the
// origin play URLs are built from and the OAuth issuer; defaults to the
// request's own origin, so set it behind a proxy), PUPPET_ADMIN_SECRET (seeds
// the `author` admin account), PUPPET_DEV=1 (rebuild the viewer bundle when
// src/ changes). The chat (spec §4.5): ANTHROPIC_API_KEY (unset: the chat is
// dark), PUPPET_CHAT_MODEL (claude-sonnet-5), PUPPET_CHAT_DAILY_USD (5),
// PUPPET_CHAT_PER_IP (30 messages an hour), PUPPET_CHAT_PER_SESSION (40),
// PUPPET_CHAT_MAX_STEPS (30 model calls a turn).

import { createImportResolver, libraryIndex, type ImportSources } from "../doc/library";
import { loadLibrary } from "../library";
import { openStore, type Store } from "../store/db";
import { list_plays, ToolError, type Principal, type ToolContext } from "../tools";
import { devAssets, viewerPage, viewerScript, viewerStyle } from "./assets";
import { basicAuth, bearerAuth, PUBLIC, unauthorized, unauthorizedBasic } from "./auth";
import { createAuthorize } from "./authorize";
import { createChat, KILL_SWITCH_KEY, type ChatOptions } from "./chat";
import { esc, page } from "./html";
import { createLimiter } from "./limit";
import { handleMcp } from "./mcp";
import * as oauth from "./oauth";
import { startOfDayUtc } from "./spend";
import { createHub } from "./sse";

export interface ServerOptions {
  store?: Store;
  /** 0 asks the OS for a free port — what the tests use. */
  port?: number;
  /** Origin for play URLs; the request's own origin when absent. */
  baseUrl?: string;
  dev?: boolean;
  /** The chat's knobs; anything omitted comes from env, then the defaults above. */
  chat?: Partial<Omit<ChatOptions, "store" | "context">>;
}

export interface RunningServer {
  server: ReturnType<typeof Bun.serve>;
  store: Store;
  url: string;
  stop(): void;
}

const PLAY_PATH = /^\/p\/([A-Za-z0-9_-]+)(\/events)?$/;
const API_PATH = /^\/api\/plays(?:\/([A-Za-z0-9_-]+)(\/versions)?)?$/;

export function startServer(opts: ServerOptions = {}): RunningServer {
  const store = opts.store ?? openStore();
  seedAdmin(store);

  const sources: ImportSources = { ...loadLibrary(), play: (id) => store.getPlay(id) };
  const imports = createImportResolver(sources);
  const library = libraryIndex(sources);
  const hub = createHub(store);
  const authorize = createAuthorize(store);
  const registrations = createLimiter(20, 60 * 60 * 1000);
  const unwatch = opts.dev ? devAssets() : null;

  const context = (req: Request, principal: Principal): ToolContext => ({
    store,
    principal,
    baseUrl: opts.baseUrl ?? new URL(req.url).origin,
    imports,
    libraryIndex: library,
  });

  // The chat acts as `public` and its play URLs are built from the configured
  // origin, or the server's own once it is listening.
  let ownUrl = opts.baseUrl ?? "";
  const chat = createChat({
    store,
    context: () => ({ store, principal: PUBLIC, baseUrl: ownUrl, imports, libraryIndex: library }),
    ...chatOptionsFromEnv(),
    ...opts.chat,
  });

  const server = Bun.serve({
    port: opts.port ?? 4300,
    // Bun drops idle connections after 10 s by default; SSE must outlive that.
    idleTimeout: 255,
    async fetch(req, self) {
      const url = new URL(req.url);
      const path = url.pathname;
      const base = opts.baseUrl ?? url.origin;
      try {
        if (path === "/" && req.method === "GET") return viewerPage();
        if (path === "/plays" && req.method === "GET") return index(store, base);
        if (path === "/chat" && req.method === "POST") return chat.handle(req, clientIp(req, self));
        if (path === "/api/landing" && req.method === "GET") return landing(store);

        // OAuth: discovery, registration, the authorize page, tokens.
        if (req.method === "OPTIONS" && (path.startsWith("/.well-known/") || path === "/register" || path === "/token")) {
          return oauth.preflight();
        }
        if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
          return oauth.json(oauth.authorizationServerMetadata(base));
        }
        if ((path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") && req.method === "GET") {
          return oauth.json(oauth.protectedResourceMetadata(base));
        }
        if (path === "/register" && req.method === "POST") return oauth.register(store, req, clientIp(req, self), registrations);
        if (path === "/authorize") {
          if (req.method === "GET") return authorize.get(req, base);
          if (req.method === "POST") return authorize.post(req, clientIp(req, self), base);
        }
        if (path === "/token" && req.method === "POST") return oauth.token(store, req, base);

        if (path === "/mcp") {
          const principal = bearerAuth(req, store);
          if (!principal) return unauthorized(req, base);
          return handleMcp(req, context(req, principal));
        }
        if (path === "/admin/featured" && req.method === "POST") return featured(req, store);
        if (path === "/admin/chat" && req.method === "POST") return chatSwitch(req, store);
        if (path === "/viewer.js" && req.method === "GET") return viewerScript();
        if (path === "/viewer.css" && req.method === "GET") return viewerStyle();

        const play = PLAY_PATH.exec(path);
        if (play && req.method === "GET") {
          if (!play[2]) return viewerPage();
          return hub.stream(play[1]) ?? text(`no play ${play[1]}`, 404);
        }

        const api = API_PATH.exec(path);
        if (api && req.method === "GET") {
          if (!api[1]) return Response.json(list_plays(context(req, PUBLIC), {}));
          const got = store.getPlay(api[1]);
          if (!got) return text(`no play ${api[1]}`, 404);
          if (api[2]) return Response.json({ versions: store.listVersions(api[1]) });
          return Response.json({
            play: got.doc,
            version: got.version,
            mode: got.row.mode,
            creator: got.row.creator,
            title: got.row.title,
          });
        }
        return text("not found", 404);
      } catch (e) {
        if (e instanceof ToolError) return text(e.message, e.status);
        console.error(e);
        return text("internal error", 500);
      }
    },
  });

  ownUrl ||= `http://localhost:${server.port}`;

  return {
    server,
    store,
    url: ownUrl,
    stop() {
      unwatch?.();
      chat.close();
      hub.close();
      server.stop(true);
      if (!opts.store) store.close();
    },
  };
}

function chatOptionsFromEnv(): Omit<ChatOptions, "store" | "context"> {
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && process.env[name] !== undefined ? v : fallback;
  };
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.PUPPET_CHAT_MODEL || "claude-sonnet-5",
    dailyUsd: num("PUPPET_CHAT_DAILY_USD", 5),
    perIpPerHour: num("PUPPET_CHAT_PER_IP", 30),
    perSession: num("PUPPET_CHAT_PER_SESSION", 40),
    maxIterations: num("PUPPET_CHAT_MAX_STEPS", 30),
  };
}

/** The author account, so the seeded demo plays have an owner (spec §4.1). */
function seedAdmin(store: Store): void {
  const secret = process.env.PUPPET_ADMIN_SECRET;
  if (!secret) return;
  if (store.getUser("author")) store.setSecret("author", secret);
  else store.createUser({ id: "author", name: "author", role: "admin", secret });
}

function text(body: string, status: number): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain" } });
}

function clientIp(req: Request, self: { requestIP(req: Request): { address: string } | null }): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return self.requestIP(req)?.address ?? "unknown";
}

async function featured(req: Request, store: Store): Promise<Response> {
  const principal = basicAuth(req, store);
  if (!principal) return unauthorizedBasic();
  if (principal.role !== "admin") return text("admin only", 403);
  const body = (await req.json()) as { play_id?: string; featured?: boolean };
  if (!body.play_id || !store.getPlay(body.play_id)) return text("no such play", 404);
  store.setFeatured(body.play_id, body.featured !== false);
  return Response.json({ play_id: body.play_id, featured: body.featured !== false });
}

/** The kill switch (spec §4.5): `{"enabled": false}` darkens the chat until turned back on. */
async function chatSwitch(req: Request, store: Store): Promise<Response> {
  const principal = basicAuth(req, store);
  if (!principal) return unauthorizedBasic();
  if (principal.role !== "admin") return text("admin only", 403);
  const body = (await req.json()) as { enabled?: boolean };
  const enabled = body.enabled !== false;
  store.setSetting(KILL_SWITCH_KEY, enabled ? "on" : "off");
  return Response.json({ enabled, today: store.spendSince(startOfDayUtc()) });
}

/**
 * The landing page's pick (spec §4.4): one play at random from the featured
 * set, in the shape of /api/plays/:id plus its id. 404 when nothing is
 * featured, and the page shows the empty scrim.
 */
function landing(store: Store): Response {
  const rows = store.listPlays({ featured: true, limit: 100 });
  if (rows.length === 0) return text("nothing featured", 404);
  const pick = rows[Math.floor(Math.random() * rows.length)];
  const got = store.getPlay(pick.id);
  if (!got) return text("nothing featured", 404);
  return Response.json({
    play_id: pick.id,
    play: got.doc,
    version: got.version,
    mode: got.row.mode,
    creator: got.row.creator,
    title: got.row.title,
  });
}

/** A plain list of every play, for finding one; the landing page is the stage itself. */
function index(store: Store, base: string): Response {
  const rows = store.listPlays({ limit: 100 });
  const items = rows
    .map(
      (r) =>
        `<li><a href="/p/${esc(r.id)}">${esc(r.title ?? "Untitled")}</a>` +
        ` <span class="meta">${esc(r.id)} · ${r.mode} · v${r.headVersion}</span></li>`,
    )
    .join("");
  return page(
    "puppet-theater",
    `<h1>puppet-theater</h1>
<p class="sub">Every play on this stage, newest change first. Every one is public.</p>
${rows.length ? `<ul>${items}</ul>` : "<p>Nothing staged yet.</p>"}
<footer>MCP: <code>${esc(oauth.resourceUrl(base))}</code> — give that to your client. It will
bring you back here to sign in.</footer>`,
  );
}

if (import.meta.main) {
  const running = startServer({
    port: Number(process.env.PORT ?? 4300),
    baseUrl: process.env.PUPPET_BASE_URL,
    dev: process.env.PUPPET_DEV === "1",
  });
  console.log(`puppet-theater at ${running.url}`);
}
