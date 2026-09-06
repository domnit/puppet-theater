# Puppet Theater — Spec

A 2D shadow-puppet theater. Agents stage wordless plays and revise them at any
granularity, from "a tragedy in three scenes" down to one joint angle on one
beat. Plays live at URLs and play on load; edits appear on screen as they land.

Two clients over one tool surface: an MCP server (Claude Code, claude.ai) and an
in-app chat. Reasoning and rejected alternatives are in
[spec-scratch.md](spec-scratch.md); this file states what gets built.

Stack: TypeScript on Bun, SQLite, SVG rendering, SSE.

---

## 1. Data model

### 1.1 Puppet

A puppet is a tree of parts. Each part is a filled silhouette drawn in its own
local frame and rotated about its pivot. Cast members are puppets; there is no
separate rig or actor layer.

```jsonc
{
  "id": "fox",
  "name": "The Fox",
  "note": "a lean fox — long snout, brush tail, low-slung and wary",
  "unit": 100,                       // puppet height in local units
  "cap": 5,                          // joint disc radius
  "from": "lib.quadruped@3",         // provenance only, never resolved
  "restPose": { "head": -4, "leg_fl": 8 },
  "look": { "opacity": 1.0, "idle": 0.8 },
  "parts": [
    { "id": "torso", "parent": null,    "pivot": [0, 0],   "z": 0,
      "note": "long low body, slight dip behind the shoulders", "path": "M…" },
    { "id": "head",  "parent": "torso", "pivot": [30, -8], "z": 1,
      "note": "narrow wedge, snout as long as the skull",
      "path": "M0,-9 Q14,-13 26,-4 L33,2 Q30,9 22,9 L4,10 Q-4,4 0,-9 Z" },
    { "id": "ear_l", "parent": "head",  "pivot": [8, -10], "z": 2,
      "note": "tall pointed ear, slight forward lean", "path": "M0,0 L-3,-14 L7,-6 Z" },
    { "id": "ear_r", "parent": "head",  "pivot": [18, -10], "z": 2,
      "mirrorOf": "ear_l" }
  ]
}
```

**Part fields.** `id`, `parent`, `pivot`, `z`, `path`, `note`. Optional:
`mirrorOf` (reflect another part instead of drawing one), `swing` (pendulum
amplitude, for hanging things).

**Props are parts.** A lantern is a part parented to the head. Passing one
between puppets is a `remove` and an `insert` in the same call.

There are no joint limits, no `box`, no `socket`, no part roles, and no
archetypes or shape parameters.

### 1.2 The part-local frame

- `(0,0)` is the part's pivot — the joint it rotates about, and the point where
  its parent's frame hands off.
- `+Y` runs down the part's length, `+X` to its right (SVG convention: +Y down).
- The part is drawn in **canonical rest**, extended along `+Y`, never in a pose.
  Rest bearing lives in `restPose` as angles.
- A child's `pivot` is a point in **this** frame, and is simultaneously the
  origin of the child's own frame. Attachment and centre of rotation are one
  number.
- All parts of a puppet share its `unit` scale.

World transform, chained from the root:

```
T(part) = T(parent) · translate(pivot) · rotate(restPose + posed angle)
```

Root parts take their placement from `pose.root`.

### 1.3 Paths

Authored liberally, stored canonically. A caller may send any SVG path data. On
write the server normalises to absolute `M L Q C Z` — arcs converted to cubic
béziers, shorthand expanded, relative commands resolved — and stores that.
Nothing is refused for grammar.

- One or more closed subpaths; unclosed subpaths get a `Z` appended.
- Fill only, `fill-rule: nonzero`. No stroke, colour, gradient or opacity.
  Self-intersection is therefore harmless.
- Additional subpaths under `evenodd` produce interior cut-outs.

No smoothing pass. The caller's curve is the curve.

### 1.4 Caps

