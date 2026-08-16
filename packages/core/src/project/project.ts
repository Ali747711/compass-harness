import { ProjectID, type Project as ProjectInfo } from "@compass/schema/location"
import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export interface Interface {
  /** Resolves a directory to the project that contains it. Never fails: a
   *  directory outside any repository is its own project. */
  readonly resolve: (directory: string) => Effect.Effect<ProjectInfo>
}

export class Project extends Context.Service<Project, Interface>()("compass/Project") {}

/**
 * Stable across runs and machines-independent of mount point casing, so the same
 * checkout always gets the same project id.
 */
function identify(directory: string) {
  return ProjectID.make(`prj_${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`)
}

/** Walks up looking for a repository root. A `.git` file (not directory) is a worktree. */
function findRoot(start: string) {
  let current = start
  for (;;) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function resolveProject(directory: string): ProjectInfo {
  const absolute = realOrAbsolute(directory)
  const root = findRoot(absolute)
  if (root === undefined) return { id: identify(absolute), directory: absolute }
  return { id: identify(root), directory: root, vcs: "git" }
}

function realOrAbsolute(directory: string) {
  const absolute = resolve(directory)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export const layer = Layer.sync(Project, () =>
  Project.of({
    resolve: (directory) => Effect.sync(() => resolveProject(directory)),
  }),
)

export * as ProjectModule from "./project"
