# Puppet Theater — Spec Scratch

**Status: working document, not the spec.** This is where decisions get argued
out and where the reasoning behind them is kept. A separate `spec.md` will state
what actually gets built, succinctly and without the alternatives. Things
settled here are still open to revision after prototyping.

Expands [overview.md](overview.md). Two halves: **Part I** is the design as
currently proposed, written as if decided; **Part II** is the decision register —
every fork in the road, with options, a recommendation, and what it blocks.

Anything in Part I marked ⟨Dn⟩ points at the corresponding entry in Part II,
where the alternatives and the reasoning live. Entries are marked **DECIDED**,
**CUT**, or left open.

---

# Part I — The design

## 1. Product definition

A 2D shadow-puppet theater in the browser. The user talks to a stage manager;
the stage manager stages plays and revises them at any granularity. One creative
object — the **play** — stays addressable and editable at every zoom level, and
the same chat box is the interface at all of them.

The thesis under test: *generative tools collapse into reroll buttons because
their output has no addressable structure.* A puppet rig plus a beat grid is
addressable structure. So the demo's job is to make targeted iteration feel
obviously better than rerolling.

### The sixty seconds that matter

1. Landing page: a real play, picked at random, autoplaying on arrival,
   read-only. No API call on the critical path. Silent for now ⟨D-A7⟩.
2. The reviewer clicks the pulsing button in the corner (§4.5) and types
   something of their own — there are no suggested prompts. Curtain, and the
   stage manager builds a play *while they watch* (§5.6): puppets walk on as
   they are cast, beats fill in as they are written.
3. The reply ends with an offer one altitude deeper: *"The heron's wings hold
   flat through the last beat. Want them trembling instead?"* This is the only
   moment the depth is advertised. Coy about how, not about whether.
4. Reviewer takes the offer, or clicks a limb on stage and types. The change
   lands in under a couple of seconds without regenerating the play.
5. A second play, importing that cast, taken somewhere else. Both kept, both
   at their own URL, both live.

If step 4 rerenders the whole play or takes ten seconds, the submission fails,
regardless of what else works.

## 2. The granularity spectrum, made concrete

Every altitude has to bottom out in a real mutation on a real object. The
mapping, end to end:

| Altitude | Example request | Tool | Mutation |
|---|---|---|---|
| Broad | "A tragedy, three scenes, slow" | `edit_play` + `edit_cast` + `edit_scene` | many edits: cast, scenes, beats |
| Story | "The merchant betrays the sailor halfway through" | `edit_scene` ×n | rewrite those scenes' beats, cast preserved |
| Scene | "Cut the last beat, it drags" | `edit_scene` s3 | `remove b7` |
| Staging | "Crowd upstage, lantern centered" | `edit_scene` | `set` root.plane + root.x on 4 tracks |
| Component | "Her head tilts down through the final beat" | `edit_scene` s5 | `nudge b2:heron@*.joints.head -18` |
| Look | "Give the fox a longer snout" | `edit_cast` fox | `set parts.snout` — new contour and note |
| Remix | "Retell as allegory for ⟨bundled source⟩" | `create_play` + all three | a new play, `meta.remixOf` set |
| Borrow | "Use the heron from the other play" | `edit_cast` | `import pl_3ab1x/cast/heron` |
| Branch | "Keep this, try it as comedy" | `create_play` + `import` | a new play holding the same cast |

The two rows that carry the whole thesis are **Component** and **Look** — the
ones a prompt-box-and-reroll tool cannot do at all. Note also that every row uses
the same five kinds of edit (§3.16); only the scope and the volume change. That
is the addressable-structure claim, discharged.

## 3. Data model

Two objects: the **puppet** and the **play** (scenes → beats), plus a **library**
they are drawn from. IDs are stable strings; nothing is addressed by index, so
reordering never breaks a selector.

**The JSON below is illustrative.** Fields are present to show shape and to make
the selectors concrete, not because each has been argued for. `meta.tone`,
`look.edge`, `stage.ratio` and their like are guesses — the implementor decides
what is actually meaningful and should delete whatever earns nothing. What this
section does commit to is the *structure*: the part tree, the local frame,
labels on everything, the selector grammar, and the edit vocabulary.

### 3.1 What is generated, what is checked, what is borrowed

The model authors all of it — part trees, pivots and contours. Nothing is
procedurally generated and nothing is a fixed template ⟨D-A1⟩. Three things keep
that from becoming the pelican:

1. **Contours are drawn in isolation.** Each path is authored in its own local
   frame (§3.3), origin at its own pivot. There is no shared drawing space, so
   there is nothing shared to get wrong.
2. **Composition is a part tree, not a canvas** — a dozen named numbers with
   semantic meaning ("the shoulder is here", "the ear hangs off the head"),
   authored in the same pass as the contours that fit them.
3. **The library is a prior.** A new puppet normally starts by importing a near
   one (§3.11) and diverging. Cold authoring is possible and is the rarer path.

**Archetypes and parameters are cut.** A parametric generator (`snout: 0.7` → a
longer snout) was the mechanism for varying a puppet *when the model could not
draw one*. Once it draws, parameters are a second and weaker way to do the same
thing, and two ways to lengthen a snout is worse than one. What was useful about
archetypes survives as library entries: "quadruped" is a puppet you import and
change, not a type with a code path behind it.

**What that costs.** Nothing structurally enforces proportion any more — fixed
archetype boxes did. Three mitigations, in descending order of confidence: a
puppet is authored in one call in one unit space, so proportion is one
consistent judgment instead of many; imports start from something already
proportioned; and the derived extents in `read_play` (§5.3) let an agent check
proportion numerically, free. What that leaves uncovered is legibility — whether
the silhouette reads as a fox — which needs pixels ⟨D-B14⟩ and is deferred
(§5.4). Until it lands, a human watching the live view is the last check.

### 3.2 The part tree

`parent` composes transforms: a part's rotation carries everything beneath it.
Rotate the shoulder and the forearm, the hand, and whatever the hand is holding
all travel with it.

**It is needed, and it is what makes the granularity thesis work at all.**
Without hierarchy a pose is a full transform per part, and *"raise her arm"*
becomes a compound edit where the model has to work out where the forearm and
hand ended up — the composition problem again, on every pose instead of once per
puppet. With hierarchy the same request is `{ "arm_l": 40 }`: one number, three
parts moved, and sparse poses (§3.12) possible at all.

**Exact semantics.** A part's `pivot` is a point in its **parent's** frame, and
it is simultaneously the origin of the part's **own** frame — the same point
expressed in two coordinate systems. Attachment and centre-of-rotation are
therefore one number rather than two that could disagree. The world transform is
the chain from the root:

```
T(part) = T(parent) · translate(pivot) · rotate(restPose + posed angle)
```

A root part takes its placement from `pose.root` instead of from a parent.

**`socket` is cut.** A per-part `socket` said "children attach here" — but a
child's `pivot` already says exactly that, in the same coordinates. It was one
number written twice, and the second copy could contradict the first. The
puppet-level `sockets` map goes with it: it named a coordinate the model can
read straight off the part tree, and every concept has to pay rent. Attachment
is fully specified by `parent` + `pivot`:

```jsonc
{ "op": "import", "src": "lib.part.hand_open",
  "into": "keeper", "parent": "farm_l", "pivot": [0, 26] }
```

Reversal path: if traces show the model repeatedly attaching things in the wrong
place, named sockets return as pure annotation ⟨D-B22⟩.

### 3.3 The part-local frame

Every part is drawn in its own frame, and the contract is identical every time:

- **Origin `(0,0)` is the pivot** — the joint this part rotates about, and the
  point at which the parent's frame handed off.
- **+Y runs down the part's length**, +X to its right (SVG convention: +Y down).
- **Drawn in canonical rest**, extended along +Y — *not* in a pose. Rest lives
  in `restPose` as angles ⟨D-B16⟩, so a puppet can be re-posed, or its bearing
  changed from proud to hunched, without anything being redrawn.
- **Children's pivots are stated in this frame.** A forearm at `[0, 34]` sits 34
  units down the upper arm.

```
         ┌──────────────────────────────┐
         │             ● (0,0) pivot    │    part   arm_l
         │          ⟋  ·  ⟍            │    drawn along +Y in rest
         │         │  path  │           │    farm_l.pivot = [0,34]
         │          ⟍  ·  ⟋            │    → 34 units down this part
         │             ● [0,34]         │
         └──────────────────────────────┘
```

