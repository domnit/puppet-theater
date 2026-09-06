# Puppet Theater — Project Overview

**Theme 2: Creative & Generative Tools**

## Premise

A 2D puppet theater that stages generated plays. The user directs the stage in
natural language and can intervene at any level of granularity — from "tell me a
story about a lonely lighthouse" down to "raise the fox's left arm 15° on beat 4."

The point is not that it generates plays. The point is the **granularity
spectrum**: one creative object that stays editable at every zoom level, with
the same conversational interface at each.

## Why this hits the theme

Theme 2 asks for "not just generate buttons, but real control over iteration,
variation, and refinement." Most generative tools collapse to a prompt box and a
reroll button because their output has no addressable structure. A puppet does:
it's a rig of named parts, and a script is a sequence of poses and beats. That
compositionality means every level of a request maps to a real edit on a real
object, so iteration is targeted rather than a re-roll of the whole artifact.

Fork and remix on top of that gives version control over creative work — branch
a scene, vary one puppet, keep both.

## The control spectrum

The same chat handles all of these:

| Altitude | Example request |
|---|---|
| Broad strokes | "A tragedy, three acts, mostly wordless" |
| Story-level | "The merchant should betray the sailor in act two" |
| Staging | "Move the crowd upstage, keep the lantern centered" |
| Component | "Her head tilts down through the whole final beat" |
| Remix | "Retell this as allegory for [bundled source]" |

The user is not told this range up front. It's surfaced in-fiction by a
stage-manager voice that answers a broad request with a scene *and* an offer to
adjust one detail — teaching the depth by demonstrating it once. Coy about
*how*, not about *whether*.

## Architecture

Server-authoritative scene state. Two clients, one tool surface.

- **In-app chat** — embedded, styled to the theater. Zero setup, works in a
  browser. This is the reviewer's default path.
- **MCP server** — same tools over remote transport, for Claude Code or
  Claude.ai. For users who want to drive the stage from their own agent.

Tools are defined once as plain functions and wrapped twice, so the two clients
cannot drift apart.

State changes push to the browser over SSE, regardless of which client made the
edit. A user can have Claude Code and the web app open at once and watch the
stage update from either. Scenes have IDs and are shareable by URL; the MCP
tools take a scene ID, which is how the two clients agree on what they're
editing.

The landing page plays a **pre-rendered** generated play with royalty-free
score. First impression never depends on a live API call.

## Self-contained evaluation

Nothing to install, no data to source, no domain knowledge assumed. The reviewer
opens a URL, watches a play, and types into the chat. Bundled opening prompts
deliberately differ in altitude so the control range is visible within the first
minute. Remix sources are bundled rather than open-input.

## Open questions

- **Puppet style.** Shadow silhouettes are the leading candidate: jointed 2D
  forms, no lighting or asset pipeline, and simplicity reads as deliberate.
- **Data model.** What a puppet and a script look like as JSON. This decides
  whether component-level edits are expressible at all.
- **Motion semantics.** Likely keyframed poses with easing. Constrains what a
  "script" is and what the tools can address.

## Primary risk

Animation quality carries the demo. Puppet motion is unforgiving — a bad hold or
a popping limb reads as broken instantly, and no amount of architectural
elegance compensates. Motion model and data model get resolved before anything
else gets built.

## Scope guard

Three systems: animation engine, agent loop, data model. The agent loop is
cheapest if the tool surface stays small — target ~5 verbs and let composition
do the rest. If time runs short, MCP ships as future work and the in-app chat
carries the submission.