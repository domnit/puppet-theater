// The authorization server (spec §4.1): this process is both the MCP resource
// and the place tokens come from. OAuth 2.1 authorization code with PKCE,
// dynamic client registration (RFC 7591), metadata for discovery (RFC 8414,
// RFC 9728), opaque bearer tokens looked up in SQLite. No upstream identity
// provider; who the user is gets decided on the authorize page (authorize.ts),
// which calls `issueCode` once it knows.
//
// The SDK's own auth router is Express-bound, so these are web-standard
// handlers over the same shapes; the client side of the SDK (what Claude Code
// and claude.ai run) is what they are tested against.

import {
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store } from "../store/db";
import type { Limiter } from "./limit";

export const ACCESS_TTL = 60 * 60 * 1000;
export const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL = 5 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

/** The MCP endpoint is the protected resource; `base` is the origin (PUPPET_BASE_URL). */
export function resourceUrl(base: string): string {
  return `${base}/mcp`;
}

export function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource/mcp`;
}

export function authorizationServerMetadata(base: string): OAuthMetadata {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    service_documentation: base,
  };
}

export function protectedResourceMetadata(base: string): OAuthProtectedResourceMetadata {
  return {
    resource: resourceUrl(base),
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "puppet-theater",
    resource_documentation: base,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** RFC 6749 §5.2 error body. */
export function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

function s256(verifier: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(verifier).digest();
  return Buffer.from(hash).toString("base64url");
}

/** The registered client as the SDK types it, or null. Never includes the secret. */
export function loadClient(store: Store, id: string): OAuthClientInformationFull | null {
  const row = store.getClient(id);
  return row ? (row.metadata as OAuthClientInformationFull) : null;
}

/**
 * Where a client may be sent back to: https anywhere, http only on loopback
 * (Claude Code listens on localhost), and private schemes for native apps.
 */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return u.protocol !== "javascript:" && u.protocol !== "data:" && u.protocol !== "file:";
}

/** POST /register — RFC 7591. Anyone may register; the account comes later, on /authorize. */
export async function register(store: Store, req: Request, ip: string, limit: Limiter): Promise<Response> {
  if (limit(ip)) return oauthError("too_many_requests", "too many registrations from this address", 429);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthError("invalid_client_metadata", "body must be JSON");
  }
  const parsed = OAuthClientMetadataSchema.safeParse(body);
  if (!parsed.success) return oauthError("invalid_client_metadata", parsed.error.message);
  const meta = parsed.data;
  if (meta.redirect_uris.length === 0) return oauthError("invalid_redirect_uri", "at least one redirect_uri");
  const bad = meta.redirect_uris.find((u) => !redirectUriAllowed(u));
  if (bad) return oauthError("invalid_redirect_uri", `redirect_uri not allowed: ${bad}`);
  const method = meta.token_endpoint_auth_method ?? "client_secret_basic";
  if (!["none", "client_secret_basic", "client_secret_post"].includes(method)) {
    return oauthError("invalid_client_metadata", `unsupported token_endpoint_auth_method: ${method}`);
  }
  const grants = meta.grant_types ?? ["authorization_code"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return oauthError("invalid_client_metadata", "only authorization_code and refresh_token grants");
  }

  const id = crypto.randomUUID();
  const secret = method === "none" ? undefined : randomToken();
  const info: OAuthClientInformationFull = {
    ...meta,
    token_endpoint_auth_method: method,
    grant_types: grants,
    response_types: meta.response_types ?? ["code"],
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  store.registerClient({ id, secret, metadata: info });
  return json(secret ? { ...info, client_secret: secret, client_secret_expires_at: 0 } : info, 201);
}

/** Called by the authorize page once the user is known. Returns the code to send back. */
export function issueCode(
  store: Store,
  args: { clientId: string; userId: string; redirectUri: string; codeChallenge: string; resource: string | null },
): string {
  const code = randomToken();
  store.createCode({ code, ttlMs: CODE_TTL, ...args });
  return code;
}

function mint(store: Store, clientId: string, userId: string): OAuthTokens {
  const access = randomToken();
  const refresh = randomToken();
  store.createToken({ token: access, kind: "access", clientId, userId, ttlMs: ACCESS_TTL });
  store.createToken({ token: refresh, kind: "refresh", clientId, userId, ttlMs: REFRESH_TTL });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh };
}

/**
 * The client authenticating to /token: `client_secret_basic`, `client_secret_post`,
 * or, for a public client, just its id. Returns the client or an error response.
 */
function authenticateClient(store: Store, req: Request, form: URLSearchParams): OAuthClientInformationFull | Response {
  let id = form.get("client_id") ?? undefined;
  let secret = form.get("client_secret") ?? undefined;
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return oauthError("invalid_client", "malformed Basic credentials", 401);
    id = decodeURIComponent(decoded.slice(0, colon));
    secret = decodeURIComponent(decoded.slice(colon + 1));
  }
  if (!id) return oauthError("invalid_client", "client_id required", 401);
  const row = store.getClient(id);
  if (!row) return oauthError("invalid_client", "unknown client", 401);
  if (row.hasSecret && (secret === undefined || !store.verifyClient(id, secret))) {
    return oauthError("invalid_client", "client authentication failed", 401);
  }
  return row.metadata as OAuthClientInformationFull;
}

function resourceMismatch(base: string, requested: string | null): boolean {
  if (requested === null) return false;
  try {
    return new URL(requested).href !== new URL(resourceUrl(base)).href;
  } catch {
    return true;
  }
}

/** POST /token — authorization_code (with PKCE) and refresh_token (rotating). */
export async function token(store: Store, req: Request, base: string): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return oauthError("invalid_request", "body must be form-encoded");
  }
  const client = authenticateClient(store, req, form);
  if (client instanceof Response) return client;
  const resource = form.get("resource");
  if (resourceMismatch(base, resource)) return oauthError("invalid_target", `this server is ${resourceUrl(base)}`);

  switch (form.get("grant_type")) {
    case "authorization_code": {
      const code = form.get("code");
      const verifier = form.get("code_verifier");
      if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier required");
      const stored = store.consumeCode(code);
      if (!stored || stored.clientId !== client.client_id) return oauthError("invalid_grant", "unknown or spent code");
      if (s256(verifier) !== stored.codeChallenge) return oauthError("invalid_grant", "code_verifier does not match");
      const redirect = form.get("redirect_uri");
      if (redirect && redirect !== stored.redirectUri) return oauthError("invalid_grant", "redirect_uri differs from the one authorized");
      if (stored.resource && resource && stored.resource !== resource) return oauthError("invalid_target", "resource differs from the one authorized");
      return json(mint(store, client.client_id, stored.userId));
    }
    case "refresh_token": {
      const refresh = form.get("refresh_token");
      if (!refresh) return oauthError("invalid_request", "refresh_token required");
      const stored = store.getToken(refresh, "refresh");
      if (!stored || stored.clientId !== client.client_id) return oauthError("invalid_grant", "unknown or expired refresh token");
      store.deleteToken(refresh);
      return json(mint(store, client.client_id, stored.user.id));
    }
    case null:
      return oauthError("invalid_request", "grant_type required");
    default:
      return oauthError("unsupported_grant_type", "authorization_code or refresh_token");
  }
}
