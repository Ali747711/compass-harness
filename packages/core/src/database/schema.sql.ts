import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Column names are snake_case so Drizzle derives them from the property name
 * and they never need restating as strings.
 */
export const SessionTable = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    parent_id: text(),
    title: text().notNull(),
    directory: text().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("session_parent_idx").on(table.parent_id)],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    role: text({ enum: ["user", "assistant"] }).notNull(),
    time_created: integer().notNull(),
    time_completed: integer(),
    provider_id: text(),
    model_id: text(),
    error: text(),
    // Nullable throughout: absent means the provider never reported usage, which
    // is different from a turn that genuinely used nothing.
    tokens_input: integer(),
    tokens_output: integer(),
    tokens_reasoning: integer(),
    tokens_cache_read: integer(),
    tokens_cache_write: integer(),
    tokens_total: integer(),
    finish: text(),
  },
  (table) => [index("message_session_idx").on(table.session_id, table.id)],
)

/**
 * Part payloads are stored as one JSON column rather than a wide table.
 * Parts are always read by message, never queried by their inner fields, so
 * columns would buy nothing and cost a migration every time a part type changes.
 */
export const PartTable = sqliteTable(
  "part",
  {
    id: text().primaryKey(),
    message_id: text().notNull(),
    session_id: text().notNull(),
    type: text().notNull(),
    data: text().notNull(),
  },
  (table) => [index("part_message_idx").on(table.message_id, table.id)],
)
