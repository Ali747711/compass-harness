// Adapted from opencode (MIT). Source: packages/opencode/src/tool/edit.ts:1-216 and edit.txt
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// The ten fallback matching strategies live in ./edit-replacers. This file is only
// the wrapper: path resolution, per-file locking, line-ending/BOM preservation, the
// atomic write, and the unified diff the model gets back. opencode's LSP diagnostics,
// formatter and snapshot hooks are deliberately absent — those services do not exist
// in this harness yet.

import { access, constants, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { Effect, Schema, Semaphore } from "effect"
import { replace, trimDiff } from "./edit-replacers"
import { resolveWithin } from "./path-guard"
import { make, ToolFailure, type Context } from "./tool"
import DESCRIPTION from "./edit.txt"

const InputSchema = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "Path to the file to modify. Absolute, or relative to the session working directory.",
  }),
  oldString: Schema.String.annotate({
    description: "The exact text to replace, copied verbatim from the file including indentation.",
  }),
  newString: Schema.String.annotate({
    description: "The text to replace it with. Must differ from oldString; empty deletes the matched text.",
  }),
  replaceAll: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Replace every occurrence of oldString instead of requiring a unique match. Defaults to false.",
    }),
  ),
})

type Input = typeof InputSchema.Type

const BOM = "\u{FEFF}"
const CONTEXT_LINES = 3
// Past this the O(n*m) LCS table costs more than an exact diff is worth, so the
// changed span is reported as one delete/insert pair instead.
const MAX_DIFF_CELLS = 4_000_000
// git's marker, emitted as a pseudo-line so that gaining or losing the final
// newline is a visible change instead of an invisible one.
const NO_NEWLINE = "\\ No newline at end of file"

type Kind = "equal" | "add" | "remove"

const MARK: Record<Kind, string> = { equal: " ", add: "+", remove: "-" }

interface Change {
  readonly kind: Kind
  readonly text: string
}

interface Entry extends Change {
  readonly oldNo: number
  readonly newNo: number
}

interface Patch {
  readonly text: string
  readonly additions: number
  readonly deletions: number
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined

const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")

const toLf = (text: string) => text.replaceAll("\r\n", "\n")

const fromLf = (text: string, ending: "\n" | "\r\n") => (ending === "\n" ? text : text.replaceAll("\n", "\r\n"))

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  // A trailing newline yields a final empty element that would render as a bogus
  // context line, so drop it. Text that does NOT end in one carries an explicit
  // marker instead: without it "a\nb\n" and "a\nb" diff as identical and a real
  // write is reported to the model as a no-op.
  if (lines[lines.length - 1] === "") {
    lines.pop()
    return lines
  }
  return [...lines, NO_NEWLINE]
}

function middle(before: readonly string[], after: readonly string[]): Change[] {
  if (before.length === 0) return after.map((text): Change => ({ kind: "add", text }))
  if (after.length === 0) return before.map((text): Change => ({ kind: "remove", text }))
  if (before.length * after.length > MAX_DIFF_CELLS)
    return [
      ...before.map((text): Change => ({ kind: "remove", text })),
      ...after.map((text): Change => ({ kind: "add", text })),
    ]

  const cols = after.length + 1
  const table = new Uint32Array((before.length + 1) * cols)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        before[i] === after[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0)
    }
  }

  const out: Change[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    const left = before[i] ?? ""
    const right = after[j] ?? ""
    if (left === right) {
      out.push({ kind: "equal", text: left })
      i++
      j++
      continue
    }
    if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      out.push({ kind: "remove", text: left })
      i++
      continue
    }
    out.push({ kind: "add", text: right })
    j++
  }
  for (const text of before.slice(i)) out.push({ kind: "remove", text })
  for (const text of after.slice(j)) out.push({ kind: "add", text })
  return out
}

function changes(before: readonly string[], after: readonly string[]): Change[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  return [
    ...before.slice(0, start).map((text): Change => ({ kind: "equal", text })),
    ...middle(before.slice(start, endBefore), after.slice(start, endAfter)),
    ...before.slice(endBefore).map((text): Change => ({ kind: "equal", text })),
  ]
}