**`box` is cut.** It declared the extent a contour had to stay inside — but the
model authors the box and the contour in the same breath, so the check was
self-consistent by construction, and nothing else read the field. Extent is
derived: the server computes a bounding box from the path on write for anything
that needs one. All parts of a puppet share its `unit` scale (`unit` = puppet
height), and that is what carries proportion now.

### 3.4 The path contract

A silhouette is a **path**: a sequence of pen commands in the part's local
frame, filled solid. The vocabulary is small.

| Command | Means |
|---|---|
| `M x y` | lift the pen and move to a point, starting a subpath |
| `L x y` | straight line to a point |
| `Q cx cy x y` | curve to a point, bending toward one control point |
| `C c1x c1y c2x c2y x y` | curve to a point, bending toward two control points |
| `Z` | close the subpath back to where it started |

A control point is a magnet the curve leans toward without passing through. Two
of them (`C`, a cubic bézier) express any smooth segment you would draw by hand,
including asymmetric swells and S-curves inside a single segment.

SVG offers more: `A` (elliptical arc), `H`/`V` (axis-aligned lines), `S`/`T`
(smooth continuations), and a lowercase *relative* form of every command where
coordinates are offsets from the previous point rather than absolute positions.

**Authored liberally, stored canonically** ⟨D-B11⟩. The model may write any of
it. On write the server normalises to absolute `M L Q C Z` — arcs converted to
cubic béziers, shorthand expanded, relatives resolved — and stores that. Nothing
is refused for grammar; the constraint is on the stored form, not the authored
one. Reasons to canonicalise:

- **Downstream sees one small grammar.** `M L Q C Z` are all polynomials in one
  parameter, so bounding boxes, mirroring, sampling and hit-testing are a single
  code path. `A` is trigonometric and needs a special case in each of them.
- **Mirroring is the concrete case.** `mirrorOf` reflects a part across an axis.
  For béziers that is negating one coordinate of every point. For an arc it
  means flipping a sweep flag *and* rotating the ellipse's axis — a small and
  classic source of shapes that come out inside-out.
- **Absolute coordinates localise mistakes.** In a relative path every point is
  an offset from the last, so one bad number displaces the entire rest of the
  contour. In absolute form a bad number moves one point, which also makes a
  single coordinate individually addressable by a selector.
- **Arc flags are the specific hazard.** `A` carries two boolean flags choosing
  which of four possible arcs runs between the same two endpoints. They are
  non-visual parameters whose values do not resemble the result, and SVG permits
  writing them without separators (`a1 1 0 011 1` is legal), which breaks naive
  parsers. Generators get them wrong routinely.

Arcs are **not** excluded for expressiveness. A cubic bézier reproduces any
elliptical arc to within a fraction of a pixel and does things arcs cannot.
Exact circles are also faintly against the aesthetic: a lantern that is a
mathematically perfect ellipse reads as machine-made, which is the opposite of
hand-cut leather.

Beyond grammar, three rules:

- One or more **closed** subpaths. Unclosed gets a `Z` appended, not rejected.
- Fill only, `fill-rule: nonzero`. No stroke, colour, gradient or opacity.
- Extra subpaths under `evenodd` are how interior cut-outs work, if A2 goes
  that way.

Silhouette is doing technical work here, not only aesthetic work. There is no
shading, no line weight, no colour, no interior — the model chooses a contour
and nothing else, which is the narrowest form of the drawing task. And `nonzero`
fill means **self-intersection is harmless**: the most common way generated SVG
looks wrong simply does not render. A lumpy contour reads as hand-cut leather; a
lumpy *shaded* figure reads as broken.

### 3.5 Seams and caps: why joints cannot tear

Parts overlap on purpose. The renderer unconditionally unions a **cap disc** of
radius `cap` at every part's pivot into that part's silhouette. Because every
part is the same near-black fill, overlapping parts merge into one continuous
silhouette — rotating a joint can never open a seam, and there is no
correct-versus-incorrect overlap for the model to get wrong.

The cap also **bridges**. If a parent's contour stops a little short of where a
child attaches, the disc at that pivot still renders and closes the gap. That is
why there is no "does the parent's path reach its child" check in §3.7: the
geometry already absorbs the near-misses, and a wild miss is a visible design
error rather than a structural one.

Rendering the cap instead of requiring it converts a rule the model could fail
into geometry it cannot.

### 3.6 Labels: how the document stays legible

Path data is opaque. `"M0,0 L-3,-14 L7,-6 Z"` tells a model revisiting this
puppet nothing about what the ear looks like, so *"make her ears droop"* has
nothing to reason from.

So **every element carries a short natural-language label, written by whoever
made it** ⟨D-B23⟩:

| Element | Field | Example |
|---|---|---|
| part | `note` | "tall pointed ear, slight forward lean, notch near the tip" |
| puppet | `note` | "a lean fox — long snout, brush tail, low-slung and wary" |
| beat | `label` | "the lantern goes out" |
| scene | `title` | "The lamp is lit" |

This is the model writing a note to its future self at the moment it is
cheapest: it has just drawn the thing, so describing it is nearly free. Four
things fall out of it.

- **Later edits work without re-reading geometry.** "The notch near the tip" is
  now a thing that exists in the document and can be addressed in language.
- **`look` gets cheap.** At low depth it returns labels and no path data — a
  whole cast as a paragraph of prose (§5.3).
- **Style coherence** ⟨D-B15⟩. A contour regenerated later reads the puppet's
  `note` and matches what the rest of the puppet already is.
- **Diffs become speakable.** After a redraw the note changed too, so the stage
  manager can say what happened without reciting bezier curves.
- **Edits stay consistent across agent sessions.** This is the one that makes
  notes structural rather than convenient. A Claude Code session tomorrow, or a
  second client editing the same play (§6), has none of the context in which the
  puppet was drawn. The document is the only channel between them, and geometry
  is not a channel — `note` is where the intent that produced a contour survives
  the session that produced it. Without it, every later edit re-derives the
  puppet from its coordinates and drifts.

A contour and its note are written by the same op, always: a redraw replaces
`path` and `note` together. That is enforced by the tool schema rather than by a
validator, so the pair cannot drift.

This is also the answer to *named pivots*. A pivot is a coordinate and wants to
stay one — naming it adds an indirection table that buys nothing. What the model
actually needed was not a name for the point but a description of the part, and
`note` is that, in a form that costs nothing and carries far more.

### 3.7 Validation

The rule is the one that cut joint limits: **validate what the renderer cannot
survive, render around everything else, and let the user fix what they can see.**
A guard the model authors itself, against a failure that is visible and one op
from fixed, costs more than it saves.

Six checks survive, all of them "this would crash or draw nothing":

| Check | Scope | On failure |
|---|---|---|
| path parses as SVG path data | contour | reject, one repair retry with the parser error |
| subpaths closed | contour | auto-close — normalisation, not rejection |
| non-degenerate area | contour | reject — this catches a null result, not a bad drawing |
| `parent` resolves; tree is acyclic | topology | reject — a dangling ref or an infinite loop |
| `mirrorOf` resolves to a part that has a path | topology | reject |
| part count and document size within bounds | resource | reject — a cost guard, not a quality guard |

What was cut, and why each was a bad trade:

| Cut check | Why |
|---|---|
| contour within `box` | `box` is gone (§3.3); the check was self-consistent by construction |
| contour reaches the child's pivot | the cap disc bridges it (§3.5) |
| child pivot inside the parent's extent | a detached limb is visible and one op from fixed, and the check misfires on a tail that legitimately starts wide |
| `minWidth` | a heron's beak is thin on purpose. This moves into the contour directive given to the model, where it belongs as guidance rather than as a warning nobody reads |
| non-canonical commands | normalised on write instead of refused (§3.4) |
| joint limits | §3.10 |

Quality is not a validation problem here. It is B14's problem: render the puppet
and let the model look at it.

### 3.8 Where generation effort goes

