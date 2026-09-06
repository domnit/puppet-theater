// The change feed behind `GET /p/:id/events`. One subscription to the store
// fans out to every open stream, grouped by play.
//
// On connect: `event: hello` with the version the page should already have.
// Per commit: `event: edit` with `{ version, edits, scope, author }`, where the
// selectors are play-absolute (the tools layer rewrites them before they are
// stored), so the viewer applies them with `applyEdits(doc, edits, {kind:"play"})`.
// A batch containing an `import` cannot be replayed in the browser — it has no
// library — so those carry `{ version, doc, ... }` instead: the whole committed
// document. Keepalive comment every 15 s; Bun.serve needs `idleTimeout: 255`
// for the connection to outlive it.

import type { Store } from "../store/db";

const KEEPALIVE_MS = 15_000;

export interface Hub {
  /** An SSE response for one play, or null if there is no such play. */
  stream(playId: string): Response | null;
  /** Open streams, per play — for logs and tests. */
  size(): number;
  close(): void;
}

type Client = ReadableStreamDefaultController<Uint8Array>;

export function createHub(store: Store): Hub {
  const enc = new TextEncoder();
  const rooms = new Map<string, Set<Client>>();

  function frame(event: string, data: unknown): Uint8Array {
    return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function push(playId: string, chunk: Uint8Array): void {
    const room = rooms.get(playId);
    if (!room) return;
    for (const c of room) {
      try {
        c.enqueue(chunk);
      } catch {
        room.delete(c);
      }
    }
  }

  const off = store.onCommit((e) => {
    if (!rooms.has(e.playId)) return;
    const replayable = Array.isArray(e.edits) && !e.edits.some((x) => (x as { op?: string })?.op === "import");
    const body = replayable ? { edits: e.edits } : { doc: e.doc };
    push(e.playId, frame("edit", { version: e.version, ...body, scope: { kind: "play" }, author: e.author }));
  });

  return {
    stream(playId) {
      const got = store.getPlay(playId);
      if (!got) return null;
      let self: Client;
      let keepalive: ReturnType<typeof setInterval>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          self = c;
          let room = rooms.get(playId);
          if (!room) rooms.set(playId, (room = new Set()));
          room.add(c);
          c.enqueue(frame("hello", { version: got.version }));
          keepalive = setInterval(() => {
            try {
              c.enqueue(enc.encode(": keepalive\n\n"));
            } catch {
              clearInterval(keepalive);
            }
          }, KEEPALIVE_MS);
        },
        cancel() {
          clearInterval(keepalive);
          const room = rooms.get(playId);
          room?.delete(self);
          if (room && room.size === 0) rooms.delete(playId);
        },
      });
      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },

    size() {
      let n = 0;
      for (const room of rooms.values()) n += room.size;
      return n;
    },

    close() {
      off();
      for (const room of rooms.values()) for (const c of room) c.close();
      rooms.clear();
    },
  };
}
