// Adapted from opencode (MIT). Source: packages/opencode/src/tool/edit.ts:1-216 and edit.txt
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// The ten fallback matching strategies live in ./edit-replacers. This file is only
// the wrapper: path resolution, line-ending/BOM preservation, and the unified diff
// the model gets back. opencode's LSP diagnostics, formatter and snapshot hooks are
// deliberately absent — those services do not exist in this harness yet.

import { readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { replace, trimDiff } from "./edit-replacers"
import { make, ToolFailure, type Context } from "./tool"

const DESCRIPTION = `Performs exact string replacements in an existing file.

Usage:
- Read the file with the \`read\` tool before editing it, in this conversation, so that \`oldString\` matches the bytes actually on disk. Editing from memory is the most common cause of a failed edit.
- \`oldString\` must reproduce the file EXACTLY: same whitespace, same indentation, same line endings. When copying out of \`read\` output, drop the line-number prefix (\`<number>: \`) — everything after that first space is real file content, and no part of the prefix belongs in \`oldString\` or \`newString\`.
- \`oldString\` must be unique in the file unless \`replaceAll\` is true. If it matches more than once the edit fails and nothing is written; add surrounding lines until the match is unique, or set \`replaceAll\`.
- Set \`replaceAll: true\` to apply the same substitution everywhere in the file — the right tool for renaming a variable or a symbol.
- \`newString\` must differ from \`oldString\`. Passing the same text twice is an error, not a no-op. To delete text, pass an empty \`newString\`.
- The file must already exist and \`oldString\` must be non-empty. Use \`write\` to create a new file or to intentionally replace a whole file.
- Edits are all-or-nothing. On failure the file is left byte-for-byte untouched and the error says how to recover, so fix the call rather than retrying it unchanged.
- Prefer editing an existing file over creating a new one. Preserve the file's existing style, indentation and line endings.
- Do not add comments narrating the edit, and only use emojis if the user explicitly asks for them.

Returns a unified diff of what changed.`

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
  const lines = text.split("\n")
  // A trailing newline yields a final empty element that would render as a bogus
  // context line; drop it rather than showing it.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
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

export const editTool = make({
  description: DESCRIPTION,
  input: InputSchema,
  permission: "edit",
  execute: (input: Input, context: Context) =>
    Effect.gen(function* () {
      if (context.abort.aborted) return yield* new ToolFailure({ message: "Edit aborted before it began." })
      if (input.filePath.trim() === "")
        return yield* new ToolFailure({ message: "filePath is required and cannot be empty." })

      const filePath = resolve(context.directory, input.filePath)
      const label = relative(context.directory, filePath) || filePath

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

      // node:fs rather than Bun.file().text(), which strips a leading BOM and would
      // therefore drop it from the file on write-back.
      const raw = yield* Effect.tryPromise({
        try: () => readFile(filePath, "utf-8"),
        catch: (cause) => new ToolFailure({ message: `Could not read ${filePath}: ${describe(cause)}` }),
      })

      const hasBom = raw.startsWith(BOM)
      const before = hasBom ? raw.slice(1) : raw
      const ending = detectLineEnding(before)

      // Match in the file's own line-ending space so a model that only ever sees
      // LF text can still edit a CRLF file.
      const oldString = fromLf(toLf(input.oldString), ending)
      const newString = fromLf(toLf(input.newString), ending)

      // These messages are tuned to tell the model how to recover; pass them through verbatim.
      const after = yield* Effect.try({
        try: () => replace(before, oldString, newString, input.replaceAll ?? false),
        catch: (cause) => new ToolFailure({ message: describe(cause) }),
      })

      if (context.abort.aborted) return yield* new ToolFailure({ message: "Edit aborted before it was written." })

      yield* Effect.tryPromise({
        try: () => Bun.write(filePath, hasBom ? BOM + after : after),
        catch: (cause) => new ToolFailure({ message: `Could not write ${filePath}: ${describe(cause)}` }),
      })

      const patch = unified(label, toLf(before), toLf(after))
      const summary = `Edited ${label} (+${patch.additions} -${patch.deletions})`

      return {
        title: label,
        output: patch.text === "" ? summary : `${summary}\n\n${patch.text}`,
        metadata: {
          filePath,
          diff: patch.text,
          additions: patch.additions,
          deletions: patch.deletions,
          replaceAll: input.replaceAll ?? false,
        },
      }
    }),
})