Recognition lives in the extremities. A quadruped's legs are any quadruped's
legs; the snout, the ears and the brush of the tail are the fox. That is a fact
about what to prompt for and what to import — spend the model's attention on the
parts that carry identity, borrow the parts that carry mechanism — but it is not
a distinction the schema needs to carry. An earlier draft had a `role` field
marking parts as mechanism or identity; it existed only to decide which parts
the model was allowed to draw, and once it draws all of them the field records
an opinion that nothing reads.

### 3.9 What remains variable

| Axis | Lives in | What it buys |
|---|---|---|
| Topology | `parts` | a snake is an 8-link chain; a cart has wheels; a crowd is one part |
| Proportion | `pivot`, `unit` | one body plan, child through giant |
| Contour | `path`, per part | species, build, mood |
| Extremity detail | ears, snout, tail, wings, hat | where recognition actually happens |
| Rest bearing | `restPose` | hunched, proud, wary |
| Cut-outs | `evenodd` subpaths | eye holes, wayang piercing |
| Attachments | parts on a parent's pivot | a lantern, a staff, a thing to be passed |
| Physicality | `look.idle`, `swing` | how alive something is while holding still |
| Description | `note` | what the thing is, in words that can be edited |
| Provenance | `from`, `import` | this heron is that heron, three plays ago |

Each is one op on one part, which is the granularity thesis holding at the
visual layer as well as the temporal one:

- *"Give her a longer snout"* → regenerate one contour and its note
- *"He needs a cloak"* → insert one part on a pivot
- *"That ear should be torn"* → one path, twelve units of geometry
- *"Use the heron from the other play"* → one `import`

### 3.10 Puppet

A cast member *is* a rig *is* a puppet — one noun ⟨D-B21⟩. There is no actor
layer wrapping a shared rig, because the library makes the sharing unnecessary:
a puppet is copied in and then diverges. Two identical guards cost one duplicated
part list — a dozen small objects — and buy back a whole layer of indirection,
override resolution and "which snout wins" questions.

```jsonc
{
  "id": "fox",
  "name": "The Fox",
  "note": "a lean fox — long snout, brush tail, low-slung and wary",
  "unit": 100,                            // puppet height, local units
  "cap": 5,                               // joint disc radius ⟨D-B17⟩
  "from": "lib.quadruped@3",              // provenance only, never resolved
  "restPose": { "head": -4, "leg_fl": 8, "leg_bl": -6 },
  "look": { "edge": "soft", "opacity": 1.0, "idle": 0.8 },
  "parts": [
    { "id": "torso",   "parent": null,    "pivot": [0, 0],   "z": 0,
      "note": "long low body, slight dip behind the shoulders", "path": "M…" },

    { "id": "head",    "parent": "torso", "pivot": [30, -8], "z": 1,
      "note": "narrow wedge, snout as long as the skull",
      "path": "M0,-9 Q14,-13 26,-4 L33,2 Q30,9 22,9 L4,10 Q-4,4 0,-9 Z" },

    { "id": "ear_l",   "parent": "head",  "pivot": [8, -10], "z": 2,
      "note": "tall pointed ear, slight forward lean",
      "path": "M0,0 L-3,-14 L7,-6 Z" },

    { "id": "ear_r",   "parent": "head",  "pivot": [18, -10], "z": 2,
      "mirrorOf": "ear_l" },

    { "id": "lantern", "parent": "head",  "pivot": [33, 2],  "z": 3,
      "swing": 0.4, "note": "square tin lantern, ring handle", "path": "M…" }
  ]
}
```

**Props are parts** ⟨D-B8⟩. The lantern is a part parented to the head, with a
`swing` for its pendulum. Passing it between puppets is a `remove` and an
`insert` in one transaction. No second concept.

**Mirrored parts.** `mirrorOf` authors a limb once and reflects it ⟨D-B13⟩ —
half the generation and guaranteed symmetry, with an override for the character
who has one torn ear.

**There are no joint limits** ⟨D-B2: cut⟩. They were in the model as a guard
against a language model authoring a dislocated elbow, and the guard is worth
less than it looks. Caps (§3.5) already prevent the *structural* failure — a
torn or popping joint. What limits prevent is only an *implausible* one, and in
silhouette an over-rotated joint reads as a loose puppet, not as a bug; real
shadow puppets swing well past anatomy. Meanwhile a wrong limit is a genuine
defect: it silently clamps a pose that was intended, and the puppet appears to
refuse a direction the user asked for. Reversible — if Milestone 0 shows
over-rotation is a live problem, `limits` comes back as an optional per-part
field and nothing else in the model changes.

### 3.11 The library

A store of reusable puppets, parts and backdrops. It seeds new casts, and it is
where the archetypes went.

**Copy, never reference.** A play embeds every puppet it uses in full. The
library is a place to copy *from*, not a runtime dependency. Three reasons, each
worth more than the duplication it costs:

- Versions are immutable. A library edit must not retroactively change a play
  that was already staged.
- A play stays one self-contained document — shareable by URL, forkable and
  exportable without resolving anything.
- Fork, remix and undo stay one rule rather than one rule plus a resolution
  order.

`from: "lib.quadruped@3"` records provenance, which is enough to answer "what
have I changed since" and to offer an explicit re-import. It is never followed
at render time.

| Entry | Is | Used for |
|---|---|---|
| puppet | a whole part tree | the starting point for a cast member |
| part | one part with its frame (§3.3) | a good hand, a brush tail, a lantern, a cart wheel |
| backdrop | a silhouette scene | ⟨D-A5⟩ |
| pose | joint angles by part name | transfers only where names match ⟨D-B20⟩ |

**Any play is a library.** `import` takes a source ref resolving either to a
curated entry or to a puppet inside any play by id. *"Use the fox from that other
play"* is the same operation as *"give me a fox"*, which makes remix work at the
puppet level and not only at the story level.

```jsonc
{ "op": "import", "src": "lib.quadruped@3", "as": "fox" }
{ "op": "import", "src": "pl_3ab1x/cast/heron", "as": "gull" }
{ "op": "import", "src": "lib.part.hand_open",
  "into": "keeper", "parent": "farm_l", "pivot": [0, 26] }
```

An imported part is rescaled by the ratio of the two puppets' `unit`.

**Part naming is a convention, not a schema** ⟨D-B18⟩: `torso`, `head`,
`arm_l` / `farm_l` / `hand_l`, `leg_fl` / `paw_fl`. Nothing enforces it, but
library parts and library poses transfer only between puppets that follow it,
which is enough pressure to keep it honest without a validator.

### 3.12 Pose and keyframe

A pose is joint angles plus a root placement. Poses are **sparse** ⟨D-B3⟩ —
unspecified joints inherit from the previous keyframe, so a component-level edit
touches one number.

```jsonc
{
  "joints": { "head": -12, "leg_fl": 34 },
  "root": { "x": 0.42, "y": 0.78, "scale": 1.0, "facing": -1, "plane": "mid" }
}
```

`x`/`y` are normalised to the stage box so the staging survives a resize.
`plane` is one of `far | mid | near` and drives blur, scale and contrast (§4.3).
Angles are degrees, wrapped to `[-180, 180]`, interpolated along the shortest
arc. There is no per-joint range (§3.10).

### 3.13 Beat

The atom of time. Duration is measured in **beats of a tempo, not seconds**
⟨D-B4: decided⟩ — integers the model can address ("beat 4"), no float drift in
generated output, and a grid a score can lock to if sound ever lands.

```jsonc
{
  "id": "b4",
  "label": "the lantern goes out",
  "length": 4,                            // in beats
  "tracks": {
    "fox":   [ { "at": 0, "ease": "inOut", "pose": {…} },
               { "at": 3, "ease": "out",   "pose": {…} } ],
    "crowd": [ { "at": 0, "ease": "inOut", "pose": {…} } ]
  },
  "fx": [ { "at": 0, "type": "lamp", "to": 0.35, "over": 2 },
          { "at": 2, "type": "sfx",  "cue": "wind" } ]
}
```

### 3.14 Play

```jsonc
{
  "id": "pl_7fk2m",
  "schemaVersion": 1,
  "version": 12,
  "title": "The Lighthouse Keeper's Debt",
  "meta": { "tone": "tragedy",
            "forkOf": "pl_3ab1x@7", "remixOf": "src.aesop.fox_and_crow" },
  "stage": { "tempo": 96, "backdrop": "cliff", "ratio": "16:9" },
  "cast": { "fox": { … }, "keeper": { … } },       // puppets, embedded in full
  "scenes": [ { "id": "s1", "title": "The lamp is lit", "beats": [ … ] } ]
}
```

