// The OAuth flow end to end, driven by the SDK's own client: discovery,
// dynamic registration, the authorize page (played by fetch, forms and all),
// the code exchange, and then tools/list with the token that came out. Then
// the other ways in — sign in with the shown secret, continue as the
// remembered browser — and the refusals.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type RunningServer } from "../src/server";
import { openStore, type Store } from "../src/store/db";

let running: RunningServer;
let store: Store;
let base: string;

beforeAll(() => {
  store = openStore(":memory:");
  running = startServer({ store, port: 0 });
  base = running.url;
});

afterAll(() => {
  running.stop();
  store.close();
});

/** What Claude Code is, as far as this server can tell: a public client on a loopback redirect. */
class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationFull;
  toks?: OAuthTokens;
  verifier?: string;
  authorizationUrl?: URL;
  readonly redirectUrl = "http://localhost:9/callback";
  readonly clientMetadata: OAuthClientMetadata = {
    redirect_uris: [this.redirectUrl],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Puppet Test Client",
  };
  state() {
    return "st8";
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationFull) {
    this.info = i;
  }
  tokens() {
    return this.toks;
  }
  saveTokens(t: OAuthTokens) {
    this.toks = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier!;
  }
}

/** Connect; if the server wants a person, hand back the authorize URL instead of a client. */
async function connect(provider: Provider): Promise<{ client: Client; transport: StreamableHTTPClientTransport } | URL> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  const client = new Client({ name: "puppet-test", version: "0" });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    return provider.authorizationUrl!;
  }
}

// ---------- a browser, in miniature ----------

function unesc(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** The hidden fields of the page's forms — what a submit would carry. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) out[unesc(m[1])] = unesc(m[2]);
  return out;
}

function cookieOf(res: Response): string | undefined {
  return res.headers.get("set-cookie")?.split(";")[0];
}

