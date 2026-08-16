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

export const Message = Schema.Struct({
  id: MessageID,
  sessionID: SessionID,
  role: Role,
  timeCreated: Schema.Number,
  timeCompleted: Schema.optionalKey(Schema.Number),
  providerID: Schema.optionalKey(Schema.String),
  modelID: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
export type Message = typeof Message.Type

export const MessageWithParts = Schema.Struct({
  info: Message,
  parts: Schema.Array(Part),
})
export type MessageWithParts = typeof MessageWithParts.Type