The renderer unions a disc of radius `cap` at every part's pivot into that
part's silhouette. All parts share one near-black fill, so overlapping parts
merge into a continuous shape: a rotating joint cannot open a seam, and a
contour that stops slightly short of its child's pivot is bridged.

### 1.5 Notes

Every part and puppet carries a `note`: a short natural-language description
written at the same time as the geometry. A contour and its note are always
written by the same call.

Notes are what make later editing possible — path data is opaque, and a session
that did not draw the puppet has no other channel to what it is. They also keep
reads cheap (§3.2) and make changes describable.

### 1.6 Play

```jsonc
{
  "id": "pl_7fk2m",
  "schemaVersion": 1,
  "version": 12,
  "title": "The Lighthouse Keeper's Debt",
  "meta": { "remixOf": null },
  "stage": { "tempo": 96, "backdrop": "cliff" },
  "cast": { "fox": { … }, "keeper": { … } },     // puppets, embedded in full
  "scenes": [ { "id": "s1", "title": "The lamp is lit", "beats": [ … ] } ]
}
```

A play is self-contained: every puppet it uses is embedded, so it can be read,
copied or exported without resolving anything. There are no acts.

### 1.7 Beat

Time is measured in beats of `stage.tempo`, not seconds.

```jsonc
{
  "id": "b4",
  "label": "the lantern goes out",
  "length": 4,                                   // in beats
  "tracks": {
    "fox": [ { "at": 0, "ease": "inOut", "pose": {…} },
             { "at": 3, "ease": "out",   "pose": {…} } ]
  },
  "fx": [ { "at": 0, "type": "lamp", "to": 0.35, "over": 2 } ]
}
```

`fx` entries are **cues** — things that happen during a performance. They are
not edits (§2).

Plays are wordless. There is no dialogue field and no staged text; `title` and
`label` are authoring labels only.

### 1.8 Pose

```jsonc
{
  "joints": { "head": -12, "leg_fl": 34 },
  "root": { "x": 0.42, "y": 0.78, "scale": 1.0, "facing": -1, "plane": "mid" }
}
```

Poses are sparse: unspecified joints inherit from the previous keyframe.
`x`/`y` are normalised to the stage box. `plane` is `far | mid | near`.
Angles are degrees, wrapped to `[-180, 180]`, interpolated along the shortest
arc.

### 1.9 Library

A store of reusable puppets, parts and backdrops. Kept minimal in the initial
build — enough that a first play can start from an import rather than nothing.

**Copy, never reference.** Importing embeds a full copy. `from` records
provenance and is never resolved at render time, so a library edit cannot
retroactively change a play that already exists.

**Any play is a library.** An import source resolves either to a curated entry
(`lib.quadruped@3`) or to a puppet inside any play (`pl_3ab1x/cast/heron`).

Imported parts are rescaled by the ratio of the two puppets' `unit`. Part naming
(`torso`, `head`, `arm_l`/`farm_l`/`hand_l`, `leg_fl`/`paw_fl`) is a convention;
library parts transfer only between puppets that follow it.

---

## 2. Selectors and edits

### 2.1 Selectors

```
s1                              a scene
s1/b4                           a beat
s1/b4:fox                       one puppet's track in that beat
s1/b4:fox@0                     a keyframe
s1/b4:fox@0.joints.arm_l        one joint angle
s1/b4:fox@*.root.x              that value across every keyframe in the track
cast.fox.parts.snout.path       one contour
cast.fox.parts.snout.note       what that contour is, in words
cast.fox.restPose.head          rest bearing
stage.tempo                     a global
```

IDs are stable strings; nothing is addressed by index, so reordering never
breaks a selector. `@*` applies an edit across a whole track.

### 2.2 Edits

An edit is one change to the document: an address plus a change. Edits never
appear inside a stored play. They exist as the payload of an edit tool, as the
diff stored with each version, and as what the change feed pushes to browsers.