**Acts are cut** ⟨D-B5: cut⟩. Three-act structure is a property of a story, not
of a document. "The second act" is a range of scenes, and every operation that
wanted an act — scope a regeneration, address a range, name a turning point —
works on scenes or on scene titles. The one real cost is that `stage` scoped to
"act two" becomes `stage` scoped to a scene range, which the agent resolves from
titles rather than reading off the tree.

A play is one self-contained document. Every puppet it uses is embedded in full
(§3.11), so it can be shared, forked or exported without resolving anything.

### 3.15 Selectors

One syntax addresses every altitude. This is the load-bearing piece of the whole
design — if selectors are not expressive, component-level editing is not
expressible.

```
s1                              a scene
s1/b4                           a beat
s1/b4:fox                       one puppet's track in that beat
s1/b4:fox@0                     a keyframe
s1/b4:fox@0.joints.arm_l        one joint angle
s1/b4:fox@*.root.x              that value across every keyframe in the track
cast.fox.parts.snout.path       one contour
cast.fox.parts.snout.note       what that contour is, in words
cast.fox.parts.ear_l.pivot      where an ear sits
cast.fox.parts.ear_l.pivot      where an ear sits
cast.fox.restPose.head          how she holds her head at rest
stage.tempo                     a global
```

`@*` matters more than it looks: *"her head tilts down through the whole final
beat"* is one op against `@*`, not a loop. And the `cast.…` rows are what make
the visual layer as addressable as the temporal one.

### 3.16 Edits

An **edit** is one change to the document. Edits are not part of a play and
never appear inside a stored one. They exist in exactly three places:

- as the payload an agent sends to an edit tool (§5.1),
- as the diff stored alongside each version (§6.4),
- as what the change feed pushes to browsers (§6.3).

Do not confuse them with **cues** — the `fx` entries inside a beat (§3.13). A
cue is something that happens during a performance: the lamp dips, the wind
sounds. An edit is something an author does to the script. Deliberately
different vocabulary, because an earlier draft used one word for both and it
was not clear which was which.

**Every edit is an address plus a change.** The address is a selector (§3.15).
The change is one of five kinds — and in practice the overwhelming majority are
`set`. The other four exist because there are exactly four things a `set` cannot
say.

| Kind | Shape | The gap it fills |
|---|---|---|
| `set` | `{op, sel, value}` | the default: write here, replacing what is there |
| `insert` | `{op, sel, value, after?}` | `set s1/beats[2]` cannot distinguish replace from insert |
| `remove` | `{op, sel}` | no value means "delete this" |
| `nudge` | `{op, sel, delta}` | a relative change would otherwise need a read first, and the read can be stale |
| `import` | `{op, src, as?, into?, parent?, pivot?}` | the value lives in another document, so without a server-side copy the caller must pull a whole subtree into context and paste it back |

**Scope does not replace edits.** `edit_scene(play_id, "s3", …)` (§5.2) makes
every selector inside relative to `s3` — it is a selector prefix and nothing
more. It narrows the address space; it says nothing about what kind of change to
make. Scope is *where you are working*, an edit is *what you are doing*.

**Why the set is generic.** These are structural mutations, not domain verbs. An
earlier draft had a `pose` edit — a performance-authoring convenience sitting in
a list of general document operations — and mixing those two kinds is what made
the set feel arbitrary. `set` replaces what it addresses, so one joint is
`set b4:fox@0.joints.head -12` and a whole pose is a `set` on the pose. The
performance/component distinction lives in the selector namespace and in the
tool surface, not here.

Also cut for the same reason: `move` (reparenting a part is `set …parent`, since
the tree is by reference; reordering beats is `remove` plus `insert` in one
transaction), and `fork` (`create_play` plus `import`). `revert` acts on version
history rather than the document, so if it survives it belongs in the tool
surface ⟨D-D14⟩.

**Transactions.** One edit-tool call carries one array of edits, applied
atomically and committed as one version. A rejected edit rejects the batch, and
the call returns which one failed and why.

## 4. Motion and rendering

The overview names animation quality as the primary risk. Three specific failure
modes and their mitigations:

**Popping limbs.** Cap discs (§3.5): overlapping parts merge into one
silhouette, so a rotating joint cannot tear open. Angles interpolate along the
shortest arc, so a limb never takes the long way between two poses. With joint
limits cut ⟨D-B2⟩ an over-rotated joint is possible — it reads as a loose
puppet rather than a broken one, and it is one op to fix.

**Dead holds.** A beat with a single keyframe is a statue for four beats, and a
statue reads as a crash. Fix: an always-on **procedural idle layer** ⟨D-C3⟩ —
low-amplitude breathing on the torso, a slow sway phase-offset per puppet, added
on top of keyframed values rather than replacing them. Per-puppet amplitude (`look.idle`),
authorable ("the keeper is stiller than the others"), never zero by default.
This is the highest quality-per-line-of-code item in the project.

**Robotic transitions.** Default easing is `inOut`; child joints inherit a small
lag from their parent (2–3 frames of follow-through), and props with `swing`
run a cheap pendulum. None of this is authored — it falls out of the rig.

### 4.1 Playback clock

`rAF` loop; wall time → beat position via `stage.tempo`. Playback is
**deterministic given (play, version, time)** ⟨D-C7⟩: the idle layer is seeded
from puppet id, not `Math.random()`. This is what makes the pre-rendered landing
play checkable into the repo as JSON rather than shipped as a video file.

### 4.2 Render target

SVG DOM ⟨D-C1⟩. Cast is small (a handful of puppets × ~12 parts), so the node
count is trivial, and the DOM buys two things worth more than raw perf: free
hit-testing — **click a limb, and the chat input pre-fills with its selector**,
which teaches the granularity spectrum without a tutorial — and inspectability
while debugging motion.

### 4.3 The look

Lit scrim, dark figures. The stage is a warm radial gradient; puppets are near-
black fills. Depth is the cheap trick that makes it read as a real lamp:

| plane | scale | blur | opacity |
|---|---|---|---|
| `far` | 0.82 | 2.4px | 0.72 |
| `mid` | 1.00 | 0.9px | 0.88 |
| `near` | 1.15 | 0.2px | 1.00 |

Open aesthetic choices — cut-out interior detail, visible control rods, a
proscenium and curtain — are ⟨D-A2, D-A3, D-A8⟩.

### 4.4 Page design ⟨D-A15⟩

The stage is the page. Everything else is chrome, and chrome should be close to
absent: a title, a hairline scrubber, one button in the corner.

**Explicitly avoid the house style of generated web pages.** The tells, all of
which should be absent:

- indigo/violet→pink gradients; gradient text
- glassmorphism — frosted cards, heavy backdrop blur
- rounded-2xl cards with soft shadows floating on a light grey field
- a centred hero: big headline, subhead, filled primary button beside a ghost
  outline one
- emoji or circled line-icons as section markers; pill-shaped tags and badges
- Tailwind's default slate/zinc plus indigo palette; Inter at default weights
- animated gradient blobs behind the content
- dark mode as the same layout with inverted greys and the same violet accent

What to do instead follows from the subject — this is a theatre, not a SaaS
product:

- The lamp is the only gradient on the page. Interface elements are flat.
- Warm neutrals: bone, ochre, oxblood, and the near-black of the puppets. No
  slate, no indigo.
- Typography with a point of view. A playbill has letterpress ancestry — a
  transitional serif, or a condensed grotesque with real character, not the
  default system stack.
- Texture rather than blur: paper grain, a vignette, the weave of the scrim.
- Physical references rather than material-design ones: a proscenium edge, a
  scrubber that reads as a lighting cue strip.
- Type set at a size and measure that suggests print, not a dashboard.

The test: with the puppets removed, a screenshot should still look like it came
from somewhere specific.

### 4.5 The chat affordance ⟨D-A16⟩

One button, lower corner. It pulses gently until first clicked, then never
again — the state lives in `localStorage`, so a reviewer arriving in a fresh
browser sees the invitation once and a returning user is left alone.

This is the only onboarding in the product. With opening prompts and bundled
remix sources both cut (§7), nothing else tells a visitor what is possible. The
stage manager's habit of answering a request and offering one thing deeper (§1)
now carries the entire teaching burden, which makes it a feature that needs
writing rather than a matter of tone.

