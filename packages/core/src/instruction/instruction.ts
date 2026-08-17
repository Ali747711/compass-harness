// Adapted from opencode (MIT).
// Sources: packages/opencode/src/session/instruction.ts:58-135 (resolution order),
//          packages/core/src/instruction-context.ts (upward walk, rendering)
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original: their System Context registry publishes these as a
// durable, epoch-versioned context source so an edit mid-conversation emits one
// update rather than resending the baseline — machinery that exists to preserve
// provider prompt caching. We have no epochs, so the files are read once per
// drain and prepended to the system prompt. Config-driven `instructions` globs
// and remote URLs are dropped; there is no config layer to read them from.

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * Project instruction filenames, in precedence order.
 *
 * The first name that matches anywhere up the tree wins outright and the rest
 * are not consulted. That is opencode's rule and it is deliberate: a repo with
 * both an `AGENTS.md` and a `CLAUDE.md` means one of them, not a concatenation
 * of both, and stacking them tends to produce contradictory instructions the
 * model then has to arbitrate.
 */
const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md"] as const

/**
 * Personal instructions that apply everywhere, first match only.
 *
 * `~/.claude/CLAUDE.md` is here because it is where people already keep this —
 * opencode reads it for the same reason, and it is the file that made compass
 * feel like it knew you the first time you ran theirs.
 */
const globalFiles = () => [join(homedir(), ".config", "compass", "AGENTS.md"), join(homedir(), ".claude", "CLAUDE.md")]

export interface InstructionFile {
  readonly path: string
  readonly content: string
}

/**
 * Real path where one exists, absolute otherwise.
 *
 * Load-bearing on macOS, where /var is a symlink to /private/var: the session
 * directory arrives as the user typed it while the project root has already
 * been resolved, and comparing the two spellings makes a directory look outside
 * its own project. The failure is silent — instructions are simply skipped —
 * which is exactly the kind that goes unnoticed.
 */
function real(path: string) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** True when `directory` is the project root or sits beneath it. */
function within(project: string, directory: string) {
  const rel = relative(project, directory)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Every occurrence of `name` from `start` up to and including `stop`.
 *
 * All of them, not just the nearest: a monorepo package's `AGENTS.md` refines
 * the root one rather than replacing it, and dropping the ancestor would lose
 * the rules that apply repo-wide.
 */
function walkUp(name: string, start: string, stop: string): string[] {
  const found: string[] = []
  let current = start
  for (;;) {
    const candidate = join(current, name)
    if (existsSync(candidate)) found.push(candidate)
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // Root-most first, so general rules are read before the ones that refine them.
  return found.reverse()
}

function readSafely(path: string): InstructionFile | undefined {
  try {
    const content = readFileSync(path, "utf-8")
    return content.trim().length === 0 ? undefined : { path, content }
  } catch {
    // Unreadable is treated as absent. A permissions error on someone else's
    // AGENTS.md should not stop the agent from running.
    return undefined
  }
}

/**
 * Instruction files that apply to a session, nearest-last.
 *
 * `COMPASS_NO_PROJECT_INSTRUCTIONS` skips the project walk, leaving only the
 * personal file — useful when running against a repository you do not trust.
 */
export function discover(input: { directory: string; project: string }): readonly InstructionFile[] {
  const paths: string[] = []

  for (const candidate of globalFiles()) {
    if (existsSync(candidate)) {
      paths.push(candidate)
      break
    }
  }

  const start = real(input.directory)
  const stop = real(input.project)
  const skip = process.env["COMPASS_NO_PROJECT_INSTRUCTIONS"] === "1"
  if (!skip && within(stop, start)) {
    for (const name of PROJECT_FILES) {
      const matches = walkUp(name, start, stop)
      if (matches.length > 0) {
        paths.push(...matches)
        break
      }
    }
  }

  const seen = new Set<string>()
  return paths
    .filter((path) => (seen.has(path) ? false : (seen.add(path), true)))
    .map(readSafely)
    .filter((file): file is InstructionFile => file !== undefined)
}

/**
 * Renders files for the system prompt.
 *
 * Each is labelled with its path so the model can say which rule it is
 * following, and so a contradiction between two files is attributable rather
 * than just confusing.
 */
export function render(files: readonly InstructionFile[]): string {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