| Kind | Shape |
|---|---|
| `set` | `{op, sel, value}` — write here, replacing what is there |
| `insert` | `{op, sel, value, after?}` — add to an ordered list, anchored by id |
| `remove` | `{op, sel}` — delete; removing a part removes its subtree |
| `nudge` | `{op, sel, delta}` — relative change |
| `import` | `{op, src, as?, into?, parent?, pivot?}` — copy a subtree in |

One edit-tool call carries one array of edits, applied atomically and committed
as one version. A rejected edit rejects the batch; the call returns which one
failed and why.

### 2.3 Validation

Only what the renderer cannot survive is checked. Everything else renders, and
is fixed by an edit if it looks wrong.

| Check | On failure |
|---|---|
| path parses as SVG path data | reject with the parser error |
| subpaths closed | auto-close |
| non-degenerate area | reject |
| `parent` resolves; tree is acyclic | reject |
| `mirrorOf` resolves to a part with a path | reject |
| part count and document size within bounds | reject |

Grammar is normalised rather than validated (§1.3).

---

## 3. Tools

### 3.1 Surface

| Tool | Signature |
|---|---|
| `create_play` | `(title?) → {play_id, url}` |
| `list_plays` | `(query?, mine?)` |
| `read_play` | `(play_id, sel?, depth?, include_paths?)` |
| `edit_play` | `(play_id, edits[]) → {version, rejected[]}` |
| `edit_scene` | `(play_id, scene_id, edits[]) → {version, rejected[]}` |
| `edit_cast` | `(play_id, puppet_id?, edits[]) → {version, rejected[]}` |

Edit tools are scoped by altitude. `edit_play` covers title, tempo, backdrop,
`mode` and the scene list; `edit_scene` covers beats, tracks, keyframes, poses
and cues; `edit_cast` covers puppets, parts, contours, notes and imports.

A scope is a selector prefix: inside `edit_scene(play_id, "s3")` an edit
addresses `b4:fox@*.joints.head`, not `s3/b4:fox@*.joints.head`.

Scoping gives each tool a description covering one domain, shortens selectors,
bounds what a call can touch, and lets the optimistic version check run
per-scope rather than per-document.

There are no playback tools and no fork tool.

### 3.2 Reads

`read_play` returns ids, titles, beat labels and the `note` on every puppet and
part. It does not return path data unless asked:

```
read_play(play_id, sel: "cast.fox", include_paths: ["ear_l", "ear_r"])
```

It also returns derived geometry — each part's computed bounding box and its
position at rest, plus the puppet's overall extent. These are free, since
extents are computed rather than authored, and they let a caller check
proportion without seeing anything.

### 3.3 Example

*"Her head tilts down through the whole last beat."*

```
read_play(play_id, sel: "s5", depth: "beat")
→ s5 "The lamp goes out"
    b1 "she waits"        tracks: heron, keeper
    b2 "the light fails"  tracks: heron, keeper

edit_scene(play_id, "s5", [
  { op: "nudge", sel: "b2:heron@*.joints.head", delta: -18 }
])
→ { version: 13, rejected: [] }
```

The server applies the edit, commits version 13, and pushes the same edit over
SSE. Every browser watching applies it immediately.

Staging a whole play is the same mechanism at higher volume: `create_play`, an
`edit_cast` per puppet, an `edit_scene` per scene. Each call commits a version
and each version is pushed, so the stage assembles while the user watches.

---

## 4. Server

### 4.1 Identity and access

| Principal | Comes from | Can |
|---|---|---|
| `public` | nothing — the in-app chat acts as this | create and edit **open** plays only |
| a user | a rate-limited signup form | create open or closed plays; edit any open play and their own closed ones |
| the author | seeded, `admin` | the above, plus set `featured` |

- The web needs no login. `public` has no credentials and cannot be logged in
  as; it is an attribution row.
- `public` cannot close a play, so nothing anonymous becomes un-editable.
- Signup exists to obtain MCP credentials. The page mints a credential and shows
  the config block to paste. Rate limited per IP, capped in total, no email and
  therefore no verification.