## 5. Tool surface

**The server never calls a model.** The caller — a Claude Code session, or later
the embedded chat's own loop — does all generation. The server is a document
store with domain-aware edits, a renderer, and a push channel.

That removes three things from the earlier design. The `stage` verb is gone: it
asked the server to generate a play on the caller's behalf, which makes no sense
once the caller is itself a model. The two-tier generation design ⟨D-D2⟩ is moot
for the same reason. And the server-side repair loop becomes an error return the
caller reads and retries against.

### 5.1 Six tools

| Tool | Signature | Scope |
|---|---|---|
| `create_play` | `(title?) → {play_id, url}` | — |
| `list_plays` | `(query?, mine?)` | — ⟨D-D12⟩ |
| `read_play` | `(play_id, sel?, depth?, include_paths?)` | any selector |
| `edit_play` | `(play_id, edits[])` | the play: title, tempo, backdrop, `mode`, the scene list |
| `edit_scene` | `(play_id, scene_id, edits[])` | one scene: beats, tracks, keyframes, poses, cues |
| `edit_cast` | `(play_id, puppet_id?, edits[])` | puppets: parts, contours, notes, rest bearing, imports |

Every edit tool returns `{version, rejected[]}`. No playback tools ⟨D-D15⟩ — the
browser loops the latest state on its own (§6.3), so there is nothing for an
agent to drive. No fork tool: `create_play` plus `import` covers it.

### 5.2 Why the edit tools are scoped ⟨D-D16⟩

One generic `edit_play(edits[])` is more elegant and worse in four concrete ways.

- **Descriptions are where a model learns the domain.** What an agent needs to
  know to draw a puppet — the part-local frame, canonical +Y rest, the path
  contract, that a contour and its note are written together — is nearly
  disjoint from what it needs to know to write a scene. One tool means one
  description that is the union of both: long, and diluted at both ends.
- **Selectors get shorter and safer.** Inside `edit_scene(play_id, "s3")` an op
  addresses `b4:fox@*.joints.head`, not `s3/b4:fox@*.joints.head`. Fewer tokens
  and fewer chances to mistype a long path.
- **Blast radius.** `edit_cast` cannot touch the story; `edit_scene` cannot
  redraw a puppet. That matters more now that any user can edit an open play
  (§6.2).
- **Concurrency granularity.** Two agents working on different scenes stop
  conflicting: the optimistic version check ⟨D-E5⟩ can be per-scope rather than
  per-document.

The split also puts the performance/component distinction where it belongs.
§3.16 deliberately kept it *out* of the edit vocabulary, so edits stay generic
structural mutations. It reappears here, in the layer that actually talks to the
model.

This exceeds the overview's "~5 verbs" by one. That target was a proxy for
keeping the agent loop cheap, and the real cost driver is description quality
rather than tool count — six sharply-scoped tools are easier to get right than
five overloaded ones.

### 5.3 Reads are cheap by default

`read_play` returns ids, titles, beat labels and the `note` on every puppet and
part — and no path data. A whole cast comes back as a paragraph of prose.
Geometry is opt-in, per selector:

```
read_play(play_id, sel: "cast.fox", include_paths: ["ear_l", "ear_r"])
```

This is the payoff from §3.6. Contours are the largest thing in the document and
the least useful to hold in context; notes are the smallest and the most useful.
An agent editing a story never loads a contour. An agent redrawing one ear loads
exactly two. ⟨D-D6⟩ fixes the depth levels.

`read_play` also returns **derived geometry**: each part's computed bounding box
and its position at rest, plus the puppet's overall extent. These are free — the
server already computes extents because `box` is not an authored field (§3.3) —
and they are what let an agent check proportion without seeing anything. *"The
head's box is 34×26 and the torso's is 64×30"* is enough to catch a head bigger
than its body, or an ear floating forty units off the skull.

### 5.4 `render`: what it would do, and why it is cut

`render` would return an image, so an agent could look at what it drew.

⟨D-B14⟩ previously called this the only check on proportion in the system, and
therefore not optional. That was wrong in one respect: proportion is largely
checkable *numerically*, from the derived extents above, at no cost. What pixels
add is **legibility** — whether a silhouette reads as a fox or as a blob — and
nothing cheap catches that.

Against building it now:

- It needs server-side rasterisation of SVG — a headless browser or a native
  library. Plausibly the heaviest infrastructure item in the project, for a
  check that runs a handful of times per play.
- **The user is already looking.** The browser view plays the play live, and a
  puppet that reads wrong is one op from fixed. Spending an expensive automated
  pass to catch what the user will catch anyway, and enjoy catching, argues
  against itself. This is the same reasoning that cut joint limits and most of
  the validation table (§3.7).

For it:

- A headless MCP session authors blind. The agent has no idea what it made
  unless the user narrates it — and that session is the primary development path
  from Milestone 2.

**Cut from the initial tool surface, kept as a stretch item beside sound.** Until
then the quality loop is derived extents plus a human watching a URL, which is
the product anyway. ⟨D-D13⟩ still applies if it lands, and the answer is still
that a still frame cannot show a dead hold.

### 5.5 A request, end to end

*"Her head tilts down through the whole last beat."*

1. The agent reads what it needs, cheaply — labels and structure, no geometry:

```
read_play(play_id, sel: "s5", depth: "beat")
→ s5 "The lamp goes out"
    b1 "she waits"       tracks: heron, keeper
    b2 "the light fails" tracks: heron, keeper
```

2. It sends one edit:

```
edit_scene(play_id, "s5", [
  { op: "nudge", sel: "b2:heron@*.joints.head", delta: -18 }
])
```

`@*` applies it to every keyframe in that track, so *"through the whole beat"*
is one edit rather than a loop (§3.15).

3. The server resolves the selector, applies it, commits version 13, returns
   `{ version: 13, rejected: [] }`.

4. The same edit goes out over SSE. Every browser watching `/p/:id` absorbs it at
   immediately, the user's included, with no reload.

5. The agent replies in character and offers one thing deeper.

Nothing was regenerated. The play is tens of kilobytes of JSON and the request
moved one number in it.

Staging a whole play is the identical mechanism at a different volume:
`create_play`, then an `edit_cast` per puppet, then an `edit_scene` per scene.
Each call commits a version and each version is pushed — which is why the stage
assembles while the user watches. That is not a feature; it is what happens.

### 5.6 Progressive staging comes free

⟨D-D7⟩ wanted the stage to assemble while a play is generated. With the caller
emitting edits as it works and the browser subscribed to the change feed (§6.3),
that now happens by itself — each `edit_play` call lands and the viewer sees it.
No streaming protocol, no special mechanism. The only thing left is prompt
guidance: an agent that writes a play in six `edit_play` calls is much better to
watch than one that writes it in a single call.

## 6. Architecture

```
browser ──GET /p/:id ──────────► server ───► SQLite  (plays, versions)
   ▲                               ▲  │
   └── SSE /p/:id/events ──────────┘  └────► renderer (frames, stills)
                                      ▲
Claude Code / claude.ai ───MCP────────┤
embedded chat (Milestone 5) ──────────┘
```

### 6.1 Inference

Through Milestone 4 the server calls no model. The caller — a Claude Code
session — does every generation, and the server is a document store with a
renderer and a push channel. That keeps API keys, inference cost, generation
rate limits and spend controls out of most of the build.

**The embedded chat (Milestone 5) is the exception**, and the one place the
server needs inference. **TODO** ⟨D-D17⟩: use something off the shelf rather than
hand-rolling an agent loop — the tools are already an MCP server, so anything
that speaks MCP and streams tool calls is a candidate. What arrives with it,
scoped to the chat only and not to MCP callers:

- a provider API key held server-side
- per-IP session limits and a per-session message cap
- a global daily spend ceiling and a kill switch, with a written failure state
  ("the theatre is dark tonight") rather than an error
- a cheap model by default

These matter more than they would have: the chat is anonymous (§6.2), so this is
an unauthenticated endpoint that spends money.

MCP users keep paying for their own inference, which is most of the traffic.

### 6.2 Identity and access

Three kinds of principal ⟨D-E8: decided⟩.

