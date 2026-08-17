import { Schema } from "effect"
import { MessageID, SessionID } from "./id"

/**
 * When an admitted prompt is allowed to reach the model.
 *
 * `steer` promotes at the next safe turn boundary while the session is still
 * working — it redirects work in progress. `queue` waits for the session to go
 * idle, and then exactly one promotes.
 *
 * The distinction is the whole point of admission being separate from
 * execution: "actually, use the other file" must land mid-run, while "now do
 * the next thing" must not interleave with the thing already running.
 */
export const Delivery = Schema.Literals(["steer", "queue"])
export type Delivery = typeof Delivery.Type

/** What the user actually asked for. JSON-encoded, so parts can be added without a migration. */
export const Prompt = Schema.Struct({
  text: Schema.String,
  model: Schema.optionalKey(Schema.String),
})
export type Prompt = typeof Prompt.Type

/**
 * A prompt that has been durably recorded but may not yet have been sent.
 *
 * `promotedSeq` absent means still pending. Sequences are per-session and
 * monotonic, which is what makes "promote every steer admitted before this
 * turn started" expressible without a clock.
 */
export const Admitted = Schema.Struct({
  id: MessageID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  admittedSeq: Schema.Number,
  promotedSeq: Schema.optionalKey(Schema.Number),
  timeCreated: Schema.Number,
})
export type Admitted = typeof Admitted.Type
