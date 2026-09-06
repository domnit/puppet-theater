// Signup exists to hand out MCP credentials (spec §4.1): no email, therefore
// no verification, therefore a per-IP rate limit and a hard cap on the number
// of accounts. The secret is shown once and never again — it is stored only as
// a salted hash.

import type { Store } from "../store/db";
import { esc, page } from "./html";

const PER_IP = 5;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_USERS = 500;

export interface Signup {
  form(): Response;
  /** `baseUrl` is the origin the config block tells the client to call. */
  create(name: string, ip: string, baseUrl: string): Response;
}

export function createSignup(store: Store): Signup {
  const recent = new Map<string, number[]>();

  function limited(ip: string): boolean {
    const now = Date.now();
    const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    hits.push(now);
    recent.set(ip, hits);
    return hits.length > PER_IP;
  }

  return {
    form() {
      return page(
        "pupper-theater — credentials",
        `<h1>pupper-theater</h1>
<p class="sub">A shadow-puppet stage that agents write to.</p>
<p>These are credentials for the MCP server: six tools for staging a wordless
puppet play, and a URL where it plays as you write it. No email, no password to
remember — the secret below is shown once, and a new pair costs nothing.</p>
<hr>
<form method="post" action="/signup">
  <label for="name">A name to sign your plays with (optional)</label>
  <input id="name" name="name" type="text" maxlength="60" autocomplete="off">
  <button type="submit">Mint credentials</button>
</form>`,
      );
    },

    create(name, ip, baseUrl) {
      if (store.countUsers() >= MAX_USERS) {
        return page("pupper-theater", `<h1>The house is full</h1><p class="sub">This build caps signups at ${MAX_USERS}.</p>`, 503);
      }
      if (limited(ip)) {
        return page(
          "pupper-theater",
          `<h1>Slow down</h1><p class="sub">${PER_IP} credentials an hour per address. Try again later.</p>`,
          429,
        );
      }
      const { id, secret } = store.createUser({ name: name.slice(0, 60) || undefined, role: "user" });
      const basic = Buffer.from(`${id}:${secret}`).toString("base64");
      const config = JSON.stringify(
        { mcpServers: { "pupper-theater": { type: "http", url: `${baseUrl}/mcp`, headers: { Authorization: `Basic ${basic}` } } } },
        null,
        2,
      );
      return page(
        "pupper-theater — your credentials",
        `<h1>Yours</h1>
<p class="sub warn">The secret is shown once. Copy it now.</p>
<pre>id      ${esc(id)}
secret  ${esc(secret)}</pre>
<h2>Claude Code</h2>
<pre>claude mcp add --transport http pupper-theater ${esc(baseUrl)}/mcp --header "Authorization: Basic ${esc(basic)}"</pre>
<h2>Everything else</h2>
<pre>${esc(config)}</pre>
<footer>Ask it to stage something. It will hand you back a URL that plays as it
is written.</footer>`,
      );
    },
  };
}
