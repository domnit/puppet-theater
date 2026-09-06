// Milestone 0 dev server: serves the harness, bundles it on request, serves
// fixtures from disk, and pushes a reload event over SSE when files change.
// Not the product server — that arrives in Milestone 2.

import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT ?? 4200);

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
let pending: { kind: string; timer: ReturnType<typeof setTimeout> } | null = null;

function broadcast(kind: "fixture" | "code") {
  // Debounce bursts; a code change wins over a fixture change.
  if (pending) {
    clearTimeout(pending.timer);
    if (pending.kind === "code") kind = "code";
  }
  pending = {
    kind,
    timer: setTimeout(() => {
      const k = pending!.kind;
      pending = null;
      for (const c of clients) {
        try { c.enqueue(enc.encode(`event: ${k}\ndata: {}\n\n`)); } catch { clients.delete(c); }
      }
      console.log(`↻ ${k}`);
    }, 60),
  };
}

watch(path.join(ROOT, "fixtures"), { recursive: true }, () => broadcast("fixture"));
watch(path.join(ROOT, "src"), { recursive: true }, () => broadcast("code"));

async function bundle(): Promise<Response> {
  const r = await Bun.build({
    entrypoints: [path.join(ROOT, "src/harness/main.ts")],
    target: "browser",
    sourcemap: "inline",
    minify: false,
  });
  if (!r.success) {
    const msg = r.logs.map((l) => String(l)).join("\n");
    console.error(msg);
    const js = `document.body.innerHTML = '<pre style="color:#f2c9b8;background:#3a1410;padding:16px;white-space:pre-wrap">' + ${JSON.stringify(msg)}.replace(/</g,'&lt;') + '</pre>';
      new EventSource('/events').addEventListener('code', () => location.reload());`;
    return new Response(js, { headers: { "Content-Type": "text/javascript" } });
  }
  return new Response(await r.outputs[0].text(), { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } });
}

function safeJoin(base: string, rel: string): string | null {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

Bun.serve({
  port: PORT,
  // Bun drops idle connections after 10 s by default; the SSE stream must outlive that.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/" || p === "/index.html") return new Response(Bun.file(path.join(ROOT, "src/harness/index.html")));
    if (p === "/style.css") return new Response(Bun.file(path.join(ROOT, "src/harness/style.css")), { headers: { "Cache-Control": "no-store" } });
    if (p === "/main.js") return bundle();
    if (p === "/api/fixtures") {
      const files = (await readdir(path.join(ROOT, "fixtures/plays"))).filter((f) => f.endsWith(".json")).sort();
      return Response.json(files);
    }
    if (p.startsWith("/fixtures/")) {
      const file = safeJoin(path.join(ROOT, "fixtures"), decodeURIComponent(p.slice("/fixtures/".length)));
      if (!file) return new Response("bad path", { status: 400 });
      const f = Bun.file(file);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (p.startsWith("/out/")) {
      // Stills written by scripts/snapshot.ts, for eyeballing in the same browser.
      const file = safeJoin(path.join(ROOT, "out"), decodeURIComponent(p.slice("/out/".length)));
      if (!file) return new Response("bad path", { status: 400 });
      const f = Bun.file(file);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "Content-Type": file.endsWith(".svg") ? "image/svg+xml" : f.type, "Cache-Control": "no-store" } });
    }
    if (p === "/events") {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      let keep: ReturnType<typeof setInterval>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(enc.encode(": connected\n\n"));
          keep = setInterval(() => { try { c.enqueue(enc.encode(": keepalive\n\n")); } catch { clearInterval(keep); } }, 5000);
        },
        cancel() {
          clients.delete(ctrl);
          clearInterval(keep);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`harness at http://localhost:${PORT}`);
