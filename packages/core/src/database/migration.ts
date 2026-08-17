import type { Database as BunDatabase } from "bun:sqlite"

export interface Migration {
  readonly name: string
  readonly statements: readonly string[]
}

/**
 * Migrations are handwritten SQL, applied in array order, recorded by name.
 * Never edit or reorder an entry that has shipped — append a new one instead.
 */
export const migrations: readonly Migration[] = [
  {
    name: "0000_initial",
    statements: [
      `CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        title TEXT NOT NULL,
        directory TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      )`,
      `CREATE INDEX session_parent_idx ON session (parent_id)`,
      `CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_completed INTEGER,
        provider_id TEXT,
        model_id TEXT,
        error TEXT
      )`,
      `CREATE INDEX message_session_idx ON message (session_id, id)`,
      `CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX part_message_idx ON part (message_id, id)`,
    ],
  },
  {
    // Token accounting. Nullable rather than DEFAULT 0: a turn that failed
    // before the provider reported usage genuinely has no counts, and zero is a
    // lie that overflow detection would go on to act upon.
    name: "0001_message_tokens",
    statements: [
      `ALTER TABLE message ADD COLUMN tokens_input INTEGER`,
      `ALTER TABLE message ADD COLUMN tokens_output INTEGER`,
      `ALTER TABLE message ADD COLUMN tokens_reasoning INTEGER`,
      `ALTER TABLE message ADD COLUMN tokens_cache_read INTEGER`,
      `ALTER TABLE message ADD COLUMN tokens_cache_write INTEGER`,
      `ALTER TABLE message ADD COLUMN tokens_total INTEGER`,
    ],
  },
]

export function migrate(db: BunDatabase) {
  db.run(`CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(
    db
      .query<{ name: string }, []>(`SELECT name FROM _migration`)
      .all()
      .map((row) => row.name),
  )
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue
    db.transaction(() => {
      for (const statement of migration.statements) db.run(statement)
      db.run(`INSERT INTO _migration (name, applied_at) VALUES (?, ?)`, [migration.name, Date.now()])
    })()
  }
}
