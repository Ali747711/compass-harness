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

  // Order matters. `journal_mode = WAL` itself takes an exclusive lock, so the
  // timeout has to exist before it or a second process opening the same file
  // fails outright instead of waiting.
  //
  // 5s matches opencode. Note the cost while we are single-process: bun:sqlite
  // is synchronous on the one JS thread, so a contended write stalls every
  // fiber, including provider streaming, for up to that long. Revisit when M3
  // moves the server into a worker.
  raw.run("PRAGMA busy_timeout = 5000")
  // WAL keeps readers from blocking the writer, which matters once the server
  // and a foreground drain touch the same file.
  raw.run("PRAGMA journal_mode = WAL")
  // Set explicitly because enabling WAL silently drops synchronous from FULL to
  // NORMAL. NORMAL is the value we want and the one opencode chooses — durable
  // across process crash, and able to lose the last commit only on power loss —
  // but it should be a stated choice rather than a side effect of WAL.
  raw.run("PRAGMA synchronous = NORMAL")
  raw.run("PRAGMA cache_size = -64000")
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
