# Attribution

`compass-harness` ports code from [opencode](https://github.com/anomalyco/opencode), which is MIT
licensed. The full license text is retained at [licenses/opencode-MIT.txt](licenses/opencode-MIT.txt).

Every ported file carries a header naming its origin:

```ts
// Ported from opencode (MIT). Source: packages/opencode/src/tool/edit.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
```

## Ported files

| compass-harness                            | opencode origin                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/tool/edit-replacers.ts` | `packages/opencode/src/tool/edit.ts:217-737`                                                 | Verbatim. Ten fallback matching strategies, `levenshtein`, `replace`, `trimDiff`. Only change: 35 non-null assertions for `noUncheckedIndexedAccess`. Verified byte-identical after stripping them.                                                                                                                                                        |
| `packages/core/src/tool/truncate.ts`       | `packages/core/src/tool-output-store.ts:50-110`                                              | `takePrefix`/`takeSuffix`/`preview` middle-out bounding. Managed output files deferred to M1.6.                                                                                                                                                                                                                                                            |
| `packages/core/src/session/retry.ts`       | `packages/opencode/src/session/retry.ts`                                                     | Backoff arithmetic, Retry-After handling and the six retryable-message patterns are verbatim. Their OpenCode Go branches (`FreeUsageLimitError`, `GoUsageLimitError`, the subscribe upsell) are dropped — that is their commercial service, not a retry concern. Errors are the AI SDK's `APICallError` rather than their normalized `SessionV1.APIError`. |
| `packages/core/src/provider/error.ts`      | `packages/llm/src/provider-error.ts:4-38`, `packages/opencode/src/provider/error.ts:165-186` | The 27 context-overflow patterns and 3 exclusions are verbatim; each is a bug report someone already filed. Classification returns three cases (`context_overflow`/`api_error`/`unknown`) rather than their two, because we classify the SDK error directly instead of a pre-normalized one.                                                               |

> Note: an earlier revision of `truncate.ts` was adapted from `packages/opencode/src/tool/truncate.ts`.
> That is opencode's **legacy V1** path and clips head-or-tail. The V2 store above preserves the
> beginning and end, which is what `CONTEXT.md` specifies and what keeps tool-appended framing
> (pagination hints, exit codes, stderr) visible to the model.

## Planned ports

Recorded here so the list above can be audited against intent.

| Planned target                                    | opencode origin                                       | Rationale                                                                |
| ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/core/src/tool/edit-replacers.ts`        | `packages/opencode/src/tool/edit.ts:217-737`          | Ten fallback matching strategies; pure functions, no framework coupling. |
| `packages/core/src/tool/apply-patch-parser.ts`    | `packages/opencode/src/tool/apply_patch.ts`           | Patch format parsing.                                                    |
| `packages/core/src/tool/truncate.ts`              | `packages/opencode/src/tool/truncate.ts`              | Output bounding.                                                         |
| `packages/core/src/tool/prompt/*.txt`             | `packages/opencode/src/tool/*.txt`                    | Tuned tool descriptions.                                                 |
| `packages/core/src/agent/subagent-permissions.ts` | `packages/opencode/src/agent/subagent-permissions.ts` | Subagent permission derivation.                                          |
| `packages/core/src/tool/prompt/task.txt`          | `packages/opencode/src/tool/task.txt`                 | Subagent delegation prompt.                                              |

## Architectural debt

Design and vocabulary are also drawn from opencode's `AGENTS.md`, `CONTEXT.md`, and `specs/v2/`,
notably: durable prompt admission separated from execution, steer-vs-queue delivery, Context Epoch
baselines, the child-session subagent model, and the worker-thread HTTP transport.
