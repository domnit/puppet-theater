// The `description` string of each tool. These are the model's only manual —
// the domain (the part-local frame, canonical rest, the path contract,
// note-with-contour, where rods go, sparse poses, selectors) is taught here or
// nowhere. Keep them accurate: if the implementation diverges, fix the
// implementation.

export const CREATE_PLAY = `Create a new, empty play and return its id and URL. Give it a \`title\` now — a
short name for what it will show — rather than leaving it untitled. The stage at
that URL shows a lit, empty scrim until you add a cast and scenes; every later edit appears
there live, so build in several calls rather than one — cast first (edit_cast),
then a scene at a time (edit_scene) — and the stage assembles while people watch.

Plays are wordless shadow-puppet pieces: silhouettes on a warm lit screen, time
measured in beats of \`stage.tempo\`. \`mode\` is \`open\` (anyone may edit) or
\`closed\` (only you). Anonymous callers can only make open plays.`;

export const LIST_PLAYS = `List plays (id, title, mode, creator, version, cast ids, URL). \`query\` matches
title or id, case-insensitively; \`mine\` limits to plays you created. The
response also carries \`library\`: the curated starter puppets and parts you can
import with edit_cast (\`lib.heron\`, \`lib.part.lantern\`, …). Any play's puppet
can also be imported by \`pl_<id>/cast/<puppet>\`, so this is how you find one.`;

export const READ_PLAY = `Read a play, or one part of it, without loading geometry. Returns ids, titles,
beat labels, and the \`note\` on every puppet and part — never path data unless
you name the parts in \`include_paths\`. Cast reads also return derived geometry
for free: each part's local bounding box, its rest position in the puppet frame,
the puppet's overall extent, and \`warnings\` (e.g. a part keyed to move from a
standstill with no rod holding it).

\`sel\` narrows the read: \`s2\` (a scene), \`s2/b4\` (a beat), \`s2/b4:fox\` (one
track), \`cast\` (the whole cast as prose), \`cast.fox\`, \`cast.fox.parts.ear_l\`.
\`depth\` controls how much of the scenes comes back: \`play\` (titles and counts),
\`scene\` (beats with labels, lengths and which puppets have tracks — the
default), \`beat\` (which keyframes exist and which joints each sets), \`key\`
(full poses). Read at the shallowest depth that answers the question; a whole
cast at default depth is a paragraph.`;

export const EDIT_PLAY = `Edit the play's globals and its scene list: \`title\`, \`stage.tempo\` (beats per
minute), \`stage.backdrop\`, \`mode\` (\`open\`/\`closed\`, creator only), \`meta.*\`,
and the scenes themselves (\`scenes\` to insert into; \`s3\` to set or remove; \`s3.title\`).
Beats, tracks, poses and cues are edited with edit_scene; puppets with edit_cast.

An edit is \`{op, sel, ...}\`: \`set\` (write here, replacing what is there — creates
the target if absent), \`insert\` (\`{sel: "scenes", value, after?}\`; \`after\` is a
scene id, omitted appends, \`""\` prepends), \`remove\`, \`nudge\` (\`{sel, delta}\` adds
to a number). One call is one atomic batch committed as one version: if any
edit is rejected, none apply, and \`rejected\` says which index and why. Pass
\`version\` (from your last read or edit) to have the server refuse a batch that
would clobber a change someone else made to the same scope since.

A new scene is \`{id, title, beats: []}\`. Scene and beat ids are yours to choose
(letters, digits, \`_\`, \`-\`; no dots); \`s1\`, \`s2\`… and \`b1\`, \`b2\`… are the
convention.`;