| Principal | Comes from | Can |
|---|---|---|
| `public` | nothing — the in-app chat acts as this | create and edit **open** plays only |
| a user | a rate-limited signup form | create open or closed plays; edit any open play, and their own closed ones |
| the author | seeded, `admin` | the above, plus set `featured` (§7) |

- **The web needs no login.** The in-app chat operates as `public`, so a
  reviewer types and it works. `public` has no credentials and cannot be logged
  in as; it is an attribution row, not an account.
- **`public` cannot close a play.** Everything the chat makes stays
  world-editable. That is the sandbox boundary: nothing anonymous can lock
  anyone out, and nothing anonymous becomes un-editable.
- **Signup exists to get MCP credentials.** The page is really "connect your
  agent": it mints a credential and shows the config block to paste. Rate
  limited per IP, capped in total, no email — and therefore no verification
  flow and no mail to send.
- A **play** has a creator and a `mode`: `open` or `closed`. Anyone may read any
  play ⟨D-E10⟩; open plays are editable by any principal, closed ones only by
  their creator. `mode` is an ordinary field, changed with `edit_play`, refused
  by the server from anyone but the creator ⟨D-E12⟩.

**Why this beats shared seeded credentials.** The reviewer's path has zero
friction — no credential to type, nothing to read first. MCP users self-serve
rather than being provisioned by hand. And attribution becomes real for the
identified half of the traffic, which is the half that edits over time.

**What it costs, and the mitigations.**

- *Signup is a public write endpoint.* Rate limit per IP, cap total accounts,
  cap plays per account and document size ⟨D-D11⟩. An account is cheap and
  disposable by design; nothing of value sits behind one.
- *Anonymous chat spends the project's money.* The sharper risk, and a new one —
  the chat used to sit behind a login. Caps and a kill switch in §6.1.
- *`public` plays are permanently world-editable*, since `revert` is out of
  scope ⟨D-D14⟩. Tolerable for anonymous work, which is exactly why the featured
  set and the author's own demo plays are `closed` and owned by the author (§7).

**MCP auth** ⟨D-E6⟩: OAuth with dynamic client registration if it proves cheap —
it is what the MCP spec expects and what Claude Code handles natively, and the
signup form becomes the account-creation step inside that flow. Otherwise HTTP
Basic with the signup credentials, supplied through the client's env. The form
is not wasted work either way. Timebox OAuth to an afternoon.

### 6.3 The browser view

`/p/:id` autoplays the play's latest version once on load and holds on the
final frame ⟨D-D18⟩. It does not loop — an endlessly repeating stage reads as a
screensaver, and the landing page gets its "something is happening" from
autoplay alone.

A play with no scenes shows an **empty lit scrim** — the lamp, the texture, the
proscenium, and nothing on it ⟨D-A17⟩. This is the first frame anyone sees after
`create_play`, before an agent has written a line, so it is a designed state
rather than a blank page.

Minimal transport controls ⟨D-D15⟩: a hairline scrubber and play/pause, styled
to stay out of the way until the pointer is near them. Viewer controls only —
there is still no playback *tool*, because an agent has nothing to drive.

Updates arrive over SSE as edit deltas ⟨D-E3, D-E4⟩ and apply immediately: in
playback the change takes effect from the current frame onward; while paused or
scrubbed, the current frame re-renders in place. If playback has ended and an
edit extends the play, playback resumes into the new material — which is what
makes the stage assemble while someone watches (§5.6).

Push goes to every viewer, not only to editors ⟨D-E11⟩: reads are public, it is
the same stream, and a link that changes while someone is watching it is most of
the appeal of sharing one.

### 6.4 Storage

SQLite: `plays(id, creator, mode, featured, head_version)` +
`versions(play_id, n, doc, edits, author)` ⟨D-E2⟩. Append-only. History, undo
and provenance all come out of one table. Concurrency is optimistic ⟨D-E5⟩ — an
edit batch carries the version it was computed against, and a stale batch is
rejected and retried against head.

### 6.5 One tool module, wrapped twice

Tools are plain functions over the store. The MCP server wraps them for remote
transport; the embedded chat wraps the same functions in-process. A tool cannot
exist in one client and not the other, which is the whole reason the two clients
cannot drift.

### 6.6 Stack ⟨D-E1: decided⟩

TypeScript everywhere, on Bun. One language across the store, the renderer, the
MCP server and the chat, so the schema, the selector grammar and the edit
vocabulary are each written once. Bun's built-in SQLite driver removes a
dependency, and the official MCP SDK is TypeScript.

Deploy target is open ⟨D-E7⟩, with one constraint that rules out most of the
easy answers: SSE needs a long-lived process, so this wants a container or a
platform that runs one, not a serverless function.

## 7. Bundled content

Deliberately thin. This is a creative tool and the user should do some work.

- **Landing page**: picks a play at random and shows it read-only — no SSE, no
  chat, no API call on the critical path ⟨D-E13⟩. Real content rather than a
  fixture, so the front page improves as the library does.
  Drawn from a `featured` set, flagged only by the author account ⟨D-E13⟩ — an
  unfiltered random pick would put a world-editable play on the front page, and
  with `revert` out of scope that damage is permanent.
- **The author's demo plays are `closed`** and owned by the author account, so a
  reviewer cannot alter what is being demonstrated mid-review.
- **Starter library**: minimal — a few puppets and parts, enough that a first
  play can begin from an import rather than from nothing.
- **No opening prompts** ⟨D-A12: cut⟩. Explanation belongs in the document or
  video that accompanies the demo, not in the product.
- **No bundled remix sources** ⟨D-A11: cut⟩. MCP users connect whatever sources
  they like to their own agent, which is a better answer than a curated list.
  The embedded chat does without.

## 8. Milestones

| # | Deliverable | Gate |
|---|---|---|
| 0 | Renderer, part tree, beat player. A hand-authored puppet and play as JSON. No agent, no server. | **Motion go/no-go.** If a hand-authored play does not look good, nothing downstream saves it. |
| 1 | Document store, selectors, the five kinds of edit, SQLite versions | a scripted op edits one joint and it looks right |
| 2 | MCP server: six tools, tokens, open/closed | Claude Code stages a play end to end |
| 3 | Browser view at `/p/:id`, SSE push, autoplay, scrubber and play/pause | edit from Claude Code, watch the stage change |
| 4 | Library, imports, starter puppets | "use the heron from that play" works |
| 5 | Embedded chat (off-the-shelf loop ⟨D-D17⟩ + spend caps), stage-manager persona, landing page | the sixty seconds in §1 |
| — | Stretch: `render`, sound, video export | |

**Why MCP before chat.** Claude Code is already a working, high-quality client.
Building the MCP server first means a real agent drives the stage from Milestone
2 with no UI work at all, and the data model, the edits and the notes get iterated
against real agent behaviour far earlier than they otherwise would. The embedded
chat is then the same six tools behind a text box.

**The risk this creates**, worth naming because it inverts the overview's own
scope guard: the reviewer's default path is now the *last* thing built, so if
time runs short, what ships is the thing a reviewer cannot easily use. Three
mitigations:

- The browser view (Milestone 3) is separable from the chat. A reviewer can
  *watch* a play at a URL long before anyone can type at one, and the landing
  play covers the first impression regardless.
- The stage-manager persona can be drafted and tested as a system prompt inside
  Claude Code from Milestone 2, so it is not untested when the chat appears.
- **"Mechanical" is true of the loop and false of the showmanship.** A model
  plus six tools plus a system prompt is genuinely about a day. The "what
  changed" chip ⟨D-A10⟩, the in-fiction framing, and the feel of watching a
  stage assemble are not, and they carry most of the demo's weight. Budget them
  separately from the loop, or they will be discovered late.

## 9. Non-goals

Not 3D. No asset pipeline or image generation. No model on the server before
the embedded chat (§6.1). No private plays, no teams, no per-user permissions
beyond open/closed. No login on the web. No password reset, no email, no verification. No opening
prompts and no bundled remix sources (§7). No playback controls. No sound in the initial build ⟨D-A7⟩. No TTS
⟨D-A6⟩. No video export ⟨D-C8⟩. No open-ended remix input. No mobile-first
layout. Not a general animation editor — every capability exists to serve the
granularity thesis, and anything that does not is cut.

---

# Part II — Decision register

Legend: **★** = the current choice. **DECIDED** / **CUT** are settled; the rest are open.

