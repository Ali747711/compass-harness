// Ported from opencode (MIT). Source: packages/core/src/session/compaction.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// SUMMARY_TEMPLATE, SUMMARY_UPDATE_INSTRUCTIONS, buildPrompt, select and
// serialize are ported. Their V1 equivalent (packages/opencode/src/session/
// compaction.ts, 608 lines) is coupled to agents, plugins, and a processor we
// do not have; this V2 module is the same mechanism without them.
//
// Diverges from the original: their message model has system/synthetic/shell
// message types and file attachments, none of which exist here yet, so
// `serialize` covers the three part types we actually store.

import type { Message, Part, TextPart, ToolPart } from "@compass/schema"

/** Headroom left for the reply when deciding whether a request still fits. */
export const DEFAULT_BUFFER = 20_000
/** How much of the recent conversation survives compaction verbatim. */
export const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
export const SUMMARY_OUTPUT_TOKENS = 4_096

/**
 * Copied verbatim. The structure is the point: a summary another agent can act
 * on rather than a paragraph about what happened. Rewriting it degrades the
 * result in ways that only show up several turns later, when something the
 * summary dropped turns out to have mattered.
 */
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

/**
 * Copied verbatim. Compaction is lossy and recursive — the second compaction
 * summarizes the first summary — so the instruction that anything not carried
 * forward is gone is doing real work.
 */
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`

/** Same rough character-per-token ratio the prune tier uses. */
export const estimateTokens = (value: string) => Math.ceil(value.length / 4)

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export interface Entry {
  readonly info: Pick<Message, "role">
  readonly parts: readonly Part[]
}

/**
 * Renders a stored message as the plain text the summarizer reads.
 *
 * Deliberately not the provider message format. The summarizer is being asked
 * to read a transcript, and a transcript with speaker labels is easier to
 * compress faithfully than a JSON tool-call structure.
 */
export function serialize(entry: Entry): string {
  if (entry.info.role === "user") {
    const text = entry.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    return text ? `[User]: ${text}` : ""
  }

  return entry.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const tool = part as ToolPart
      const input = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input ?? {})
      const call = `[Assistant tool call]: ${tool.tool}(${input})`
      if (tool.state === "completed") return [call, `[Tool result]: ${truncate(tool.output ?? "")}`]
      if (tool.state === "error") return [call, `[Tool error]: ${tool.error ?? "tool failed"}`]
      return [call]
    })
    .join("\n")
}

export interface Selection {
  /** Older conversation, to be replaced by a summary. */
  readonly head: string
  /** Recent conversation, kept verbatim. */
  readonly recent: string
}

/**
 * Splits the conversation into the part that gets summarized and the part that
 * survives intact.
 *
 * Walks backwards from the newest message, keeping whole messages while they
 * fit in `keepTokens`. Backwards because recency is what matters: the model
 * needs the last few exchanges in full detail far more than the first.
 */
export function select(entries: readonly Entry[], keepTokens: number): Selection | undefined {
  const conversation = entries
    .filter((entry) => !entry.parts.some((part) => part.type === "compaction"))
    .map(serialize)
    .filter(Boolean)
  if (conversation.length === 0) return undefined

  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + estimateTokens(conversation[index]!)
    if (next > keepTokens) break
    total = next
    split = index
  }

  return {
    head: conversation.slice(0, split).join("\n\n"),
    recent: conversation.slice(split).join("\n\n"),
  }
}

/** Copied verbatim. */
export function buildPrompt(input: { readonly previousSummary?: string; readonly context: readonly string[] }) {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

/** The compaction boundary in a history, if one has happened. */
export function lastCompaction(entries: readonly Entry[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const part = entries[index]!.parts.find((candidate) => candidate.type === "compaction")
    if (part !== undefined) return { index, part }
  }
  return undefined
}

/**
 * Whether a summarization request would itself fit.
 *
 * The failure this prevents is circular: compaction runs because the context is
 * full, and the prompt it builds is made of that same context. Without the
 * guard an oversized conversation produces an oversized summary request, which
 * fails for the identical reason, and nothing has improved.
 */
export function summaryFits(prompt: string, limit: { context: number; output: number }) {
  const output = Math.min(limit.output === 0 ? SUMMARY_OUTPUT_TOKENS : limit.output, SUMMARY_OUTPUT_TOKENS)
  return estimateTokens(prompt) <= limit.context - output
}
