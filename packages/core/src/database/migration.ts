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
  {
    // Why the provider stopped. Without it a reply truncated at the output limit
    // is indistinguishable from a complete one, both in the record and at the
    // moment the loop decides whether to continue.
    name: "0002_message_finish",
    statements: [`ALTER TABLE message ADD COLUMN finish TEXT`],
  },
  {
    // Durable prompt admission. A prompt is recorded here before any provider
    // work begins, so a crash between "the user asked" and "the model was
    // called" loses nothing.
    //
    // `promoted_seq NULL` means pending; setting it is what marks the prompt
    // delivered. Both sequences are per-session and monotonic, which is what
    // lets "every steer admitted before this turn started" be a range query
    // rather than a timestamp comparison.
    name: "0003_session_input",
    statements: [
      `CREATE TABLE session_input (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        delivery TEXT NOT NULL,
        admitted_seq INTEGER NOT NULL,
        promoted_seq INTEGER,
        time_created INTEGER NOT NULL
      )`,
      // Ordered to serve the only hot query: pending inputs of one delivery for
      // one session, oldest first.
      `CREATE INDEX session_input_pending_idx
         ON session_input (session_id, promoted_seq, delivery, admitted_seq)`,
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
