// The viewer's three files: `src/viewer/index.html` (served at /p/:id, the page
// reads the play id out of location.pathname), the browser bundle of
// `src/viewer/main.ts` (/viewer.js) and `src/viewer/style.css` (/viewer.css).
// The bundle is built on first request and kept in memory; with PUPPET_DEV=1
// the server watches src/ and drops it. Milestone 0's harness keeps its own
// server (dev.ts) and is not served from here.

import { watch } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const VIEWER = path.join(ROOT, "src/viewer");

let bundle: Promise<{ ok: true; js: string } | { ok: false; log: string }> | null = null;
let dev = false;

/**
 * PUPPET_DEV=1: keep the bundle readable, and drop it whenever anything under
 * src/ changes. Returns the watcher's stop function.
 */
export function devAssets(): () => void {
  dev = true;
  bundle = null;
  const w = watch(path.join(ROOT, "src"), { recursive: true }, () => {
    bundle = null;
  });
  return () => w.close();
}

export async function viewerPage(): Promise<Response> {
  return staticFile(path.join(VIEWER, "index.html"), "text/html; charset=utf-8");
}

export async function viewerStyle(): Promise<Response> {
  return staticFile(path.join(VIEWER, "style.css"), "text/css; charset=utf-8");
}

export async function viewerScript(): Promise<Response> {
  const entry = path.join(VIEWER, "main.ts");
  if (!(await Bun.file(entry).exists())) return notBuilt("src/viewer/main.ts");
  bundle ??= build(entry);
  const out = await bundle;
  if (!out.ok) {
    bundle = null;
    return new Response(`/* ${out.log} */`, { status: 500, headers: { "Content-Type": "text/javascript" } });
  }
  return new Response(out.js, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache" } });
}

async function build(entry: string) {
  const r = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    sourcemap: dev ? "inline" : "none",
    minify: !dev,
  });
  if (!r.success) {
    const log = r.logs.map((l) => String(l)).join("\n");
    console.error(log);
    return { ok: false as const, log };
  }
  return { ok: true as const, js: await r.outputs[0].text() };
}

async function staticFile(file: string, type: string): Promise<Response> {
  const f = Bun.file(file);
  if (!(await f.exists())) return notBuilt(path.relative(ROOT, file));
  return new Response(f, { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
}

function notBuilt(what: string): Response {
  return new Response(`${what} does not exist yet — the viewer lands in Milestone 3\n`, {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}
