# pupper-theater

A 2D shadow-puppet theater that agents stage and revise at any granularity.
Spec: [notes/spec.md](notes/spec.md). Reasoning: [notes/spec-scratch.md](notes/spec-scratch.md).

## Milestone 0 — renderer, part tree, beat player, harness

```bash
bun install
bun run dev        # harness at http://localhost:4200
bun run check      # tsc
bun scripts/snapshot.ts fixtures/plays/00-showcase.json 1.9 5.3 7.8 9.8   # stills → out/
```

The harness loads a play from `fixtures/plays/`, embeds any cast entry given as
a path under `fixtures/`, validates it, and plays it once. Edit any fixture or
source file and the page updates in place (fixtures re-fetch, code reloads,
time position is kept).

- **Transport**: play/pause (space), frame step (← →), beat step (shift+← →),
  scrub, home/end.
- **One puppet**: a cast member alone, at rest, centred, procedural layers off.
- **Layers**: idle (breath, sway, joint drift), follow-through, swing
  (pendulum), control rods. Toggle each to see what it contributes.
- **Overlays**: pivots and local axes, part boundaries, computed bounding
  boxes, cap discs. The cast panel lists the part tree with live angles; click
  a part there or on the stage to select it.

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