async function submit(fields: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${base}/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": "203.0.113.7",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

function codeFrom(res: Response, redirectUrl: string): { code: string; state: string | null } {
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  expect(`${to.origin}${to.pathname}`).toBe(redirectUrl);
  expect(to.searchParams.get("error")).toBeNull();
  return { code: to.searchParams.get("code")!, state: to.searchParams.get("state") };
}

// ---------- tests ----------

describe("discovery", () => {
  test("the metadata documents parse with the SDK's schemas and agree with each other", async () => {
    const prm = OAuthProtectedResourceMetadataSchema.parse(
      await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json(),
    );
    expect(prm.resource).toBe(`${base}/mcp`);
    expect(prm.authorization_servers).toEqual([base]);
    const as = OAuthMetadataSchema.parse(await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json());
    expect(as.issuer).toBe(base);
    expect(as.registration_endpoint).toBe(`${base}/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    const root = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(root.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("registration refuses a plain-http redirect off loopback", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });
});

describe("the whole flow", () => {
  const first = new Provider();
  let userId: string;
  let secret: string;
  let sessionCookie: string;
  let playId: string;

  test("a newcomer registers, signs up on the authorize page, and is connected", async () => {
    const opened = await connect(first);
    expect(opened).toBeInstanceOf(URL);
    const authorizeUrl = opened as URL;
    expect(first.info?.client_id).toBeDefined();
    expect(authorizeUrl.pathname).toBe("/authorize");
    expect(authorizeUrl.searchParams.get("resource")).toBe(`${base}/mcp`);

    // The page names the client and offers both ways in.
    const pageRes = await fetch(authorizeUrl);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain("Puppet Test Client wants to stage plays here as you.");
    expect(html).toContain("localhost:9");
    expect(html).toContain('value="signup"');
    expect(html).toContain('value="login"');
    const fields = hiddenFields(html);
    expect(fields.client_id).toBe(first.info!.client_id);
    expect(fields.code_challenge).toBeDefined();

    // Sign up: shown the secret once, with a button to continue.
    const minted = await submit({ ...fields, action: "signup", name: "Ada" });
    expect(minted.status).toBe(200);
    sessionCookie = cookieOf(minted)!;
    expect(sessionCookie).toMatch(/^pt_session=/);
    const mintedHtml = await minted.text();
    const shown = /id\s+(u_\w+)\nsecret\s+([A-Za-z0-9_-]+)</.exec(mintedHtml)!;
    userId = shown[1];
    secret = shown[2];
    expect(mintedHtml).toContain("Continue to Puppet Test Client");

    // Continue: back to the client with a code and the state it sent.
    const back = await submit({ ...hiddenFields(mintedHtml), action: "continue" }, sessionCookie);
    const { code, state } = codeFrom(back, first.redirectUrl);
    expect(state).toBe("st8");

    // The client exchanges the code and gets in.
    const pending = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: first });
    await pending.finishAuth(code);
    expect(first.toks?.access_token).toBeDefined();
    expect(first.toks?.refresh_token).toBeDefined();

    const connected = await connect(first);
    expect(connected).not.toBeInstanceOf(URL);
    const { client } = connected as { client: Client };
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("create_play");
    const created = await client.callTool({ name: "create_play", arguments: { title: "Ada's Lamp", mode: "closed" } });
    playId = JSON.parse((created.content as { text: string }[])[0].text).play_id;
    expect(store.getPlay(playId)!.row.creator).toBe(userId);
    expect(store.getUser(userId)!.name).toBe("Ada");
    await client.close();
  });

  test("a code is single use and the verifier must match", async () => {
    const auth = new URL((await connect(new Provider())) as URL);
    const fields = hiddenFields(await (await fetch(auth)).text());
    const back = await submit({ ...fields, action: "continue" }, sessionCookie);
    const { code } = codeFrom(back, "http://localhost:9/callback");
    const exchange = (verifier: string) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: fields.client_id }),
      });
    const wrong = await exchange("not-the-verifier");
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("invalid_grant");
    // Spent by the failed attempt: a code does not survive a wrong guess.
    const again = await exchange("still-not");
    expect((await again.json()).error).toBe("invalid_grant");
  });

  test("the same person signs in from a fresh browser with the shown secret", async () => {
    const second = new Provider();
    const auth = (await connect(second)) as URL;
    const fields = hiddenFields(await (await fetch(auth)).text());

    const bad = await submit({ ...fields, action: "login", id: userId, secret: "wrong" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("do not match");

    const good = await submit({ ...fields, action: "login", id: userId, secret });
    const { code } = codeFrom(good, second.redirectUrl);
    expect(cookieOf(good)).toMatch(/^pt_session=/);
    await new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: second }).finishAuth(code);

    const { client } = (await connect(second)) as { client: Client };
    const mine = await client.callTool({ name: "list_plays", arguments: { mine: true } });
    expect(JSON.parse((mine.content as { text: string }[])[0].text).plays.map((p: { id: string }) => p.id)).toContain(playId);
    await client.close();
  });

  test("a remembered browser is offered one click, and can switch", async () => {
    const auth = (await connect(new Provider())) as URL;
    const remembered = await fetch(auth, { headers: { Cookie: sessionCookie } });
    const html = await remembered.text();
    expect(html).toContain("You are Ada");
    expect(html).toContain('value="continue"');
    expect(html).not.toContain('value="signup"');

    const switched = await submit({ ...hiddenFields(html), action: "switch" }, sessionCookie);
    expect(switched.status).toBe(200);
    expect(await switched.text()).toContain('value="signup"');
    expect(cookieOf(switched)).toBe("pt_session=");
    // The session is gone server-side too.
    const forgotten = await (await fetch(auth, { headers: { Cookie: sessionCookie } })).text();
    expect(forgotten).not.toContain("You are Ada");
  });

  test("declining sends the client an access_denied error", async () => {
    const auth = (await connect(new Provider())) as URL;
    const fields = hiddenFields(await (await fetch(auth)).text());
    const res = await submit({ ...fields, action: "deny" });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st8");
  });

  test("a refresh token rotates: new pair works, old refresh is dead", async () => {
    const before = first.toks!;
    const refresh = (token: string) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: first.info!.client_id }),
      });
    const res = await refresh(before.refresh_token!);
    expect(res.status).toBe(200);
    const after = (await res.json()) as OAuthTokens;
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(store.getToken(after.access_token, "access")!.user.id).toBe(userId);
    expect((await (await refresh(before.refresh_token!)).json()).error).toBe("invalid_grant");

    // A refresh token belongs to the client it was issued to.
    const other = new Provider();
    await connect(other);
    const stolen = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: after.refresh_token!, client_id: other.info!.client_id }),
    });
    expect((await stolen.json()).error).toBe("invalid_grant");
  });
});

describe("refusals", () => {
  test("an unknown client or an unregistered redirect gets a page, never a redirect", async () => {
    const unknown = await fetch(`${base}/authorize?client_id=nobody&response_type=code&code_challenge=x&code_challenge_method=S256`);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("Unknown client");

    const provider = new Provider();
    const auth = (await connect(provider)) as URL;
    auth.searchParams.set("redirect_uri", "https://elsewhere.example/cb");
    const elsewhere = await fetch(auth, { redirect: "manual" });
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain("Unregistered redirect");
  });

  test("a request without PKCE is bounced to the client as an error", async () => {
    const provider = new Provider();
    const auth = (await connect(provider)) as URL;
    auth.searchParams.delete("code_challenge");
    const res = await fetch(auth, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  test("signup is rate limited per address", async () => {
    const auth = (await connect(new Provider())) as URL;
    const fields = hiddenFields(await (await fetch(auth)).text());
    const post = () =>
      fetch(`${base}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.4" },
        body: new URLSearchParams({ ...fields, action: "signup" }).toString(),
      });
    let last = await post();
    expect(last.status).toBe(200);
    for (let i = 0; i < 5; i++) last = await post();
    expect(last.status).toBe(429);
  });
});