## A. Creative and aesthetic

| # | Decision | Options | Note |
|---|---|---|---|
| A1 | **Where the line falls between generated and fixed** — DECIDED | fixed hand-drawn library / archetype topology + generated contours / **★model authors topology and contour, validated, seeded from a library** | Settled in favour of the open end (§3.1). The composition risk is contained by drawing each contour in an isolated local frame and by making composition a checkable part tree rather than a canvas. What is genuinely given up is a structural guarantee of proportion; B14 is now the thing standing in for it. |
| A15 | **Page design** | **★**a specific visual point of view (§4.4) / a default component library | The explicit brief is to avoid the recognisable house style of generated web pages. §4.4 lists what that means concretely. |
| A17 | Empty play | **★**an empty lit scrim / a blank page / placeholder copy | The first frame after `create_play`, seen before an agent writes anything. |
| A16 | Chat affordance | **★**one corner button, pulses until first clicked, `localStorage` | The only onboarding left after A11 and A12 were cut. |
| A2 | Interior detail | **★**pure silhouette / wayang-style perforated cut-outs / silhouette + colored gels | Perforations are gorgeous and are a real generator cost. |
| A3 | Visible control rods | **★**yes, thin rods from below / no / toggle | Rods read as "puppet" instantly and give the eye something to forgive imperfect joints. Cheap. |
| A4 | Depth planes | **★**3 discrete / continuous z / flat | 3 is authorable in language ("upstage"), continuous is not. |
| A5 | Backdrops | **★**small silhouette scenery library / parametric like rigs / abstract gradients only | Library is fine here — backdrops don't need to be open-ended. |
| A6 | Dialogue — **DECIDED: none** | **★**wordless / caption supertitles / speech bubbles / TTS | Plays are wordless. `line` is out of the beat schema. Scene titles and beat labels stay as authoring labels and are never staged. |
| A7 | Sound — **STRETCH** | **★**none in the initial build / ambient bed + foley cues on the beat grid, if time | Cut from scope. High perceived quality for low effort, so it is the first stretch goal to reach for. The landing play is silent until it lands. |
| A8 | Stage framing | **★**proscenium + curtain + wings / bare scrim / letterboxed frame only | Curtain also covers generation latency (§D7). |
| A9 | Stage-manager voice | length, register, in-character on errors | Write the system prompt as a character sheet, not a spec. Needs a real pass, not a default. |
| A10 | Does it narrate its edits? | in-fiction only / **★**in-fiction reply + a structured "what changed" chip with undo | The chip is direct evidence for Theme 2's "real control over iteration". Losing it to purity is a bad trade. |
| A11 | Remix sources — **CUT** | **★**none bundled; MCP users bring their own | Better than a curated list, and it removes the whole copyright surface. |
| A12 | Opening prompts — **CUT** | **★**none | This is a creative tool and the user should do some work. Explanation moves to the accompanying document or video. Raises the stakes on A9 and A10, which are now the only onboarding. |
| A13 | Name — **DECIDED: puppet** | **★**"puppet-theater" / keep `pupper` / something else | `pupper` was a typo, not a joke. Everything the code and spec say is "puppet", so the name follows: package name, env prefix `PUPPET_`, MCP server name and the signup pages all read `puppet-theater`. The checkout directory and the GitHub remote still say `pupper-theater` and are renamed out of band. |
| A14 | Failure aesthetics | error text / **★**in-fiction ("the fox won't bend that way") / silent clamp | Clamping silently is worse than admitting it — the user should learn the puppet has limits. |

## B. Data model

| # | Decision | Options | Note |
|---|---|---|---|
| B1 | Joint degrees of freedom | **★**rotation only + root translate/scale/flip / full affine per part | Affine is more expressive and much easier to make look broken. Rotation-only *is* the puppet metaphor. |
| B2 | Joint limits — **CUT** | enforced / advisory / **★**none (§3.8) | Caps handle the structural failure; limits only ever prevented an implausible pose, and a wrong limit silently refuses a pose the user asked for. Returns as an optional per-part field if Milestone 0 shows over-rotation is real. |
| B3 | Pose completeness | **★**sparse, inherit forward / complete every keyframe | Sparse makes component edits one-number edits. |
| B4 | Timing — **DECIDED** | **★**beat grid + tempo / seconds / hybrid | Integers are addressable in language. Seconds invite drift and float noise in generated output. |
| B5 | Acts — **CUT** | real structural level / cosmetic label / **★**scenes only (§3.12) | Act structure is a property of the story, expressible in scene titles. The cost is that `stage` scoped to "act two" resolves a scene range from titles. |
| B6 | ID stability | **★**stable string IDs, never index-addressed | Non-negotiable given reordering edits, but worth writing down. |
| B7 | Where blocking lives | **★**in `pose.root` / separate blocking track | A separate track is cleaner conceptually and doubles what a staging edit must touch. |
| B8 | Props — **RESOLVED** | **★**props are ordinary parts (§3.8) / a separate concept | Passing a prop between puppets is `remove` + `insert` in one transaction. One less noun. |
| B9 | Crowds | one puppet with a multi-figure contour / **★**N puppets + a group handle / instanced puppet with a count | "Move the crowd upstage" is in the overview's own example table, so this is not hypothetical. A multi-figure contour is now cheap, since the model draws — worth reconsidering. |
| B10 | Schema versioning | ignore / **★**`schemaVersion` from day one | Costs one field. Shareable URLs make it matter. |
| B11 | **Path grammar** — DECIDED | free `d`, stored as-is / **★**author anything, normalise to absolute `M L Q C Z` on write / polyline + server smoothing | No smoothing: the model's curve is the curve. But the grammar restriction belongs on the *stored* form, not the authored one — arcs and relative commands are converted, never refused, which removes a whole rejection class for a 20-line arc-to-bézier function. |
| B12 | Which parts are model-authored — **RESOLVED** | **★**all of them | The `role` field is cut with it. What survives is prompt guidance (§3.6), not schema. |
| B13 | Mirrored parts | **★**`mirrorOf`, overridable per part / always independent | Halves generation and guarantees symmetry; the override is what allows one torn ear. |
| B14 | **Vision repair pass** — now core | **★**one render-and-look pass at cast time / none / on every path edit | Promoted by the archetype cut: with no fixed boxes, this is the only thing checking proportion. Affordable once per cast, not per edit. The most likely thing to slip if time runs short, and the most expensive to lose. |
| B15 | Style coherence across parts | **★**one call authoring all contours together + an explicit contour directive / independent per-part calls | Parts drawn in separate calls drift in line quality and read as a collage. |
| B16 | Rest bearing | **★**angles in `restPose`, parts drawn in canonical +Y rest / baked into the contours | Keeping rest as data means "he stands prouder" is an op, not a redraw. |
| B17 | `cap` radius and `minWidth` | numeric, per puppet | Two small numbers that decide whether limbs shimmer or seams open. Tune at Milestone 0 against a hand-authored puppet. |
| B18 | Part naming | **★**convention only, unenforced / a validated vocabulary / free | Library parts and library poses transfer only between puppets that follow it. Enforcing it would block the snake with eight links and the thing with nine legs. |
| B19 | Library scope | **★**curated read-only starter set + any play as a source / user-saveable entries / curated only | "Save this puppet to the library" needs an owner, and there are no accounts (E8). Any-play-as-source gets most of the value with none of that. |
| B20 | Library poses | **★**defer / ship with the starter set | A pose only transfers where part names match (B18). Cheap to add later, and it is the closest thing left to what archetypes gave D3. |
| B21 | Puppet as one noun — **RESOLVED** | **★**puppet = rig = cast member (§3.8) / rig template + actor instance | The library replaced the reason for the split. Cost is a duplicated part list for two identical guards; benefit is no override-resolution layer. |
| B22 | Named sockets — **CUT** | per-part `socket` / a puppet-level `sockets` map / **★**neither (§3.2) | A child's `pivot` already names the attachment point, in the same coordinates. Returns as pure annotation if traces show the model attaching things in the wrong place. |
| B23 | **Labels and notes** — core | **★**`note` on every part and puppet, written with the contour / ids only / a cached render thumbnail | Path data is opaque to the model that revisits it. One field carries later edits, a cheap `look`, style coherence, speakable diffs — and, decisively, continuity across agent sessions and clients, which nothing else in the document provides. |
| B24 | Cached render per puppet | **★**defer / a thumbnail stored beside the puppet | Strictly stronger than a note for later edits, and it needs storage, invalidation and the vision pass (B14) to already exist. |

