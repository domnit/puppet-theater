# puppet-theater

A 2D shadow-puppet theater that agents stage and revise at any granularity.
Spec: [notes/spec.md](notes/spec.md). Reasoning: [notes/spec-scratch.md](notes/spec-scratch.md).

## Milestone 0 — renderer, part tree, beat player, harness

```bash
bun install
bun run dev        # harness at http://localhost:4200
bun run check      # tsc
bun test           # unit tests + fixture invariants
git config core.hooksPath .githooks   # once per clone: run check + test before each commit
bun scripts/snapshot.ts fixtures/plays/00-showcase.json 1.9 5.3 7.8 9.8   # stills → out/  (--no-rods, --no-hand-rods)
```

The harness loads a play from `fixtures/plays/`, embeds any cast entry given as
a path under `fixtures/`, validates it, and plays it once. Edit any fixture or
source file and the page updates in place (fixtures re-fetch, code reloads,
time position is kept).

- **Transport**: play/pause (space), frame step (← →), beat step (shift+← →),
  scrub, home/end.
- **One puppet**: a cast member alone, at rest, centred, procedural layers off.
- **Layers**: idle (breath, sway, joint drift), follow-through, swing
  (pendulum), main rods, hand rods. Toggle each to see what it contributes.
- **Overlays**: pivots and local axes, part boundaries, computed bounding
  boxes, cap discs. The cast panel lists the part tree with live angles; click
  a part there or on the stage to select it. Each part is tagged with what
  holds it (`main rod`, `rod`, `via <hand>`), and a part that is keyed more than
  12° while the root stands still with nothing holding it gets an `unheld`
  warning — that motion has no visible cause.

### Layout

```
src/model/types.ts     zod schemas for Puppet, Play, Beat, Pose; TS types inferred
src/model/path.ts      SVG path data → canonical absolute M L Q C Z; bbox, mirror, area
src/model/puppet.ts    resolve a puppet: tree, depth, mirrorOf, structural checks
src/engine/timeline.ts scenes/beats → one beat axis; sparse poses → full keys
src/engine/evaluate.ts frame(t): keyed pose + idle + follow-through + pendulum → world matrices
src/render/stage.ts    live SVG DOM renderer with overlays
src/render/snapshot.ts headless frame → SVG string
src/harness/           the dev page
dev.ts                 Bun dev server: static, bundle-on-request, SSE reload
fixtures/puppets/      hand-authored puppets
fixtures/plays/        six failure-mode fixtures (spec §6.1) and a showcase
test/                  unit tests for the pure core; an invariant sweep over the fixtures
.githooks/pre-commit   runs check + test; enable with core.hooksPath (above)
```

### Conventions decided at the keyboard

- A keyframe's `ease` governs the motion *into* it from the previous key.
- A puppet is not drawn before its first keyframe; after its last, it holds.
- `facing` and `plane` switch at the midpoint of a segment; everything else
  interpolates. To change plane without a size pop, add a near-zero-length
  key that swaps `plane` and rescales `scale` by the plane ratio (see the
  showcase, scene 2).
- The root part's angle is keyable like any joint (`joints.torso`).
- `mirrorOf` reflects across the part's local Y axis. If the part also has its
  own `path`, the path wins and `mirrorOf` is kept as provenance.
- A puppet of height `unit` stands half the stage at `scale: 1` on the mid
  plane; `root.scale` sets its size relative to the others.
- Swing parts hang from world-down and are driven by their pivot's motion. The
  pendulum is a fixed-step simulation from t=0 with one-second checkpoints, so
  scrubbing is deterministic.
- Rods: the root always has a main rod at its pivot; a part with `rod: [x, y]`
  has a hand rod attached there, half the main rod's width, that drives the
  chain from that part to the root. Every rod is held at a fixed point below the
  stage, directly under where its attachment sits at rest, so it stands vertical
  at rest and tilts as the hand moves. Rods are drawn a little softer and
  lighter than the figure, since they are held behind it.

## Milestones 1–2 — store, selectors, edits, tools, MCP

```bash
bun run serve      # theater at http://localhost:4300
PUPPET_DEV=1 bun run serve    # rebuild the viewer bundle when src/ changes
```

| Env | Default | What |
|---|---|---|
| `PORT` | `4300` | listen port |
| `PUPPET_DB` | `data/theater.sqlite` | SQLite file; `:memory:` in tests |
| `PUPPET_BASE_URL` | the request's own origin | origin the play URLs are built from, and the OAuth issuer; set it behind a proxy |
| `PUPPET_ADMIN_SECRET` | — | seeds the `author` account (role `admin`) with this secret |
| `PUPPET_DEV` | — | `1`: readable bundle, rebuilt on change |