- A play has a creator and a `mode`: `open` or `closed`. Anyone may read any
  play; there are no private plays. `mode` is a field changed with `edit_play`,
  and the server refuses the change from anyone but the creator.

**MCP auth:** OAuth with dynamic client registration if it proves cheap;
otherwise HTTP Basic with the signup credentials supplied through the client's
env. The signup form serves either path.

### 4.2 Storage

```
plays(id, creator, mode, featured, head_version)
versions(play_id, n, doc, edits, author)
```

Append-only. Concurrency is optimistic: an edit batch carries the version it was
computed against, and a stale batch is rejected and retried against head.

There is no `revert` tool in this build, so an edit to an open play is
permanent. History is recorded regardless, so revert can be added later.

### 4.3 Browser view

`/p/:id` autoplays the play's latest version once on load, then holds on the
final frame. It does not loop.

- A hairline scrubber and play/pause, staying out of the way until the pointer
  is near them. These are viewer controls; agents have no equivalent.
- Updates arrive over SSE as edit deltas and apply immediately: during playback
  the change takes effect from the current frame onward; while paused or
  scrubbed, the current frame re-renders in place. If playback has already ended
  and an edit extends the play, playback resumes into the new material — which
  is what makes a stage assemble while someone watches.
- Push goes to every viewer, not only editors.
- A play with no scenes shows an empty lit scrim — lamp, texture, proscenium,
  nothing on it. This is a designed state, not a blank page.

### 4.4 Landing page

Picks a play at random from the `featured` set and shows it read-only: no SSE,
no chat, no inference on the critical path. `featured` is settable only by the
author account.

The author's own demo plays are `closed` and owned by the author account.

### 4.5 Inference

Through Milestone 4 the server calls no model; callers do all generation.

The in-app chat (Milestone 5) is the exception and needs an agent loop. **TODO:**
use something off the shelf that speaks MCP and streams tool calls rather than
hand-rolling one. It arrives with a provider key held server-side, per-IP session
limits, a per-session message cap, a global daily spend ceiling with a kill
switch and a written failure state, and a cheap default model. The chat is
anonymous, so this is an unauthenticated endpoint that spends money.

MCP callers pay for their own inference.

### 4.6 Tool module

Tools are plain functions over the store. The MCP server wraps them for remote
transport; the in-app chat wraps the same functions in-process. A tool cannot
exist in one client and not the other.

---

## 5. Rendering and motion

### 5.1 Target

SVG DOM. The cast is small — a handful of puppets of roughly a dozen parts — and
the DOM gives hit-testing, so clicking a limb can address it directly.

### 5.2 Playback

`requestAnimationFrame`, with wall time mapped to beat position through
`stage.tempo`. Playback is deterministic given (play, version, time): procedural
motion is seeded from puppet id, never from `Math.random()`.

### 5.3 Interpolation

Joint angles interpolate along the shortest arc between keyframes. Default
easing is `inOut`; a small named set is available per keyframe.

Three procedural layers run additively on top of keyframed values, so that a
held pose is never a statue:

- **Breath and sway** — low amplitude, phase-offset per puppet, scaled by
  `look.idle`.
- **Follow-through** — child joints lag their parent by two or three frames.
- **Swing** — parts with a `swing` value run a cheap pendulum.

### 5.4 Look

Lit scrim, dark figures. The stage is a warm radial gradient; puppets are
near-black fills. Depth is `pose.root.plane`:

| plane | scale | blur | opacity |
|---|---|---|---|
| `far` | 0.82 | 2.4px | 0.72 |
| `mid` | 1.00 | 0.9px | 0.88 |
| `near` | 1.15 | 0.2px | 1.00 |

### 5.5 Page design

The stage is the page. Chrome is close to absent: a title, the scrubber, one
button.

