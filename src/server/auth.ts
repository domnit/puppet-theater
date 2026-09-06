// HTTP Basic for /mcp and /admin — `Authorization: Basic base64(id:secret)`
// with the credentials the signup form mints. `public` is the anonymous
// principal (spec §4.1): an attribution row, never something one logs in as,
// so it is what an unauthenticated caller gets and never what verifyUser
// returns.

import type { Store } from "../store/db";
import type { Principal } from "../tools";

export const PUBLIC: Principal = { id: "public", role: "public" };

/** The principal named by a Basic header, or null if it is absent or wrong. */
export function basicAuth(req: Request, store: Store): Principal | null {
  const m = /^Basic\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const user = store.verifyUser(decoded.slice(0, colon), decoded.slice(colon + 1));
  return user ? { id: user.id, role: user.role } : null;
}

export function unauthorized(message = "credentials required — get a pair at /signup"): Response {
  return new Response(`${message}\n`, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="puppet-theater"', "Content-Type": "text/plain" },
  });
}
