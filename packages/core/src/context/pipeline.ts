import type { ModelMessage } from "ai"

/**
 * Compaction tier 1 — prune.
 *
 * Tool results dominate context growth and every byte is re-sent with every
 * subsequent request, so old ones are the cheapest thing to give up. This pass
 * shrinks the TEXT of tool results that fall outside a protected recent window
 * and leaves everything else alone.
 *
 * What it must never do:
 * - Touch the frozen prefix. The system prompt and tool definitions are not
 *   messages and never reach this function.
 * - Orphan a tool call from its result. Blocks are never removed and never
 *   reordered — only the text inside a tool-result is shortened — so the
 *   call/result pairing is preserved by construction rather than by care.
 *
 * Tier 2 (LLM summarization of pruned spans) is deliberately not implemented.
 */

function envInt(name: string, fallback: number) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Above this estimated size, a prune pass runs. */
export const TRIGGER_TOKENS = envInt("COMPASS_COMPACT_TRIGGER_TOKENS", 20_000)
/** The most recent this many estimated tokens are never pruned. */
export const PROTECT_TOKENS = envInt("COMPASS_COMPACT_PROTECT_TOKENS", 40_000)
/** Pruned tool results are shortened to this many characters. */
export const PRUNED_RESULT_CHARS = envInt("COMPASS_COMPACT_RESULT_CHARS", 2_000)

export interface PruneOptions {
  readonly triggerTokens?: number
  readonly protectTokens?: number
  readonly resultChars?: number
}

export interface PruneOutcome {
  readonly messages: ModelMessage[]
  /** Tool-result blocks whose text was shortened. */
  readonly pruned: number
  readonly charsSaved: number
}

/** Length/4. Deliberately crude — never call the provider to count tokens. */
export function estimateTokens(value: string) {
  return Math.ceil(value.length / 4)
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  let text = ""
  for (const part of message.content) {
    if (typeof part !== "object" || part === null) continue
    if ("text" in part && typeof part.text === "string") text += part.text
    if ("output" in part) text += outputText(part.output)
  }
  return text
}

const TEXT_OUTPUTS = new Set(["text", "error-text"])

/** Text of a tool-result output, or "" for variants this pass must not rewrite. */
function outputText(output: unknown): string {
  if (typeof output !== "object" || output === null) return ""
  if (!("value" in output) || !("type" in output)) return ""
  const shape = output as { type: unknown; value: unknown }
  if (typeof shape.type !== "string" || !TEXT_OUTPUTS.has(shape.type)) return ""
  return typeof shape.value === "string" ? shape.value : ""
}

/** Tool-result text carried by one message. The only thing this pass shrinks. */
function toolOutputText(message: ModelMessage): string {
  if (message.role !== "tool" || !Array.isArray(message.content)) return ""
  let text = ""
  for (const part of message.content) {
    if (typeof part === "object" && part !== null && "output" in part) text += outputText(part.output)
  }
  return text
}

export function estimateMessages(messages: readonly ModelMessage[]) {
  let total = 0
  for (const message of messages) total += estimateTokens(messageText(message))
  return total
}

/**
 * Sentinel marking an already-pruned result. prune() runs on every turn, and a
 * pruned result is still longer than the limit (kept text plus this marker), so
 * without this each request would prune the same block again, stacking markers
 * and shrinking the text further every turn.
 *
 * Anchored to the end rather than searched for anywhere in the text: genuine
 * tool output can contain this string (a grep over this very file does), and a
 * substring match would exempt that output from the size cap forever.
 */
const PRUNE_SENTINEL = "[older tool result pruned to save context:"

function marker(original: number, kept: number) {
  return `\n\n${PRUNE_SENTINEL} ${original - kept} of ${original} characters removed. Re-run the tool if you need the full output.]`
}

function alreadyPruned(text: string) {
  const start = text.lastIndexOf(`\n\n${PRUNE_SENTINEL}`)
  return start !== -1 && text.endsWith("]") && text.indexOf("\n", start + 2) === -1
}

function prunableChars(text: string, resultChars: number) {
  if (alreadyPruned(text) || text.length <= resultChars) return 0
  return text.length - resultChars
}

/**
 * Index of the oldest message still inside the protected window.
 *
 * The window is measured over TOOL OUTPUT only, not the whole conversation.
 * Measuring the total would make the two thresholds nest — a protect window
 * larger than the trigger could then never be exceeded, leaving the trigger
 * dead and nothing ever pruned.
 */
function protectedBoundary(messages: readonly ModelMessage[], protectTokens: number) {
  let accumulated = 0
  let boundary = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    accumulated += estimateTokens(toolOutputText(messages[index]!))
    // Advance before the break check, so the newest message stays protected even
    // when it alone exceeds the window. Otherwise a single oversized result
    // leaves the boundary at messages.length and nothing is protected at all.
    boundary = index
    if (accumulated > protectTokens) break
  }
  return boundary
}

/** Estimated tokens recoverable by pruning, i.e. what is outside the window. */
export function prunableTokens(messages: readonly ModelMessage[], options: PruneOptions = {}) {
  const boundary = protectedBoundary(messages, options.protectTokens ?? PROTECT_TOKENS)
  const resultChars = options.resultChars ?? PRUNED_RESULT_CHARS
  let total = 0
  for (let index = 0; index < boundary; index++) {
    total += estimateTokens("x".repeat(prunableChars(toolOutputText(messages[index]!), resultChars)))
  }
  return total
}

/**
 * True when a prune pass would actually recover something. Compares what is
 * recoverable OUTSIDE the protected window against the trigger — not the size
 * of the whole conversation, which is what made the trigger unreachable.
 */
export function shouldCompact(messages: readonly ModelMessage[], options: PruneOptions = {}) {
  return prunableTokens(messages, options) > (options.triggerTokens ?? TRIGGER_TOKENS)
}

function pruneOutput(output: unknown, resultChars: number) {
  const text = outputText(output)
  if (prunableChars(text, resultChars) === 0) return undefined
  const kept = text.slice(0, resultChars)
  return { text: `${kept}${marker(text.length, kept.length)}`, saved: text.length - kept.length }
}

/** Shortens tool-result text older than the protected window. */
export function prune(messages: readonly ModelMessage[], options: PruneOptions = {}): PruneOutcome {
  const resultChars = options.resultChars ?? PRUNED_RESULT_CHARS

  if (!shouldCompact(messages, options)) {
    return { messages: [...messages], pruned: 0, charsSaved: 0 }
  }

  const boundary = protectedBoundary(messages, options.protectTokens ?? PROTECT_TOKENS)
  let pruned = 0
  let charsSaved = 0

  const next = messages.map((message, index) => {
    if (index >= boundary) return message
    if (message.role !== "tool" || !Array.isArray(message.content)) return message

    const content = message.content.map((part) => {
      if (typeof part !== "object" || part === null || !("output" in part)) return part
      const shortened = pruneOutput(part.output, resultChars)
      if (shortened === undefined) return part
      pruned++
      charsSaved += shortened.saved
      // Spread preserves the discriminant, so an error result stays an error
      // result. outputText() already refused every non-text variant.
      const output = part.output as { type?: unknown }
      return { ...part, output: { ...output, value: shortened.text } }
    })
    return { ...message, content } as ModelMessage
  })

  return { messages: next, pruned, charsSaved }
}

export * as ContextPipeline from "./pipeline"
