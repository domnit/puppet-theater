// The product server: the viewer page and its change feed, a small read API,
// the MCP endpoint, signup, and a temporary index. `bun run serve`.
//
// Env: PORT (4300), PUPPET_DB (data/theater.sqlite), PUPPET_BASE_URL (the
// origin play URLs are built from; defaults to the request's own),
// PUPPET_ADMIN_SECRET (seeds the `author` admin account), PUPPET_DEV=1
// (rebuild the viewer bundle when src/ changes).

import { createImportResolver, libraryIndex, type ImportSources } from "../doc/library";
import { loadLibrary } from "../library";
import { openStore, type Store } from "../store/db";
import { list_plays, ToolError, type Principal, type ToolContext } from "../tools";
import { devAssets, viewerPage, viewerScript, viewerStyle } from "./assets";
import { basicAuth, PUBLIC, unauthorized } from "./auth";
import { esc, page } from "./html";
import { handleMcp } from "./mcp";
import { createHub } from "./sse";
import { createSignup } from "./signup";

export interface ServerOptions {
  store?: Store;
  /** 0 asks the OS for a free port — what the tests use. */
  port?: number;
  /** Origin for play URLs; the request's own origin when absent. */
  baseUrl?: string;
  dev?: boolean;
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
  const signup = createSignup(store);
  const unwatch = opts.dev ? devAssets() : null;

  const context = (req: Request, principal: Principal): ToolContext => ({
    store,
    principal,
    baseUrl: opts.baseUrl ?? new URL(req.url).origin,
    imports,
    libraryIndex: library,
  });

  const server = Bun.serve({
    port: opts.port ?? 4300,
    // Bun drops idle connections after 10 s by default; SSE must outlive that.
    idleTimeout: 255,
    async fetch(req, self) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === "/" && req.method === "GET") return index(store);
        if (path === "/signup") {
          if (req.method === "GET") return signup.form();
          if (req.method === "POST") {
            const form = await req.formData();
            const origin = opts.baseUrl ?? new URL(req.url).origin;
            return signup.create(String(form.get("name") ?? ""), clientIp(req, self), origin);
          }
        }
        if (path === "/mcp") {
          const principal = basicAuth(req, store);
          if (!principal) return unauthorized();
          return handleMcp(req, context(req, principal));
        }
        if (path === "/admin/featured" && req.method === "POST") return featured(req, store);
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

  return {
    server,
    store,
    url: opts.baseUrl ?? `http://localhost:${server.port}`,
    stop() {
      unwatch?.();
      hub.close();
      server.stop(true);
      if (!opts.store) store.close();
    },
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
  if (!principal) return unauthorized();
  if (principal.role !== "admin") return text("admin only", 403);
  const body = (await req.json()) as { play_id?: string; featured?: boolean };
  if (!body.play_id || !store.getPlay(body.play_id)) return text("no such play", 404);
  store.setFeatured(body.play_id, body.featured !== false);
  return Response.json({ play_id: body.play_id, featured: body.featured !== false });
}

/** Temporary: the real landing page (a featured play, played read-only) is Milestone 5. */
function index(store: Store): Response {
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
<p class="sub">A shadow-puppet stage that agents write to. This list is a placeholder — the
landing page proper comes later.</p>
${rows.length ? `<ul>${items}</ul>` : "<p>Nothing staged yet.</p>"}
<footer><a href="/signup">Credentials for the MCP server</a></footer>`,
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
