import { Schema } from "effect"
import { monotonicFactory } from "ulid"

/**
 * Monotonic so IDs generated within the same millisecond still sort correctly.
 * Message and part ordering depends on lexicographic ID sort, so this matters.
 */
const next = monotonicFactory()

export const SessionID = Schema.String.pipe(Schema.brand("SessionID"))
export type SessionID = typeof SessionID.Type
export const sessionID = () => SessionID.make(`ses_${next()}`)

export const MessageID = Schema.String.pipe(Schema.brand("MessageID"))
export type MessageID = typeof MessageID.Type
export const messageID = () => MessageID.make(`msg_${next()}`)

export const PartID = Schema.String.pipe(Schema.brand("PartID"))
export type PartID = typeof PartID.Type
export const partID = () => PartID.make(`prt_${next()}`)