Routes: `GET /` (the landing page), `GET /plays` (a plain index of plays),
`POST /chat`, `POST|DELETE /mcp`, the OAuth set
(`GET /.well-known/oauth-authorization-server`,
`GET /.well-known/oauth-protected-resource[/mcp]`, `POST /register`,
`GET|POST /authorize`, `POST /token`), `GET /p/:id` and `GET /p/:id/events` (SSE),
`GET /api/landing`, `GET /api/plays`, `GET /api/plays/:id`,
`GET /api/plays/:id/versions`, `POST /admin/featured`, `POST /admin/chat`.

### Connecting

The only thing to hand anyone is the URL:

```bash
claude mcp add --transport http puppet-theater http://localhost:4300/mcp
```

The first call gets a 401 that points at the OAuth metadata; the client
registers itself (dynamic client registration), opens `/authorize` in a
browser, and that page is where signup and sign-in happen — not before. A
newcomer types a name, or nothing, and gets an account; the id and secret are
shown once, for signing in from another browser later. A browser that has been
here before is remembered by a cookie and continues with one click. No email,
so no verification: 5 new accounts an hour per address, 500 in all.

The server is its own authorization server — OAuth 2.1 code flow with PKCE,
opaque bearer tokens in SQLite (access one hour, refresh thirty days,
rotating), clients registered per RFC 7591, metadata per RFC 8414 and 9728.
Nothing external is involved, and no new configuration: `PUPPET_BASE_URL` is
the issuer, and behind a proxy it must be set (and be https; clients refuse an
http issuer that is not localhost). `/admin/featured` keeps HTTP Basic with the
seeded admin secret, since it is curled rather than connected to.

The anonymous principal `public` (what the in-app chat will act as) never
authenticates: it may create and edit open plays and nothing else.

### The six tools

`create_play`, `list_plays`, `read_play`, `edit_play`, `edit_scene`, `edit_cast` —
spec §3.1, as plain functions over the store in `src/tools/index.ts` and
registered from one `TOOLS` array, so the MCP server and the in-app chat cannot
drift apart. An edit call is one atomic batch and one version: nothing commits
unless every edit applies and the result validates, and the response names the
index that failed. Pass `version` to have a batch refused rather than clobber a
concurrent change to the same scope (`rejected: [{ index: -1, … }]`).

Two rules live in this layer rather than in the document: `mode` is a column on
the play row, so `set mode` is pulled out of an `edit_play` batch, allowed only
for the creator, and applied without writing a version; and a contour and its
note are written together, so an `edit_cast` batch that writes a part's `path`
must write that part's `note` too (mirrored parts are exempt; a new puppet needs
its own note).

Selectors are rewritten play-absolute before a batch is stored, so the version
history and the SSE feed carry no hidden scope.

### Layout

```
src/doc/selector.ts    selector grammar: parse, format, scope prefixing, navigation
src/doc/edit.ts        the five edits, applied to a doc; applyAndValidate
src/doc/validate.ts    spec §2.3 checks, normalisation, bounds
src/doc/read.ts        the read_play projection: depths, derived geometry, warnings
src/doc/library.ts     import sources: lib.*, pl_x/cast/y; rescale and provenance
src/library/index.ts   loads library/puppets/*.json and library/parts/*.json
src/store/db.ts        SQLite: users, plays, append-only versions, commit events
src/tools/index.ts     the six tools and the TOOLS registry
src/tools/descriptions.ts  each tool's description — the model's only manual
src/server/index.ts    Bun.serve: routes, tool context, admin seeding
src/server/mcp.ts      stateless streamable-HTTP MCP over TOOLS
src/server/auth.ts     bearer tokens for /mcp, Basic for /admin, the 401 challenge
src/server/oauth.ts    metadata, registration, the token endpoint, code issuance
src/server/authorize.ts  the authorize page: signup, sign-in, remembered browser
src/server/limit.ts    per-address sliding-window limiter
src/server/sse.ts      /p/:id/events: one store subscription, fanned out per play
src/server/assets.ts   viewer page, bundle and stylesheet
src/server/html.ts     the plain pages the server renders itself
```

## Milestone 3 — the browser view

`/p/:id` is the stage. It fetches the play, autoplays it once, and holds on the
final frame; it does not loop. A hairline scrubber and a play/pause glyph fade
in when the pointer is near the bottom edge (space toggles, ← → step a frame).
A play with no scenes shows the lit, empty scrim with its title — the first
thing anyone sees after `create_play`.

The page then opens `/p/:id/events`. Each commit arrives as the batch of edits
that made it, and the page applies them with the same `applyEdits` the server
used: mid-playback the change takes effect from the current frame, paused it
re-renders in place, and if playback had ended and the play grew it resumes
into the new material. A batch containing an `import` arrives as the whole
document instead (the browser has no library); a version gap triggers a
refetch. Nothing in `src/viewer/` or `src/doc/` touches Bun or node APIs, which
is what lets the server bundle the document code straight into the page.

```
src/viewer/index.html  the page: a title, the stage, the controls
src/viewer/main.ts     fetch, resolve, play; the SSE feed; the controls
src/viewer/style.css   warm neutrals, grain, one gradient (the lamp)
```

