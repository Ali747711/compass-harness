# Overnight run — 2026-08-17

## Task status

- [x] 1. Tool-output truncation with file spill — `c92b2cf`
- [x] 2. Compaction tier 1 (prune) — `34394cd`
- [ ] 3. Tool descriptions to .txt files
- [ ] 4. (stretch) provider coverage hardening

## Scope correction (read this first)

`OVERNIGHT.md` names `/Users/mac/Desktop/Projects/harness` as the working directory and forbids
edits outside it. That directory exists and its contents match the task text exactly, so the first
iteration started there. The user corrected it: the intended target is **compass-harness**.

Changes made to `Projects/harness` before the correction were reverted — three tracked files
restored with `git checkout --`, two created files removed. Nothing was committed or pushed there;
`git log -1` is still `9f2c392`, and its working tree holds only the user's own untracked docs.

None of `OVERNIGHT.md`'s concrete references exist here, so the tasks are being followed by intent
with these translations, all recorded rather than assumed:

| `OVERNIGHT.md` says                                | compass-harness reality                                 | Translation                                               |
| -------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `/Users/mac/Desktop/Projects/harness`              | different project                                       | Work in `compass-harness`; nothing outside it is touched. |
| `bun run check`                                    | no such script                                          | `bun run typecheck && bun run lint && bun run test`       |
| biome                                              | oxlint + prettier                                       | Use those.                                                |
| coverage gates                                     | none configured                                         | No gate to hold; do not invent one.                       |
| golden transcripts                                 | none                                                    | Rule is vacuous here.                                     |
| ADR-0007/0008, `SAFETY.md`, `.harness/config.json` | none exist                                              | Nothing to amend or protect.                              |
| `config/schema.ts`, `NESTED_CONFIG_KEYS`           | **no config system at all**                             | See decision D2.                                          |
| `context/pipeline.ts` `shouldCompact()`            | no seam exists                                          | Task 2 must create one.                                   |
| `model/anthropic/client.ts` at ~7% coverage        | no such file; uses the Vercel AI SDK                    | Task 4 barely maps; see D4.                               |
| Push to main                                       | on branch `location-scoping`, 6 commits ahead of `main` | See decision D1.                                          |

## Decisions

Conservative choices made without asking, per `OVERNIGHT.md`'s standing instruction.

**D1 — commit to the current branch, do not merge to main.** `OVERNIGHT.md` says "push to main".
`main` here is 6 commits behind `location-scoping`, and the user's stated workflow is
PR-per-milestone squashed to `main` by them. Merging overnight would take that decision away, so
work lands on the existing branch and is pushed there. Nothing is pushed red.

**D2 — no config system is built for task 1.** The task specifies `toolOutput: { maxLines, maxBytes }`
following an existing nested-config pattern. compass-harness has no config layer whatsoever, so
that pattern cannot be followed. Building one is a task in its own right and well beyond "implement
minimally". Limits are exported constants with environment overrides
(`COMPASS_TOOL_OUTPUT_MAX_LINES` / `COMPASS_TOOL_OUTPUT_MAX_BYTES`), shaped so a real config layer
can supply them later without touching call sites. Flagged for morning review.

**D4 — task 4 does not map.** There is no `model/anthropic/client.ts`; provider access is the
Vercel AI SDK behind `provider/provider.ts` (~60 lines, no branching worth cassettes). If tasks 1–3
finish green, the useful equivalent is coverage for `session/run.ts`, which has no direct tests
today. Will re-scope explicitly if reached.

## Log

### 2026-08-17 — iteration 1

- Read `OVERNIGHT.md`; created this report (did not exist).
- Went to `Projects/harness` first, per the file's own directory line. Corrected and fully
  reverted; see scope correction above.
- Established a baseline there before reverting, which is worth recording because it is a fact
  about that repo the user may not know: on clean `main`, `bun test` is **24 failing / 337 passing**.
  All 13 golden-transcript failures share one cause —
  `expect(...).toMatchFileSnapshot is not a function` — which is a Bun API mismatch, not a content
  diff. That repo cannot currently satisfy `OVERNIGHT.md`'s "completely green" gate on this machine.
