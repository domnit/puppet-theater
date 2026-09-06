---
name: milestone
description: How to run a large, ambitious task in this repo — orchestrate subagents for execution while keeping the design decisions, verification, and commit cadence yourself. Use when handed a milestone, a spec section, or any multi-step build; not for single-file edits or questions.
---

# Running a milestone

You are the orchestrator and the quality gate. Delegate execution liberally;
never delegate judgement.

## 1. Decide before you delegate

Read the relevant part of `notes/spec.md` (and `notes/spec-scratch.md` for why a
thing is the way it is) before writing any prompt. Make these calls yourself,
in your own context, and write them down in the subagent prompts:

- the data shapes and module boundaries the work has to fit;
- anything that changes an existing contract (schemas in `src/model/types.ts`,
  tool signatures, on-disk or SQLite formats, URLs);
- what "done and good" means for each piece, concretely enough to check.

If the spec is silent or contradicts itself, decide, say so in one line to the
user, and record the decision in the commit message or in `notes/`. Do not ask
the user to arbitrate details a careful colleague would settle alone; do ask
when two readings would produce materially different work.

## 2. Delegate execution

Break the milestone into pieces that touch disjoint files, and run independent
pieces concurrently (multiple `Agent` calls in one message). Prefer smaller,
cheaper models for mechanical execution — porting, filling in a module against a
stated interface, writing tests for pure functions, sweeping a rename.

Each subagent prompt should carry, verbatim rather than by reference:

- the files it owns and the files it must not touch;
- the interfaces it must implement or call, spelled out;
- the conventions it must match (this repo's are in `README.md` under
  "Conventions decided at the keyboard" and in the surrounding code);
- the tests it owes (see below) and the command to run them;
- an instruction to report what it did **not** manage to do.

Keep work that spans the whole design — the shape of a new module, a schema
change, anything touching more than one subagent's files — for yourself.

## 3. Test what can be tested

Follow `test/` as it stands: unit tests for the pure core, an invariant sweep
over the fixtures, end-to-end tests for the server and tools. Concretely:

- **Pure logic gets unit tests.** Paths, math, timeline expansion, selectors,
  validation, edits, store and OAuth behaviour — anything with a defined answer.
- **Fixtures get invariant sweeps, not golden numbers.** Assert that everything
  validates, resolves, and evaluates to finite well-formed geometry across the
  whole timeline. Do not pin values a tuning pass is allowed to change
  (`test/fixtures.test.ts` is the model).
- **Rendering and motion quality are judged by eye**, not asserted. Use the
  harness (`bun run dev`) or `bun scripts/snapshot.ts` and look. Never write a
  test that freezes a number you are still tuning.
- New behaviour that is worth keeping is worth a test. New behaviour that is a
  spike you expect to throw away is not — say which you think it is.

## 4. Verify yourself

Never take a subagent's "done" at face value. Before anything is committed:

```bash
bun run check && bun test
```

Then read the diff of what the subagents wrote — at minimum every file that
crosses a boundary you defined — and fix or re-delegate what does not match.
For anything visible, run it and look: the harness for stage work, a real
request against `bun run serve` for server work, an actual tool call for MCP
work. Report what you verified and how; if you skipped a check, say so.

## 5. Commit and push at a real cadence

Commit only working code: `check` and `test` green, and the visible parts
looked at. `.githooks/pre-commit` runs both, so enable it
(`git config core.hooksPath .githooks`) rather than relying on memory.

- Commit at least once per milestone, and at each sub-milestone that stands on
  its own (a module with its tests, a fixture set, a working end-to-end path).
- Commit **only the files this task touched** — use `git commit <paths>...`,
  never `-a` or `git add -A`. The working tree usually carries unrelated work.
  Check `git status --short` first and name what is going in.
- Write the message for someone reading the log a year later: what changed and
  what decision it encodes, not a list of files.
- Push after each milestone commit.

## 6. Report

When the milestone is done, tell the user in a few lines: what landed, what you
decided that the spec did not, what is tested versus eyeballed, and what you
deliberately left out. Anything you could not finish gets said plainly, not
buried.