## C. Motion and rendering

| # | Decision | Options | Note |
|---|---|---|---|
| C1 | Render target | **★**SVG DOM / Canvas2D / WebGL | SVG buys click-a-limb addressing, which is a feature, not just a convenience. |
| C2 | Easing vocabulary | which set, and is it per-keyframe | Keep it to 4–5 named curves the model can pick by name. |
| C3 | Procedural layers | none / **★**breath + sway + follow-through, additive, per-actor amplitude / full physics | Biggest quality-per-effort item in the project. |
| C4 | Single-keyframe beats | dead hold / **★**hold + idle layer / auto-generate a subtle counterpose | |
| C5 | Playback clock | **★**rAF + tempo mapping / fixed timestep | |
| C6 | Beat and scene transitions | hard cut / **★**lamp dip between scenes, cut between beats / crossfade | |
| C7 | Deterministic playback | **★**yes, seeded / no | Required to ship the landing play as JSON instead of video. |
| C8 | Video/GIF export | **★**no (non-goal) / GIF / WebM | Real sharing value, real cost. Only if everything else lands. |

## D. Agent and tools

| # | Decision | Options | Note |
|---|---|---|---|
| D1 | Tool surface | **★**six tools, edits scoped by altitude (§5.1) / one polymorphic `patch` / many fine-grained verbs | Tool descriptions are where a model learns what is possible, so typed-and-few beats elegant-and-one. |
| D2 | Generation strategy — **MOOT** | — | The caller generates; there is no server-side model, so there is no two-tier design to choose. What survives is prompt guidance: an agent that writes a play in several `edit_play` calls is more watchable than one that writes it in a single call (§5.4). |
| D3 | Named-pose vocabulary | **★**defer / a per-puppet pose library / expanded server-side | Weaker now: there are no archetypes to hang a shared vocabulary on, and B20 covers most of what is left. |
| D4 | Relative edits | **★**`nudge` first-class / read-then-`set` | §3.16. |
| D5 | Validation failure | **★**reject the batch, return what failed and why, let the caller retry / server-side repair | The caller is a model and can read an error. |
| D6 | Context strategy | **★**labels by default, geometry opt-in per selector (§5.2) / always the full document | The largest thing in the document is the least useful to hold in context. |
| D7 | Progressive staging — **FREE** | — | Falls out of edits landing incrementally on a live view (§5.5); with autoplay-once, playback resumes into material added after it ended. |
| D10 | Ambiguity | ask a clarifying question / **★**pick, and offer the alternative | Now a client-prompt concern rather than a server-design one, but still the difference between a demo that flows and one that stalls. |
| D11 | Cost and abuse controls | **★**storage and document-size limits through Milestone 4; spend caps and a kill switch arrive with the embedded chat | MCP callers pay for their own inference; only the chat spends the project's money (§6.1). |
| D12 | Play discovery | **★**`list_plays` with a query / URLs only, pasted by the user / a browsable gallery | Importing from another play needs a way to find one. A gallery is also the landing page's second act. |
| D13 | What `render` returns — **DEFERRED** (§5.4) | single frame / **★**contact sheet across a beat / animated GIF | A still cannot show a dead hold or a pop, which is the actual risk (§4). |
| D14 | `revert` — **OUT OF SCOPE** | **★**none | Version history still records every edit, so it can be added later. Consequence: an edit to an open play is permanent, which is why the featured set and the author's own demo plays must be protected (§7). |
| D17 | **Embedded chat loop** — TODO | **★**something off the shelf that speaks MCP and streams tool calls / hand-rolled | The tools are already an MCP server, so the chat should be a client of them rather than a second integration. |
| D16 | **Edit scoping** | **★**scoped by altitude: play / scene / cast (§5.2) / one generic `edit_play` / scoping as a parameter | Buys sharp per-tool descriptions, shorter selectors, a blast radius, and per-scope concurrency. |
| D18 | Playback mode — **DECIDED** | **★**autoplay once, hold on the final frame / continuous loop | A loop reads as a screensaver and makes "when did this change" hard to see. Autoplay still gives the landing page motion on arrival. |
| D15 | Playback control — **SPLIT** | **★**no agent tools; a hairline scrubber and play/pause in the viewer | An agent has nothing to drive, but a human watching wants to stop it. Viewer chrome, not tool surface. |

## E. Architecture

| # | Decision | Options | Note |
|---|---|---|---|
| E1 | Stack — **DECIDED** | **★**TypeScript everywhere on Bun / Python server + TS client / Node | Schema, selector grammar and edit vocabulary each written once. Built-in SQLite; the MCP SDK is TypeScript. |
| E2 | Storage | **★**SQLite, append-only versions / Postgres / files | History, undo and provenance from one table. |
| E3 | Push transport | **★**SSE / WebSocket / polling | Writes are tool calls; push is one-way. |
| E4 | Change events | full document / **★**edit deltas | Deltas let a running view absorb a change without a reload. |
| E5 | Concurrency | **★**optimistic version check / last-write-wins / locking | Two agents on one open play is now an ordinary case, not an edge one. |
| E6 | MCP auth | **★**OAuth + DCR if cheap, else HTTP Basic with signup credentials in the client env | The signup form serves both: standalone, or as the account-creation step inside the OAuth flow. Timebox OAuth to an afternoon. |
| E7 | Hosting | a container platform (Fly, Railway, a VPS) / serverless | SSE needs a long-lived process, which rules out most serverless. Pick something boring that survives the review window. |
| E8 | Identity — **DECIDED** | **★**`public` for the chat + rate-limited signup for MCP + a seeded author (§6.2) / shared seeded credentials / capability URLs | Zero friction on the reviewer path, self-serve for MCP, real attribution where it matters. |
| E9 | Landing play production | **★**checked-in JSON + deterministic player / pre-rendered video | Depends on C7. Silent now (A7). |
| E10 | Read visibility | **★**every play is public / private by default / a per-play flag | Simple, and it makes import-from-anywhere work. Must be said plainly on the landing page. |
| E11 | Who receives push | **★**every viewer / editors only | Restricting saves connection load, which is not a real constraint at this scale. |
| E13 | Landing page selection — **DECIDED** | **★**random from a `featured` set, flagged by the author account / random from all plays / a fixed play | Open plays are world-editable and `revert` is out of scope, so an unfiltered pick puts permanent vandalism on the front page. |
| E12 | Where `mode` is set | **★**a field on the play, via `edit_play`, creator-only / a separate tool | Folding it in keeps the surface at five. The counter-argument is that authorization changes do not belong in a content op stream — weak here, since it is one bit on the creator's own play and it shows up in the version diff. |

## F. Scope

| # | Decision | Options | Note |
|---|---|---|---|
| F1 | First cut if time runs short — **CHANGED** | sound (already stretch) / library imports / **★**the persona and the chip, not the chat itself | The order inverted with MCP first, so what is at risk is now the reviewer's own path rather than the architecture story. §8 lists the mitigations. |
| F2 | Milestone 0 gate | who judges "good enough", and what happens on a no-go | A gate with no answer to "and then what" is not a gate. |
| F3 | The evaluated path | the exact prompts and clicks a reviewer performs | Written down and rehearsed, not improvised. |

## Settled

Beat grid ⟨B4⟩. Wordless ⟨A6⟩. No `revert` ⟨D14⟩. Empty lit scrim ⟨A17⟩.
TypeScript on Bun ⟨E1⟩. `public` chat plus rate-limited signup ⟨E8⟩. Six tools,
edits scoped by altitude ⟨D1, D16⟩. Five kinds of edit (§3.16). No `render` in
the initial surface ⟨B14⟩. No opening prompts, no bundled remix sources ⟨A11,
A12⟩. Sound is a stretch goal ⟨A7⟩.

## Still open, decidable at the keyboard

Everything in C beyond what §4 states. A2 (cut-outs), A3 (rods), A8 (proscenium), A9 (the persona —
work rather than a decision, and now load-bearing), B9 (crowds), B18–B20 (naming
and library poses), D3 (pose vocabulary), D12 (discovery), E7 (deploy target).