export const EDIT_SCENE = `Edit one scene's beats, tracks, keyframes, poses and cues. Selectors are
relative to the scene: \`beats\` (insert here), \`b4\` (a beat), \`b4.label\`,
\`b4.length\`, \`b4:fox\` (fox's track in b4 — a list of keyframes), \`b4:fox@0\` (the
keyframe at offset 0 beats), \`b4:fox@1.5.joints.head\`, \`b4:fox@*.root.x\` (every
keyframe in the track), \`b4.fx\` (cues), \`b4.fx@0.5\`.

Time is in beats of \`stage.tempo\`. A beat is \`{id, label, length, tracks, fx}\`;
\`length\` is in beats (1–4 is typical; a held moment can be longer). A track is a
list of keyframes \`{at, ease?, pose}\` where \`at\` is the offset inside the beat
and \`ease\` (\`linear|in|out|inOut|hold\`, default \`inOut\`) shapes the motion into
that keyframe. A pose is sparse: \`{joints: {arm_near: -40}, root: {x, y, scale,
facing, plane}}\` — any joint or root field you leave out keeps its previous
value, so state a full pose once when a puppet enters and then key only what
changes. Joint angles are degrees of rotation about the part's pivot, added to the
puppet's restPose. Positive is clockwise on screen for a puppet facing right
(\`facing: 1\`) and mirrored for \`facing: -1\`, so a limb that hangs down at rest
swings forward — toward the way the puppet faces — with a negative angle
(\`arm_near: -90\` is straight out ahead); \`root.x\`/\`root.y\` are 0–1
across the stage (\`y\` ≈ 0.5–0.6 puts feet on the floor for a standing figure),
\`facing\` is 1 or -1, \`plane\` is \`far|mid|near\` (depth: smaller and softer at
the back). A puppet is off stage until its first keyframe.

Motion reads best when a puppet holds still and one thing moves; the engine adds
breath, follow-through and pendulum swing on top of your keys, so a held pose is
never dead. Parts with no rod cannot be moved on purpose while the puppet stands
still — key them during a walk (they read as swing) or give them a rod in
edit_cast. Cues: \`{at, type: "lamp", to: 0.3, over: 2}\` dims the lamp.

Ops are \`set\` (upsert; \`set b4:fox@2\` inserts a keyframe at 2 if none exists),
\`insert\` (\`{sel: "beats", value, after?}\` for beats; \`{sel: "b4:fox", value:
{at, pose}}\` for a keyframe; \`{sel: "b4.fx", value}\` for a cue), \`remove\`, and
\`nudge\` (\`{sel: "b2:heron@*.joints.head", delta: -18}\` tilts the head down
through the whole beat). One call is one atomic batch and one version; pass
\`version\` to refuse clobbering a concurrent change.`;

export const EDIT_CAST = `Add, draw and revise puppets. With \`puppet_id\`, selectors are relative to that
puppet (\`note\`, \`unit\`, \`cap\`, \`restPose.head\`, \`look.idle\`, \`parts\` to insert
into, \`parts.snout\`, \`parts.snout.path\`, \`parts.ear_l.pivot\`); without it they
are relative to the cast (\`fox\` to set or remove a whole puppet, \`fox.parts.tail\`).

A puppet is a tree of parts. Each part is a filled silhouette drawn in its own
frame: \`(0,0)\` is its pivot, the joint it rotates about and the point where it
attaches to its parent; \`+Y\` runs down the part's length and \`+X\` to its right
(screen coordinates, so +Y is down). Draw every part at canonical rest, extended
along +Y — a leg hangs straight down, an arm too, a neck goes up as −Y. A child's
\`pivot\` is a point in the parent's frame. All parts share the puppet's \`unit\`
(its height; 100 is the convention), and the puppet's \`restPose\` holds rest
angles per part, so bearing (hunched, proud) is a number, not a redraw.
\`z\` orders parts front to back; \`mirrorOf\` reflects another part instead of
drawing one (\`{id: "ear_r", parent: "head", pivot: [18,-10], mirrorOf: "ear_l"}\`);
\`swing\` (0–1) makes a hanging prop a pendulum. A puppet needs one root part
(\`parent: null\`, usually \`torso\`).

\`path\` is SVG path data in the part's frame, any commands — it is normalised to
absolute M/L/Q/C/Z on write; fill only, overlaps and self-intersection are
harmless, unclosed paths are closed. The renderer draws a disc of radius \`cap\`
at every pivot, so joints never tear and a contour that stops just short of its
child is bridged. Write generously overlapping shapes rather than exact ones.
Whenever you write a \`path\` you must write that part's \`note\` in the same call:
a short description of what the contour is (the only channel to a later
session, which cannot read path data). The puppet needs a \`note\` too.

Rods: every puppet hangs from a main rod at its root. Give \`rod: [x, y]\` (a
point in the part's frame) to each part the play will move deliberately while
the puppet stands still — a head, a hand, a wing — and to nothing else; the rod
drives the chain from that part to the root. Unrodded parts can only swing.

Ops: \`set\` (upsert), \`insert\` (\`{sel: "parts", value: {…part}}\`; \`{sel: "",
value: {…puppet}}\` unscoped, or \`set fox\` with a whole puppet), \`remove\` (a part
takes its subtree; pass a prop between puppets with a remove and an insert in
one call), \`nudge\` (\`{sel: "parts.ear_l.pivot", delta: [2, -3]}\`), and \`import\`:
\`{op: "import", src: "lib.heron", as: "heron"}\` copies a starter puppet in;
\`{op: "import", src: "pl_ab12cd/cast/heron", as: "gull"}\` copies a puppet from
any play; \`{op: "import", src: "lib.part.lantern", into: "keeper", parent:
"hand_near", pivot: [0, 8]}\` grafts a part subtree, rescaled to the target's
unit. Imports are copies; \`from\` records where they came from. Starters:
\`lib.heron\`, \`lib.fox\`, \`lib.keeper\`; parts \`lib.part.lantern\`, \`lib.part.hand_open\`.
Prefer importing something near and changing it over drawing cold; read it
first (\`read_play … sel: "cast.heron"\`) to see its part names and extents.
One call is one atomic batch and one version; pass \`version\` to refuse
clobbering a concurrent change.`;