function numbered(list: readonly Change[]): Entry[] {
  const out: Entry[] = []
  let oldNo = 0
  let newNo = 0
  for (const change of list) {
    if (change.kind !== "add") oldNo++
    if (change.kind !== "remove") newNo++
    out.push({ ...change, oldNo, newNo })
  }
  return out
}

/** Index ranges covering each changed entry plus CONTEXT_LINES either side, merged when they touch. */
function ranges(entries: readonly Entry[]): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = []
  for (let index = 0; index < entries.length; index++) {
    if (entries[index]?.kind === "equal") continue
    const from = Math.max(0, index - CONTEXT_LINES)
    const to = Math.min(entries.length - 1, index + CONTEXT_LINES)
    const last = out[out.length - 1]
    if (last && from <= last[1] + 1) {
      out[out.length - 1] = [last[0], Math.max(last[1], to)]
      continue
    }
    out.push([from, to])
  }
  return out
}

function unified(label: string, before: string, after: string): Patch {
  const entries = numbered(changes(splitLines(before), splitLines(after)))
  const additions = entries.filter((entry) => entry.kind === "add").length
  const deletions = entries.filter((entry) => entry.kind === "remove").length

  const hunks = ranges(entries).map((range) => {
    const hunk = entries.slice(range[0], range[1] + 1)
    const olds = hunk.filter((entry) => entry.kind !== "add")
    const news = hunk.filter((entry) => entry.kind !== "remove")
    const header = `@@ -${olds[0]?.oldNo ?? 0},${olds.length} +${news[0]?.newNo ?? 0},${news.length} @@`
    return [header, ...hunk.map((entry) => `${MARK[entry.kind]}${entry.text}`)].join("\n")
  })

  if (hunks.length === 0) return { text: "", additions, deletions }
  return { text: trimDiff([`--- ${label}`, `+++ ${label}`, ...hunks].join("\n")), additions, deletions }
}

// An edit is a read-modify-write spanning several awaits. Two edits to one file
// would otherwise both read the original and the later write would silently drop
// the earlier one, so every path gets its own gate.
const locks = new Map<string, Semaphore.Semaphore>()

function lockFor(filePath: string): Semaphore.Semaphore {
  const hit = locks.get(filePath)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(filePath, next)
  return next
}

const noop = () => undefined

/** Best effort: a leftover temp file must not mask the failure that stranded it. */
const discard = (temp: string) => Effect.promise(() => rm(temp, { force: true }).then(noop, noop))

/**
 * Writes beside the original and renames over it. rename(2) is atomic, so a
 * failure, a full disk or an interruption leaves the previous bytes intact —
 * which is what the description promises.
 */
