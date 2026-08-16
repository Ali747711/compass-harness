import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { Context, Effect, Layer } from "effect"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { migrate } from "./migration"
import * as tables from "./schema.sql"

export function defaultPath() {
  return process.env["COMPASS_DB"] ?? join(homedir(), ".local", "share", "compass", "compass.db")
}

export interface Client {
  readonly db: BunSQLiteDatabase<typeof tables>
  readonly raw: BunDatabase
}

export function open(path: string): Client {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const raw = new BunDatabase(path, { create: true })
  // WAL keeps readers from blocking the writer, which matters once the server
  // and a foreground drain touch the same file.
  raw.run("PRAGMA journal_mode = WAL")
  raw.run("PRAGMA foreign_keys = ON")
  migrate(raw)
  return { raw, db: drizzle(raw, { schema: tables }) }
}

export class Database extends Context.Service<Database, Client>()("compass/Database") {}

export const layer = (path: string) =>
  Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => open(path)),
      (client) => Effect.sync(() => client.raw.close()),
    ),
  )

/** Resolves the path lazily so COMPASS_DB can be set after module load. */
export const layerDefault = Layer.unwrap(Effect.sync(() => layer(defaultPath())))

/** In-memory instance for tests. Prefer this over mocking the database. */
export const layerMemory = layer(":memory:")
