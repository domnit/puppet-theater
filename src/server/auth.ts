// Who is calling. /mcp takes a bearer token minted by /token (oauth.ts); an
// unauthenticated call gets a 401 whose WWW-Authenticate points at the
// protected-resource metadata, which is how a client finds the authorize
// page. /admin still takes HTTP Basic with the seeded admin secret, since it
// is curled, not connected to. `public` is the anonymous principal (spec
// §4.1): an attribution row, never something one logs in as, so it is what an
// unauthenticated caller gets and never what verifyUser returns.

import type { Store } from "../store/db";
import type { Principal } from "../tools";
import { resourceMetadataUrl } from "./oauth";

export const PUBLIC: Principal = { id: "public", role: "public" };

/** The principal behind a bearer token, or null if absent, unknown or expired. */
export function bearerAuth(req: Request, store: Store): Principal | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const token = store.getToken(m[1], "access");
  return token ? { id: token.user.id, role: token.user.role } : null;
}

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

/** 401 for /mcp. `base` is the origin the metadata lives at. */
export function unauthorized(req: Request, base: string): Response {
  const hadToken = req.headers.has("authorization");
  const challenge = [
    'Bearer realm="puppet-theater"',
    ...(hadToken ? ['error="invalid_token"'] : []),
    `resource_metadata="${resourceMetadataUrl(base)}"`,
  ].join(", ");
  return new Response("a bearer token is required; your MCP client will take you through sign-in\n", {
    status: 401,
    headers: { "WWW-Authenticate": challenge, "Content-Type": "text/plain" },
  });
}

export function unauthorizedBasic(): Response {
  return new Response("admin credentials required\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="puppet-theater"', "Content-Type": "text/plain" },
  });
}