const writeAtomically = (filePath: string, content: string, mode: number) =>
  Effect.gen(function* () {
    // Edit the symlink's target rather than replacing the link with a regular file.
    const target = yield* Effect.tryPromise({
      try: () => realpath(filePath),
      catch: (cause) => new ToolFailure({ message: `Could not resolve ${filePath}: ${describe(cause)}` }),
    })

    // rename(2) ignores the target's own permissions, so ask first: a read-only
    // file must stay read-only rather than being quietly replaced.
    yield* Effect.tryPromise({
      try: () => access(target, constants.W_OK),
      catch: () => new ToolFailure({ message: `${filePath} is not writable, so no changes were made.` }),
    })

    const temp = join(dirname(target), `.${basename(target)}.${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
    yield* Effect.tryPromise({
      try: () => writeFile(temp, content, { encoding: "utf-8", mode: mode & 0o777 }),
      catch: (cause) => new ToolFailure({ message: `Could not write ${filePath}: ${describe(cause)}` }),
    }).pipe(Effect.onError(() => discard(temp)))

    yield* Effect.tryPromise({
      try: () => rename(temp, target),
      catch: (cause) => new ToolFailure({ message: `Could not replace ${filePath}: ${describe(cause)}` }),
    }).pipe(Effect.onError(() => discard(temp)))
  })

const apply = (input: Input, context: Context, filePath: string, label: string) =>
  Effect.gen(function* () {
    const info = yield* Effect.tryPromise({
      try: () => stat(filePath),
      catch: (cause) =>
        new ToolFailure({
          message:
            codeOf(cause) === "ENOENT"
              ? `File not found: ${filePath}. Check the path, or use write to create it.`
              : `Could not stat ${filePath}: ${describe(cause)}`,
        }),
    })
    if (info.isDirectory()) return yield* new ToolFailure({ message: `Path is a directory, not a file: ${filePath}` })
    if (context.abort.aborted) return yield* new ToolFailure({ message: "Edit aborted before the file was read." })

    // node:fs rather than Bun.file().text(), which strips a leading BOM and would
    // therefore drop it from the file on write-back.
    const raw = yield* Effect.tryPromise({
      try: () => readFile(filePath, "utf-8"),
      catch: (cause) => new ToolFailure({ message: `Could not read ${filePath}: ${describe(cause)}` }),
    })
    if (context.abort.aborted) return yield* new ToolFailure({ message: "Edit aborted before it was applied." })

    const hasBom = raw.startsWith(BOM)
    const before = hasBom ? raw.slice(1) : raw
    const ending = detectLineEnding(before)

    // Match in the file's own line-ending space so a model that only ever sees
    // LF text can still edit a CRLF file.
    const oldString = fromLf(toLf(input.oldString), ending)
    const newString = fromLf(toLf(input.newString), ending)

    // These messages are tuned to tell the model how to recover; pass them through verbatim.
    const replaced = yield* Effect.try({
      try: () => replace(before, oldString, newString, input.replaceAll ?? false),
      catch: (cause) => new ToolFailure({ message: describe(cause) }),
    })

    // A newString that reintroduces the BOM must not stack a second one when the
    // file's own mark is put back below.
    const after = hasBom && replaced.startsWith(BOM) ? replaced.slice(1) : replaced
    const next = hasBom ? BOM + after : after

    // The fallback replacers substitute a fuzzy span, not the literal oldString, so
    // the only trustworthy comparison is the file's bytes before against after.
    if (next === raw)
      return {
        title: label,
        output:
          `No change to ${label}: the span that matched is already byte-for-byte identical to newString, ` +
          `so nothing was written. Re-read the file — the edit you intended may already be applied, or ` +
          `oldString may have matched somewhere you did not mean.`,
        metadata: {
          filePath,
          diff: "",
          additions: 0,
          deletions: 0,
          replaceAll: input.replaceAll ?? false,
          changed: false,
        },
      }

    if (context.abort.aborted) return yield* new ToolFailure({ message: "Edit aborted before it was written." })

    yield* writeAtomically(filePath, next, info.mode)

    const patch = unified(label, toLf(before), toLf(after))
    const summary = `Edited ${label} (+${patch.additions} -${patch.deletions})`
    // The diff is computed on LF-normalized text, so an empty patch after a real
    // write means the bytes differ only in line endings. Say which, rather than
    // printing a bare "+0 -0" that reads like nothing happened.
    const detail =
      patch.text === ""
        ? `${summary}\nOnly line endings changed; no line content differs.`
        : `${summary}\n\n${patch.text}`

    return {
      title: label,
      output: detail,
      metadata: {
        filePath,
        diff: patch.text,
        additions: patch.additions,
        deletions: patch.deletions,
        replaceAll: input.replaceAll ?? false,
        changed: true,
      },
    }
  })

export const editTool = make({
  description: DESCRIPTION,
  input: InputSchema,
  permission: "edit",
  execute: (input: Input, context: Context) =>
    Effect.gen(function* () {
      if (context.abort.aborted) return yield* new ToolFailure({ message: "Edit aborted before it began." })
      if (input.filePath.trim() === "")
        return yield* new ToolFailure({ message: "filePath is required and cannot be empty." })

      const filePath = yield* resolveWithin(context, input.filePath)
      const label = relative(context.directory, filePath) || filePath

      return yield* lockFor(filePath).withPermit(apply(input, context, filePath, label))
    }),
})
