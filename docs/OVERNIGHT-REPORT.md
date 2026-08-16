# Overnight run — 2026-08-17

## Task status

- [ ] 1. Tool-output truncation with file spill
- [ ] 2. Compaction tier 1 (prune)
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
- Starting task 1 here.

## Needs review in the morning

- **`Projects/harness` is red on `main`** (24 failures, Bun API mismatch on `toMatchFileSnapshot`).
  Unrelated to compass-harness, but it means the overnight instructions as written could never have
  gone green there either.
- **D2**: tool-output limits are constants + env vars because there is no config system to hang
  them off. If a config layer is planned, this is where it should plug in first.
