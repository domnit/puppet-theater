// /authorize — the one page a person sees. An MCP client sends its user here;
// the page works out who they are and sends them back with a code. Signup and
// sign-in both happen here, not before (spec §4.1): a newcomer types a name
// (or nothing) and gets an account; someone returning on a fresh browser
// pastes the id and secret they were shown at signup; a browser that has been
// here before is remembered by a cookie, and continues with one click.
//
// No email, so no verification: signup is rate limited per address and capped
// in total. The secret is shown once and stored only as a hash.

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store, User } from "../store/db";
import { esc, page } from "./html";
import { createLimiter } from "./limit";
import { issueCode, loadClient, randomToken, resourceUrl } from "./oauth";

const SIGNUPS_PER_IP = 5;
const LOGINS_PER_IP = 30;
const HOUR = 60 * 60 * 1000;
const MAX_USERS = 500;
const SESSION_TTL = 180 * 24 * HOUR;
const COOKIE = "pt_session";

/** The OAuth request, carried through the forms as hidden fields. */
interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

export interface Authorize {
  get(req: Request, base: string): Response;
  post(req: Request, ip: string, base: string): Promise<Response>;
}

export function createAuthorize(store: Store): Authorize {
  const signupLimit = createLimiter(SIGNUPS_PER_IP, HOUR);
  const loginLimit = createLimiter(LOGINS_PER_IP, HOUR);

  function sessionUser(req: Request): User | null {
    const id = cookieValue(req, COOKIE);
    return id ? store.getSession(id) : null;
  }

  function startSession(user: User, base: string): string {
    const id = randomToken();
    store.createSession({ id, userId: user.id, ttlMs: SESSION_TTL });
    return setCookie(id, SESSION_TTL, base.startsWith("https:"));
  }

  /** Validate the request (spec §4.1 of RFC 6749 in miniature). Returns a page or redirect on failure. */
  function check(params: URLSearchParams | FormData, base: string): { auth: AuthRequest; client: OAuthClientInformationFull } | Response {
    const get = (k: string) => {
      const v = params.get(k);
      return typeof v === "string" && v !== "" ? v : null;
    };
    const clientId = get("client_id");
    const client = clientId ? loadClient(store, clientId) : null;
    if (!clientId || !client) return refuse("Unknown client", "This MCP client is not registered here. Add the server again and let it register itself.");
    let redirect = get("redirect_uri");
    if (redirect) {
      if (!client.redirect_uris.includes(redirect)) return refuse("Unregistered redirect", "The client asked to be sent somewhere it did not register.");
    } else if (client.redirect_uris.length === 1) redirect = client.redirect_uris[0];
    else return refuse("Ambiguous redirect", "The client registered several return addresses and named none.");

    const auth: AuthRequest = {
      client_id: clientId,
      redirect_uri: redirect,
      response_type: get("response_type") ?? "",
      code_challenge: get("code_challenge") ?? "",
      code_challenge_method: get("code_challenge_method") ?? "",
      state: get("state"),
      scope: get("scope"),
      resource: get("resource"),
    };
    if (auth.response_type !== "code") return bounce(auth, "unsupported_response_type", "only response_type=code");
    if (!auth.code_challenge || auth.code_challenge_method !== "S256") return bounce(auth, "invalid_request", "PKCE with S256 is required");
    if (auth.resource !== null && auth.resource !== resourceUrl(base)) return bounce(auth, "invalid_target", `this server is ${resourceUrl(base)}`);
    return { auth, client };
  }

  function grant(auth: AuthRequest, user: User, headers: Record<string, string> = {}): Response {
    const code = issueCode(store, {
      clientId: auth.client_id,
      userId: user.id,
      redirectUri: auth.redirect_uri,
      codeChallenge: auth.code_challenge,
      resource: auth.resource,
    });
    const to = new URL(auth.redirect_uri);
    to.searchParams.set("code", code);
    if (auth.state) to.searchParams.set("state", auth.state);
    return redirect(to, headers);
  }

  return {
    get(req, base) {
      const checked = check(new URL(req.url).searchParams, base);
      if (checked instanceof Response) return checked;
      const user = sessionUser(req);
      return user ? continuePage(checked.auth, checked.client, user) : signInPage(checked.auth, checked.client);
    },

    async post(req, ip, base) {
      const form = await req.formData();
      const checked = check(form, base);
      if (checked instanceof Response) return checked;
      const { auth, client } = checked;
      const field = (k: string) => String(form.get(k) ?? "");

      switch (field("action")) {
        case "signup": {
          if (store.countUsers() >= MAX_USERS) return refuse("The house is full", `This build caps accounts at ${MAX_USERS}.`, 503);
          if (signupLimit(ip)) return refuse("Slow down", `${SIGNUPS_PER_IP} new accounts an hour per address. Try again later.`, 429);
          const name = field("name").trim().slice(0, 60);
          const { id, secret } = store.createUser({ name: name || undefined, role: "user" });
          const user = store.getUser(id)!;
          return mintedPage(auth, client, user, secret, { "Set-Cookie": startSession(user, base) });
        }
        case "login": {
          if (loginLimit(ip)) return refuse("Slow down", "Too many sign-in attempts from this address. Try again later.", 429);
          const user = store.verifyUser(field("id").trim(), field("secret").trim());
          if (!user) return signInPage(auth, client, "That id and secret do not match.");
          return grant(auth, user, { "Set-Cookie": startSession(user, base) });
        }
        case "continue": {
          const user = sessionUser(req);
          if (!user) return signInPage(auth, client, "This browser is no longer signed in.");
          return grant(auth, user);
        }
        case "switch": {
          const id = cookieValue(req, COOKIE);
          if (id) store.deleteSession(id);
          return signInPage(auth, client, undefined, { "Set-Cookie": setCookie("", 0, base.startsWith("https:")) });
        }
        case "deny":
          return bounce(auth, "access_denied", "the user declined");
        default:
          return refuse("Bad request", "That form did not say what to do.");
      }
    },
  };
}

