import { Schema } from "effect"
import { MessageID, PartID, SessionID } from "./id"

export const Role = Schema.Literals(["user", "assistant"])
export type Role = typeof Role.Type

/**
 * Parts are stored in their own table rather than as a blob on the message.
 * They stream in incrementally and are updated in place while a turn runs.
 */
export const TextPart = Schema.Struct({
  id: PartID,
  messageID: MessageID,
  sessionID: SessionID,
  type: Schema.Literal("text"),
  text: Schema.String,
  /** Synthetic parts are model-visible but were not typed by the user. */
  synthetic: Schema.optionalKey(Schema.Boolean),
})
export type TextPart = typeof TextPart.Type

export const ReasoningPart = Schema.Struct({
  id: PartID,
  messageID: MessageID,
  sessionID: SessionID,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
})
export type ReasoningPart = typeof ReasoningPart.Type

export const ToolState = Schema.Literals(["pending", "running", "completed", "error"])
export type ToolState = typeof ToolState.Type

export const ToolPart = Schema.Struct({
  id: PartID,
  messageID: MessageID,
  sessionID: SessionID,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,
  input: Schema.optionalKey(Schema.Unknown),
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
export type ToolPart = typeof ToolPart.Type

export const Part = Schema.Union([TextPart, ReasoningPart, ToolPart])
export type Part = typeof Part.Type

/**
 * What a turn actually cost, as reported by the provider.
 *
 * The split is not cosmetic. `input` is the *non-cached* input only: the AI SDK
 * normalizes `inputTokens` to include cache reads and writes, so the cached
 * counts are subtracted back out here and carried separately. Anything deciding
 * whether a conversation still fits must add them back — see `contextTokens`.
 *
 * Likewise `output` excludes `reasoning`, which providers bill and count
 * separately even though it never appears in the reply.
 */
export const Tokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
  /** The provider's own total, when it gave one. Authoritative over our sum. */
  total: Schema.optionalKey(Schema.Number),
})
export type Tokens = typeof Tokens.Type

export const Message = Schema.Struct({
  id: MessageID,
  sessionID: SessionID,
  role: Role,
  timeCreated: Schema.Number,
  timeCompleted: Schema.optionalKey(Schema.Number),
  providerID: Schema.optionalKey(Schema.String),
  modelID: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Tokens),
})
export type Message = typeof Message.Type

/**
 * How much of the context window a turn occupied.
 *
 * The provider's `total` wins when present. The fallback re-adds every part
 * that was split out — including `reasoning`, which opencode's equivalent
 * fallback omits (session/overflow.ts:32). Their `total` is almost always
 * present so the omission rarely bites, but a reasoning-heavy turn on a
 * provider that reports no total would read as smaller than it was, which is
 * the one direction this number must never be wrong in.
 */
export function contextTokens(tokens: Tokens): number {
  return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export const MessageWithParts = Schema.Struct({
  info: Message,
  parts: Schema.Array(Part),
})
export type MessageWithParts = typeof MessageWithParts.Type
