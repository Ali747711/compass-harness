import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { migrate, migrations } from "../src/database/migration"

/**
 * Fresh databases are the easy case — every migration runs in order on an empty
 * file. The case that actually breaks in the field is the upgrade: a database
 * created before a migration shipped, carrying rows someone cares about.
 *
 * These build that state deliberately rather than trusting `migrate` to be
 * idempotent by inspection.
 */
const columns = (db: Database, table: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)

const applied = (db: Database) =>
  db
    .query<{ name: string }, []>(`SELECT name FROM _migration ORDER BY name`)
    .all()
    .map((row) => row.name)

/** A database as it stood after migration `upTo`, and no further. */
function frozenAt(upTo: number) {
  const db = new Database(":memory:")
  db.run(`CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  for (const migration of migrations.slice(0, upTo + 1)) {
    for (const statement of migration.statements) db.run(statement)
    db.run(`INSERT INTO _migration (name, applied_at) VALUES (?, ?)`, [migration.name, Date.now()])
  }
  return db
}

describe("migrations", () => {
  test("have unique names, since the name is the applied-marker", () => {
    const names = migrations.map((migration) => migration.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("apply in full to a fresh database", () => {
    const db = new Database(":memory:")
    migrate(db)
    expect(applied(db)).toEqual(migrations.map((m) => m.name).sort())
    db.close()
  })

  test("are skipped on a database that already has them", () => {
    const db = new Database(":memory:")
    migrate(db)
    // A second run must be a no-op rather than re-running CREATE TABLE.
    expect(() => migrate(db)).not.toThrow()
    expect(applied(db)).toEqual(migrations.map((m) => m.name).sort())
    db.close()
  })

  test("0001 adds the token columns to a database that predates it, without touching its rows", () => {
    const db = frozenAt(0)
    db.run(`INSERT INTO message (id, session_id, role, time_created) VALUES ('m1', 's1', 'assistant', 1)`)

    migrate(db)

    expect(columns(db, "message")).toEqual(
      expect.arrayContaining([
        "tokens_input",
        "tokens_output",
        "tokens_reasoning",
        "tokens_cache_read",
        "tokens_cache_write",
        "tokens_total",
      ]),
    )
    // The pre-existing turn reports no usage, which is true — it predates the
    // column. Backfilling zeroes would have made it look like a free turn.
    const row = db.query<{ id: string; tokens_input: number | null }, []>(`SELECT id, tokens_input FROM message`).get()
    expect(row).toEqual({ id: "m1", tokens_input: null })
    db.close()
  })
})