## Milestone 4 — library and imports

`library/puppets/*.json` and `library/parts/*.json` are the curated starters,
each with an integer `version`: puppets `fox`, `keeper`, `heron`; parts
`lantern` and `hand_open`. `list_plays` returns the index, and `edit_cast`
imports:

```jsonc
{ "op": "import", "src": "lib.heron", "as": "heron" }                 // a starter, latest version
{ "op": "import", "src": "lib.heron@1" }                              // a pinned version
{ "op": "import", "src": "pl_nvx27t/cast/heron", "as": "gull" }       // a puppet from any play
{ "op": "import", "src": "lib.part.lantern",
  "into": "keeper", "parent": "hand_near", "pivot": [0, 8] }          // a part subtree, rescaled by unit
```

Imports copy; nothing is referenced at render time. The copy's `from` records
where it came from (`lib.heron@1`, `pl_nvx27t/cast/heron@2`), and an imported
part subtree is rescaled by the ratio of the two puppets' `unit`.

```bash
PUPPET_ADMIN_SECRET=… bun scripts/seed.ts   # fixture plays as closed demo plays, plus an open play built by importing lib.heron
```

## Milestone 5 — the in-app chat and the landing page

`GET /` is the stage: one play picked at random from the `featured` set, played
once, read-only — no SSE and no model call on the way in. If nothing is
featured it shows the empty lit scrim. The old index of plays moved to `/plays`.
The plays are featured with `POST /admin/featured` (Basic auth, the seeded
admin), and `bun scripts/seed.ts` features the showcase.

A pencil in the lower-right corner opens the chat. It pulses until first
clicked and never again (`localStorage`). The panel opens on one line — the
MCP URL, or type below — and closes on Escape or a click anywhere else. A
visitor types once and the stage assembles: `POST /chat` runs the Anthropic
SDK's tool runner in process over the same `TOOLS` the MCP server registers
(spec §4.6 — nothing exists in one client and not the other) plus one tool of
the page's own, `show_play`, which puts an existing play on stage; it acts as
`public`, so it can only make and edit open plays. The reply streams as prose;
the edits reach the page over the play's own `/p/:id/events` feed, the same as
they would for any other viewer. Every commit the chat makes is announced to
the page: a commit on another play switches the page to it (the URL becomes
`/p/:id`, so the visitor can share what they made), and a commit on the play
already on stage replays it from the top with the change in it — a landing
pick the visitor edits becomes their live page the same way. The conversation
is the transcript on screen: a page load starts a new session, so the server
never continues a chat the visitor cannot see. Clicking a part on stage
prefixes the input with `[puppet / part]`, which the model reads as pointing.

The system prompt (`src/server/prompt.ts`) is short and plain on purpose: it
says who is talking and how to end a reply (with one specific thing that could
change next — the only onboarding there is), and nothing else. The domain and
whatever whimsy there is live in the tool descriptions, which an MCP caller
gets too. Play content — titles, labels, notes — is named as material and never
instruction, since anyone can write it.

### The chat's wire protocol

`POST /chat` with `{ session?, message, play_id?, landing? }` answers
`text/event-stream` in every case but a malformed request: `session {id}` first,
then `text {delta}` frames, `play {play_id}` for every commit and every
`show_play` (the page shows that play, replaying it from the top if it is the
one on stage), and `done {}` — or `dark {text}`, a written failure state in
place of an error. The session lives in server memory (two hours idle); the
page keeps its id in memory only, so a reload starts a new one.

### Spend

| Env | Default | What |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | unset: the chat is dark |
| `PUPPET_CHAT_MODEL` | `claude-sonnet-5` | adaptive thinking and low effort where the model takes them (Claude 4.6 and later; older ids such as `claude-haiku-4-5` get a plain request), one cache breakpoint after the system prompt |
| `PUPPET_CHAT_DAILY_USD` | `5` | daily ceiling, from a rate table in `src/server/spend.ts` fed by each response's `usage` |
| `PUPPET_CHAT_PER_IP` | `30` | messages an hour per address |
| `PUPPET_CHAT_PER_SESSION` | `40` | messages per session |
| `PUPPET_CHAT_MAX_STEPS` | `30` | model calls per turn — the cap that matters, since a loop spends without anyone typing |

Every call is a row in the `spend` table. `POST /admin/chat` with
`{"enabled": false}` is the kill switch (a `settings` row, so it survives a
restart) and answers with today's totals. Every ceiling renders the same
sentence in the chat rather than an error. The outermost layer is not code: a
Console workspace with a monthly limit holding the key.

```
src/server/chat.ts     POST /chat: sessions, caps, the tool runner over TOOLS, the SSE reply
src/server/spend.ts    the rate table, cost per call, start of the UTC day
src/server/prompt.ts   the system prompt
src/viewer/chat.ts     the button, the panel, the stream reader, click-a-part
test/chat.test.ts      the loop end to end against a scripted fake of the Messages API
```
