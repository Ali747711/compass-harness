import { Schema } from "effect"
import { SessionID } from "./id"

/**
 * `parentID` is present from the first migration even though subagents arrive in M7.
 * Adding it later would require rewriting every session query.
 */
export const Session = Schema.Struct({
  id: SessionID,
  parentID: Schema.optional(SessionID),
  title: Schema.String,
  directory: Schema.String,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})
export type Session = typeof Session.Type
