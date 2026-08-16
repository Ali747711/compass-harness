import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { open } from "../src/database/database"

/**
 * Pragmas are easy to set and easy to lose. Enabling WAL silently rewrites
 * `synchronous`, and a pragma issued inside a transaction can be a no-op, so
 * these assert the values the database actually reports rather than the
 * statements we believe we ran.
 */
function pragmas(path: string) {
  const client = open(path)
  const read = (name: string) => Object.values(client.raw.query(`PRAGMA ${name}`).get() as object)[0]
  const values = {
    journal_mode: read("journal_mode"),
    synchronous: read("synchronous"),
    busy_timeout: read("busy_timeout"),
    foreign_keys: read("foreign_keys"),
  }
  client.raw.close()
  return values
}

describe("database pragmas", () => {
  test("a file database ends up with the settings we intend", () => {
    const dir = mkdtempSync(join(tmpdir(), "pragma-"))
    const values = pragmas(join(dir, "compass.db"))

    expect(values.journal_mode).toBe("wal")
    // 1 = NORMAL. Deliberate, and asserted because WAL sets it as a side effect:
    // if someone later reorders the pragmas, this pins the intent.
    expect(values.synchronous).toBe(1)
    // Must be non-zero, and must be set before WAL takes its exclusive lock.
    expect(values.busy_timeout).toBe(5000)
    expect(values.foreign_keys).toBe(1)

    rmSync(dir, { recursive: true, force: true })
  })

  test("foreign keys are enforced, so a bad reference fails loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "pragma-"))
    const client = open(join(dir, "compass.db"))
    client.raw.run(`CREATE TABLE parent (id TEXT PRIMARY KEY)`)
    client.raw.run(`CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id))`)
    expect(() => client.raw.run(`INSERT INTO child VALUES ('c', 'missing')`)).toThrow()
    client.raw.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("an in-memory database still applies migrations", () => {
    const client = open(":memory:")
    const tables = client.raw
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name)
    expect(tables).toContain("session")
    expect(tables).toContain("message")
    expect(tables).toContain("part")
    expect(tables).toContain("_migration")
    client.raw.close()
  })
})
