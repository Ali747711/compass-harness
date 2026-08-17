// Adapted from opencode (MIT). Source: packages/core/src/session/input.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original in one structural way: opencode is event-sourced,
// so their `admittedSeq` is the aggregate sequence of a durable
// `PromptAdmitted` event and admission means publishing it. We have no event
// log, so the sequence is a per-session counter allocated in the same
// transaction as the insert. The semantics that matter — admission is durable
// and precedes execution, promotion is a separate later act, pending means
// `promoted_seq IS NULL` — are unchanged.

import { Admitted, Delivery, Prompt, messageID as newMessageID, type MessageID, type SessionID } from "@compass/schema"
import { and, asc, eq, isNull, lte } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionInputTable } from "../database/schema.sql"

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted => ({
  id: row.id as MessageID,
  sessionID: row.session_id as SessionID,
  prompt: decodePrompt(JSON.parse(row.prompt)),
  delivery: row.delivery,
  admittedSeq: row.admitted_seq,
  ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  timeCreated: row.time_created,
})

export interface Interface {
  /**
   * Records a prompt durably. Returns the admitted record, including the
   * sequence that orders it against everything else in the session.
   */
  readonly admit: (input: { sessionID: SessionID; prompt: Prompt; delivery: Delivery }) => Effect.Effect<Admitted>
  /** Is there anything of this delivery kind still waiting? */
  readonly hasPending: (sessionID: SessionID, delivery: Delivery) => Effect.Effect<boolean>
  /**
   * Promotes every pending steer admitted at or before `cutoff`.
   *
   * The cutoff is what keeps this from swallowing its own tail: a steer that
   * arrives *while* the turn is being assembled belongs to the next boundary,
   * not this one, or a fast typist could keep a turn from ever starting.
   */
  readonly promoteSteers: (sessionID: SessionID, cutoff: number) => Effect.Effect<readonly Admitted[]>
  /** Promotes exactly one queued prompt — the oldest. Returns undefined when there is none. */
  readonly promoteNextQueued: (sessionID: SessionID) => Effect.Effect<Admitted | undefined>
  readonly find: (id: MessageID) => Effect.Effect<Admitted | undefined>
  readonly list: (sessionID: SessionID) => Effect.Effect<readonly Admitted[]>
}

export class SessionInput extends Context.Service<SessionInput, Interface>()("compass/SessionInput") {}

export const layer = Layer.effect(
  SessionInput,
  Effect.gen(function* () {
    const { db, raw } = yield* Database

    /**
     * Next sequence for a session.
     *
     * Read and insert happen inside one transaction so two concurrent admits
     * cannot both read the same maximum and collide. SQLite serializes writers,
     * so this is a cheap way to get a per-session monotonic counter without a
     * separate table.
     */
    const nextSeq = (sessionID: SessionID) => {
      const row = raw
        .query<{ next: number }, [string]>(
          `SELECT COALESCE(MAX(admitted_seq), 0) + 1 AS next FROM session_input WHERE session_id = ?`,
        )
        .get(sessionID)
      return row?.next ?? 1
    }

    const find: Interface["find"] = (id) =>
      Effect.sync(() => {
        const row = db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get()
        return row === undefined ? undefined : fromRow(row)
      })

    const promote = (rows: readonly (typeof SessionInputTable.$inferSelect)[], sessionID: SessionID) =>
      Effect.sync(() => {
        if (rows.length === 0) return []
        const promoted: Admitted[] = []
        raw.transaction(() => {
          let seq = nextSeq(sessionID)
          for (const row of rows) {
            // Guarded on promoted_seq still being null, so a concurrent promoter
            // cannot deliver the same prompt twice.
            const updated = db
              .update(SessionInputTable)
              .set({ promoted_seq: seq })
              .where(and(eq(SessionInputTable.id, row.id), isNull(SessionInputTable.promoted_seq)))
              .returning()
              .get()
            if (updated === undefined) continue
            promoted.push(fromRow(updated))
            seq++
          }
        })()
        return promoted
      })

    return SessionInput.of({
      admit: (input) =>
        Effect.sync(() => {
          const record = {
            id: newMessageID(),
            session_id: input.sessionID,
            prompt: JSON.stringify(encodePrompt(input.prompt)),
            delivery: input.delivery,
            time_created: Date.now(),
          }
          let seq = 0
          raw.transaction(() => {
            seq = nextSeq(input.sessionID)
            db.insert(SessionInputTable)
              .values({ ...record, admitted_seq: seq })
              .run()
          })()
          return {
            id: record.id,
            sessionID: input.sessionID,
            prompt: input.prompt,
            delivery: input.delivery,
            admittedSeq: seq,
            timeCreated: record.time_created,
          }
        }),

      hasPending: (sessionID, delivery) =>
        Effect.sync(
          () =>
            db
              .select({ id: SessionInputTable.id })
              .from(SessionInputTable)
              .where(
                and(
                  eq(SessionInputTable.session_id, sessionID),
                  isNull(SessionInputTable.promoted_seq),
                  eq(SessionInputTable.delivery, delivery),
                ),
              )
              .limit(1)
              .get() !== undefined,
        ),

      promoteSteers: (sessionID, cutoff) =>
        Effect.suspend(() =>
          promote(
            db
              .select()
              .from(SessionInputTable)
              .where(
                and(
                  eq(SessionInputTable.session_id, sessionID),
                  isNull(SessionInputTable.promoted_seq),
                  eq(SessionInputTable.delivery, "steer"),
                  lte(SessionInputTable.admitted_seq, cutoff),
                ),
              )
              .orderBy(asc(SessionInputTable.admitted_seq))
              .all(),
            sessionID,
          ),
        ),

      promoteNextQueued: (sessionID) =>
        Effect.suspend(() => {
          const row = db
            .select()
            .from(SessionInputTable)
            .where(
              and(
                eq(SessionInputTable.session_id, sessionID),
                isNull(SessionInputTable.promoted_seq),
                eq(SessionInputTable.delivery, "queue"),
              ),
            )
            .orderBy(asc(SessionInputTable.admitted_seq))
            .limit(1)
            .get()
          return row === undefined
            ? Effect.succeed(undefined)
            : promote([row], sessionID).pipe(Effect.map((promoted) => promoted.at(0)))
        }),

      find,

      list: (sessionID) =>
        Effect.sync(() =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.session_id, sessionID))
            .orderBy(asc(SessionInputTable.admitted_seq))
            .all()
            .map(fromRow),
        ),
    })
  }),
)