// ---------- pages ----------

function clientName(client: OAuthClientInformationFull): string {
  return client.client_name?.trim() || "An MCP client";
}

function lead(client: OAuthClientInformationFull, auth: AuthRequest): string {
  const back = new URL(auth.redirect_uri);
  const where = back.protocol === "http:" || back.protocol === "https:" ? back.host : back.protocol.replace(/:$/, "");
  return `<h1>puppet-theater</h1>
<p class="sub">${esc(clientName(client))} wants to stage plays here as you.
<span class="small">It will be sent back to ${esc(where)}.</span></p>`;
}

function hidden(auth: AuthRequest): string {
  return Object.entries(auth)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join("\n");
}

function who(user: User): string {
  return user.name ? `${esc(user.name)} <span class="meta">${esc(user.id)}</span>` : `<span class="meta">${esc(user.id)}</span>`;
}

function signInPage(auth: AuthRequest, client: OAuthClientInformationFull, error?: string, headers: Record<string, string> = {}): Response {
  return page(
    "puppet-theater — sign in",
    `${lead(client, auth)}
${error ? `<p class="error">${esc(error)}</p>` : ""}
<h2>New here</h2>
<form method="post" action="/authorize">
${hidden(auth)}
  <label for="name">A name to sign your plays with (optional)</label>
  <input id="name" name="name" type="text" maxlength="60" autocomplete="off" autofocus>
  <div class="row">
    <button type="submit" name="action" value="signup">Create an account and continue</button>
    <button type="submit" name="action" value="deny" class="ghost">Not now</button>
  </div>
</form>
<h2>Been here before</h2>
<form method="post" action="/authorize">
${hidden(auth)}
  <label for="id">id</label>
  <input id="id" name="id" type="text" autocomplete="username">
  <label for="secret">secret</label>
  <input id="secret" name="secret" type="password" autocomplete="current-password">
  <div class="row"><button type="submit" name="action" value="login">Sign in and continue</button></div>
</form>
<footer>No email, nothing to remember. This browser stays signed in; the id and
secret you are shown at signup let you sign in from another one.</footer>`,
    error ? 400 : 200,
    headers,
  );
}

function continuePage(auth: AuthRequest, client: OAuthClientInformationFull, user: User): Response {
  return page(
    "puppet-theater — continue",
    `${lead(client, auth)}
<form method="post" action="/authorize">
${hidden(auth)}
  <p>You are ${who(user)}.</p>
  <div class="row">
    <button type="submit" name="action" value="continue">Continue</button>
    <button type="submit" name="action" value="switch" class="ghost">Someone else</button>
    <button type="submit" name="action" value="deny" class="ghost">Not now</button>
  </div>
</form>`,
  );
}

function mintedPage(auth: AuthRequest, client: OAuthClientInformationFull, user: User, secret: string, headers: Record<string, string>): Response {
  return page(
    "puppet-theater — yours",
    `<h1>Yours</h1>
<p class="sub warn">The secret is shown once. Keep it if you will sign in from another browser.</p>
<pre>id      ${esc(user.id)}
secret  ${esc(secret)}</pre>
<form method="post" action="/authorize">
${hidden(auth)}
  <button type="submit" name="action" value="continue">Continue to ${esc(clientName(client))}</button>
</form>
<footer>Ask it to stage something. It will hand you back a URL that plays as it
is written.</footer>`,
    200,
    headers,
  );
}

/** A direct error page: nothing may be redirected before the client and redirect_uri check out. */
function refuse(title: string, body: string, status = 400): Response {
  return page("puppet-theater", `<h1>${esc(title)}</h1><p class="sub">${esc(body)}</p>`, status);
}

/** An error the client should hear about, at its redirect_uri. */
function bounce(auth: AuthRequest, error: string, description: string): Response {
  const to = new URL(auth.redirect_uri);
  to.searchParams.set("error", error);
  to.searchParams.set("error_description", description);
  if (auth.state) to.searchParams.set("state", auth.state);
  return redirect(to);
}

function redirect(to: URL, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: to.href, "Cache-Control": "no-store", ...headers } });
}

// ---------- cookies ----------

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setCookie(value: string, maxAgeMs: number, secure: boolean): string {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
