import {
  Message,
  MessageID,
  Part,
  PartID,
  Session,
  SessionID,
  messageID as newMessageID,
  sessionID as newSessionID,
} from "@compass/schema"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { MessageTable, PartTable, SessionTable } from "../database/schema.sql"

const decodePart = Schema.decodeUnknownSync(Part)
const encodePart = Schema.encodeSync(Part)

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  sessionID: SessionID,
}) {}

export interface Interface {
  readonly create: (input: { title: string; directory: string; parentID?: SessionID }) => Effect.Effect<Session>
  readonly get: (id: SessionID) => Effect.Effect<Session, SessionNotFound>
  readonly list: () => Effect.Effect<readonly Session[]>
  readonly appendMessage: (input: {
    sessionID: SessionID
    role: Message["role"]
    providerID?: string
    modelID?: string
  }) => Effect.Effect<Message>
  readonly completeMessage: (input: { id: MessageID; error?: string }) => Effect.Effect<void>
  readonly putPart: (part: Part) => Effect.Effect<void>
  readonly parts: (messageID: MessageID) => Effect.Effect<readonly Part[]>
  readonly messages: (sessionID: SessionID) => Effect.Effect<readonly { info: Message; parts: readonly Part[] }[]>
}

export class SessionStore extends Context.Tag("compass/SessionStore")<SessionStore, Interface>() {}

export const layer = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const { db } = yield* Database

    const toSession = (row: typeof SessionTable.$inferSelect): Session => ({
      id: SessionID.make(row.id),
      ...(row.parent_id === null ? {} : { parentID: SessionID.make(row.parent_id) }),
      title: row.title,
      directory: row.directory,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    })

    const toMessage = (row: typeof MessageTable.$inferSelect): Message => ({
      id: MessageID.make(row.id),
      sessionID: SessionID.make(row.session_id),
      role: row.role,
      timeCreated: row.time_created,
      ...(row.time_completed === null ? {} : { timeCompleted: row.time_completed }),
      ...(row.provider_id === null ? {} : { providerID: row.provider_id }),
      ...(row.model_id === null ? {} : { modelID: row.model_id }),
      ...(row.error === null ? {} : { error: row.error }),
    })

    const get: Interface["get"] = (id) =>
      Effect.sync(() => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()).pipe(
        Effect.flatMap((row) =>
          row === undefined ? new SessionNotFound({ sessionID: id }) : Effect.succeed(toSession(row)),
        ),
      )

    return SessionStore.of({
      create: (input) =>
        Effect.sync(() => {
          const now = Date.now()
          const session: Session = {
            id: newSessionID(),
            ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
            title: input.title,
            directory: input.directory,
            timeCreated: now,
            timeUpdated: now,
          }
          db.insert(SessionTable)
            .values({
              id: session.id,
              parent_id: session.parentID ?? null,
              title: session.title,
              directory: session.directory,
              time_created: session.timeCreated,
              time_updated: session.timeUpdated,
            })
            .run()
          return session
        }),

      get,

      list: () => Effect.sync(() => db.select().from(SessionTable).orderBy(asc(SessionTable.id)).all().map(toSession)),

      appendMessage: (input) =>
        Effect.sync(() => {
          const message: Message = {
            id: newMessageID(),
            sessionID: input.sessionID,
            role: input.role,
            timeCreated: Date.now(),
            ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
            ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
          }
          db.insert(MessageTable)
            .values({
              id: message.id,
              session_id: message.sessionID,
              role: message.role,
              time_created: message.timeCreated,
              provider_id: message.providerID ?? null,
              model_id: message.modelID ?? null,
            })
            .run()
          db.update(SessionTable)
            .set({ time_updated: message.timeCreated })
            .where(eq(SessionTable.id, input.sessionID))
            .run()
          return message
        }),

      completeMessage: (input) =>
        Effect.sync(() => {
          db.update(MessageTable)
            .set({ time_completed: Date.now(), error: input.error ?? null })
            .where(eq(MessageTable.id, input.id))
            .run()
        }),

      /** Upsert, because streaming parts are rewritten in place as deltas arrive. */
      putPart: (part) =>
        Effect.sync(() => {
          const row = {
            id: part.id,
            message_id: part.messageID,
            session_id: part.sessionID,
            type: part.type,
            data: JSON.stringify(encodePart(part)),
          }
          db.insert(PartTable).values(row).onConflictDoUpdate({ target: PartTable.id, set: row }).run()
        }),

      parts: (messageID) =>
        Effect.sync(() =>
          db
            .select()
            .from(PartTable)
            .where(eq(PartTable.message_id, messageID))
            .orderBy(asc(PartTable.id))
            .all()
            .map((row) => decodePart(JSON.parse(row.data))),
        ),

      messages: (sessionID) =>
        Effect.sync(() => {
          const rows = db
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.session_id, sessionID))
            .orderBy(asc(MessageTable.id))
            .all()
          const byMessage = new Map<string, Part[]>()
          for (const row of db
            .select()
            .from(PartTable)
            .where(eq(PartTable.session_id, sessionID))
            .orderBy(asc(PartTable.id))
            .all()) {
            const list = byMessage.get(row.message_id) ?? []
            list.push(decodePart(JSON.parse(row.data)))
            byMessage.set(row.message_id, list)
          }
          return rows.map((row) => ({ info: toMessage(row), parts: byMessage.get(row.id) ?? [] }))
        }),
    })
  }),
)

export { PartID }
