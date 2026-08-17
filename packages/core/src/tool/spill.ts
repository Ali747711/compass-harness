import { Effect } from "effect"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { contains } from "./path-guard"

/**
 * When a tool result is too large for the model, the overflow has to go
 * somewhere recoverable. Bounding alone discards it: the model is told text was
 * cut and has no way to get it back.
 *
 * The full text is written here and the bounded preview names the path, so a
 * model that actually needs the rest can `read` slices of it.
 *
 * Spill lives INSIDE the session directory on purpose. `read` resolves paths
 * through the workspace guard, so a file written outside would be immediately
 * unreadable by the one tool meant to recover it — and would additionally
 * trigger an `external_directory` permission prompt.
 */
export const SPILL_DIR = ".compass/tool-output"

/** Spill older than this is swept. Matches opencode's retention. */
export const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function spillRoot(directory: string) {
  return join(directory, SPILL_DIR)
}

/**
 * Only these characters may reach `join`. `callID` is the provider's
 * `toolCallId` — it crosses a trust boundary and is typed as a bare string, so
 * a `../` in it would otherwise place the spill file anywhere on disk.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/

function safeSegment(value: string) {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== ".."
}

/**
 * Returns the spill path, or undefined when the inputs would place it outside
 * the spill root. Two independent checks, because either alone has been the
 * source of real escapes: an allowlist on the segments, and a containment check
 * on the resolved result.
 */
export function spillPath(directory: string, sessionID: string, callID: string) {
  if (!safeSegment(sessionID) || !safeSegment(callID)) return undefined
  const root = spillRoot(directory)
  const path = join(root, sessionID, `${callID}.txt`)
  return contains(root, resolve(path)) ? path : undefined
}

/**
 * Writes the complete text and returns its absolute path, or undefined when the
 * write fails.
 *
 * Failure is deliberately not an error. The tool operation already succeeded;
 * turning it into a failure because a convenience file could not be written
 * would discard real work. The caller states the loss instead.
 */
export const write = Effect.fn("Spill.write")(function* (input: {
  readonly text: string
  readonly directory: string
  readonly sessionID: string
  readonly callID: string
}) {
  const path = spillPath(input.directory, input.sessionID, input.callID)
  if (path === undefined) return undefined
  return yield* Effect.tryPromise({
    try: async () => {
      await mkdir(join(spillRoot(input.directory), input.sessionID), { recursive: true })
      // Spill lands in whatever project the session runs in, and holds raw tool
      // output — file contents, shell stdout, fetched pages. Ignoring it from
      // inside means every project is protected, not just ones we know about.
      await writeFile(join(spillRoot(input.directory), ".gitignore"), "*\n", "utf8")
      await writeFile(path, input.text, "utf8")
      return path
    },
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
})

/** Removes one session's spill. Called when a session ends. */
export const clear = Effect.fn("Spill.clear")(function* (directory: string, sessionID: string) {
  if (!safeSegment(sessionID)) return
  yield* remove(join(spillRoot(directory), sessionID))
})

/** Never fails through any channel, including defects. */
const remove = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { recursive: true, force: true }),
    catch: () => undefined,
  }).pipe(Effect.ignore)

/**
 * Removes spill directories past the retention window. Best effort — a sweep
 * failure is never worth failing a session over.
 */
export const sweep = Effect.fn("Spill.sweep")(function* (directory: string, now = Date.now()) {
  const root = spillRoot(directory)
  const entries = yield* Effect.tryPromise({
    try: () => readdir(root),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed([] as string[])))

  let removed = 0
  for (const entry of entries) {
    const path = join(root, entry)
    const stale = yield* Effect.tryPromise({
      try: async () => now - (await stat(path)).mtimeMs > SPILL_MAX_AGE_MS,
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!stale) continue
    yield* remove(path)
    removed++
  }
  return removed
})

export * as Spill from "./spill"