Avoid the house style of generated web pages — violet/pink gradients and
gradient text, glassmorphism, rounded-2xl cards with soft shadows on a grey
field, a centred hero with paired filled and ghost buttons, emoji or circled
line-icons as section markers, pill badges, the default Tailwind slate/indigo
palette, Inter at default weights, animated gradient blobs, dark mode as the
same layout in inverted greys.

Instead: the lamp is the only gradient on the page and interface elements are
flat; warm neutrals (bone, ochre, oxblood, near-black) rather than slate and
indigo; a typeface with a point of view, closer to a playbill than a dashboard;
texture rather than blur — paper grain, vignette, the weave of the scrim;
physical references rather than material-design ones.

Test: with the puppets removed, a screenshot should still look like it came from
somewhere specific.

### 5.6 Chat affordance

One button in the lower corner. It pulses gently until first clicked, then never
again; the state lives in `localStorage`.

This is the only onboarding in the product. There are no suggested prompts, so
the stage manager's habit of answering a request and offering one thing deeper
is the sole mechanism by which a visitor learns the depth exists. It needs
writing, not just a tone.

---

## 6. Milestones

| # | Deliverable | Gate |
|---|---|---|
| 0 | Renderer, part tree, beat player, and a dev harness (§6.1). Hand-authored puppet and play JSON. No agent, no server. | Motion go/no-go, judged by eye against the fixtures in §6.1. If a hand-authored play does not look good, nothing downstream saves it. |
| 1 | Document store, selectors, the five kinds of edit, SQLite versions | a scripted edit changes one joint and it looks right |
| 2 | MCP server: six tools, signup, open/closed | Claude Code stages a play end to end |
| 3 | Browser view, SSE push, scrubber and play/pause | edit from Claude Code, watch the stage change |
| 4 | Library, imports, starter puppets | "use the heron from that play" works |
| 5 | In-app chat, stage-manager persona, landing page | a visitor types once and gets a play, then changes one detail |
| — | Stretch: `render` tool, sound, video export | |

### 6.1 Milestone 0 harness

Milestone 0 is judged by eye, so it needs a way to exercise the renderer without
a server or an agent:

- A local page that loads puppet and play JSON from disk and re-renders on file
  change, so a hand edit to a contour or an angle shows up immediately.
- Play/pause, scrub, and single-frame stepping.
- A single-puppet view showing one puppet at rest, isolated.
- Debug overlays, toggleable: pivots, part boundaries, computed bounding boxes,
  cap discs, and the part tree as a list.

Fixtures should target the known failure modes rather than being one pretty
play:

| Fixture | Exercises |
|---|---|
| a four-beat single-keyframe hold | whether the idle layer saves a dead hold |
| a fast wide limb rotation | seam tearing, shortest-arc interpolation, follow-through |
| one puppet on each of the three planes | depth reading |
| a puppet with a swinging prop | pendulum, and parenting through a socket point |
| a mirrored pair with one part overridden | `mirrorOf` and its override |
| a deliberately short contour that misses its child's pivot | cap bridging |

MCP comes before the chat because Claude Code is already a working client: a
real agent drives the stage from Milestone 2 with no UI work, and the data
model, edits and notes get iterated against real agent behaviour early.

The risk this creates is that the visitor's path is built last. The browser view
lands at Milestone 3 and is separable, so a play can be watched long before one
can be typed at. The persona should be drafted and tested as a system prompt
inside Claude Code from Milestone 2. Budget the chat's showmanship — the
"what changed" affordance, the in-fiction framing, the feel of a stage
assembling — separately from its loop, which is about a day.

---

## 7. Out of scope

Not 3D. No image generation or asset pipeline. No server-side model before the
chat. No private plays, teams, or permissions beyond open/closed. No login on
the web, no password reset, no email. No `revert`. No playback tools. No
dialogue or staged text. No sound in the initial build. No opening prompts or
bundled remix sources. No video export. No mobile-first layout.

Not a general animation editor. Every capability exists to make one creative
object editable at every zoom level; anything that does not serve that is cut.