- **Task 1 done** — `c92b2cf`, pushed to `location-scoping`. typecheck 3/3, lint clean, 333 tests
  in `packages/core` (21 of them new).

  Full text now spills to `<session>/.compass/tool-output/<sessionID>/<callID>.txt`; the bounded
  preview names the path. `exceeds()` lets the registry spill before bounding, because the marker
  must carry the path and writing is async while bounding is not.

  Code review returned 2 CRITICAL and 1 HIGH, all reproduced, all fixed before commit with a
  regression test each:
  1. **Path traversal via `callID`.** It is the provider's `toolCallId` — untrusted, typed as a
     bare string. A `../` in it wrote outside the spill root entirely. Now allowlisted per segment
     and containment-checked against the root.
  2. **Spill was landing unignored in the user's working tree.** It holds raw tool output — file
     contents, shell stdout, fetched pages — in whatever project the session runs in, one
     `git add .` from being committed. The spill root now writes its own `.gitignore` of `*` on
     creation, so every project is protected, not just this one.
  3. **`Effect.promise` on a rejecting `rm` becomes a defect**, and `Effect.ignore` does not catch
     defects. A permission error during the retention sweep crashed the CLI _after_ the prompt had
     already succeeded. `sweep`/`clear` can no longer fail through any channel.

  Two LOW findings left alone deliberately: `stat` vs `lstat` for staleness (spill only ever
  creates real files itself), and env-derived limits being read at module load (correct for a
  one-shot CLI, revisit when a config layer or long-lived server lands).

- **Correction:** the `c92b2cf` message claims "349 tests passing". The real figure is 333.
  `OVERNIGHT.md` forbids force-push in any form, so the message cannot be amended — recorded here
  instead rather than left as a false claim in history.

- `Spill.clear` is implemented and tested but has no call site: there is no session-close lifecycle
  in the CLI yet. The age-based half of the cleanup rule runs after each prompt. Noted for review.

### 2026-08-17 — iteration 2 (next)

**Task 2 done** — `34394cd`, pushed. typecheck 3/3, lint clean, 355 tests (22 new).

Created the `context/pipeline.ts` seam rather than filling one in; none existed here. `prune()`
runs before every provider request in `session/run.ts`. Tier 2 (LLM summarization) deliberately
not implemented, per the task.

Review returned 2 HIGH, both reproduced, both fixed with regression tests:

1. **The trigger was dead.** `shouldCompact` and the protect-window walk both measured the whole
   conversation, so with `PROTECT` 40k > `TRIGGER` 20k the window could never be exceeded at the
   moment the trigger fired — nothing pruned until 40k, and the documented threshold was
   decorative. I had spotted the constants looking inconsistent and intended only to note it. The
   reviewer went to opencode's `compaction.ts` and found why they are coherent there: **two
   different accumulators**. The window walks tool output only; the gate measures what is
   recoverable *outside* it. Ported properly, so the thresholds no longer nest.
2. **The newest message could be left unprotected.** The boundary advanced only after its break
   check, so a newest message that alone exceeded the window left the boundary at `messages.length`
   and protected nothing — truncating the tool result the assistant had just produced, before it
   could be used. Realistic at defaults with one large file read.

Two MEDIUMs also fixed since they were cheap and real: structured outputs (`json`, `error-json`,
`content`) are now left alone instead of having `value` rewritten to a string while keeping a type
promising otherwise; and the already-pruned sentinel is anchored to the end of the text, so genuine
output containing that string (a grep over the pipeline source produces exactly this) is still
capped.

A third bug was caught by my own idempotency test before review: `prune()` runs every turn, and a
pruned result is still over the limit, so each request re-pruned the same block, stacking markers.

Deferred, noted rather than fixed: `estimateMessages` ignores image/file parts and tool-call input,
so it under-counts if a tool ever emits attachments (unreachable today — `toModelMessages` only
builds text/tool-call/tool-result). And `prune()`'s outcome (`pruned`, `charsSaved`) is discarded
at the call site, so there is no way to observe whether compaction ran on a given turn.

### 2026-08-17 — iteration 3 (next)

Starting task 3, tool descriptions to `.txt` files.

## Needs review in the morning

- **`Projects/harness` is red on `main`** (24 failures, Bun API mismatch on `toMatchFileSnapshot`).
  Unrelated to compass-harness, but it means the overnight instructions as written could never have
  gone green there either.
- **D2**: tool-output limits are constants + env vars because there is no config system to hang
  them off. If a config layer is planned, this is where it should plug in first.
