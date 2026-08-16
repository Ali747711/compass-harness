import { Schema } from "effect"

export const ProjectID = Schema.String.pipe(Schema.brand("ProjectID"))
export type ProjectID = typeof ProjectID.Type

export const WorkspaceID = Schema.String.pipe(Schema.brand("WorkspaceID"))
export type WorkspaceID = typeof WorkspaceID.Type

export const Vcs = Schema.Literals(["git"])
export type Vcs = typeof Vcs.Type

/** A project is the repository root a directory belongs to, or the directory itself. */
export const Project = Schema.Struct({
  id: ProjectID,
  directory: Schema.String,
  vcs: Schema.optionalKey(Vcs),
})
export type Project = typeof Project.Type

/**
 * Identifies a Location without resolving it. This is the lookup key for the
 * per-Location service graph.
 *
 * An omitted `workspaceID` means implicit-local placement. Explicit workspace
 * identity is reserved for future placement semantics.
 */
export const LocationRef = Schema.Struct({
  directory: Schema.String,
  workspaceID: Schema.optionalKey(WorkspaceID),
})
export type LocationRef = typeof LocationRef.Type

/** A resolved Location: the scoping unit for a project or worktree. */
export const Location = Schema.Struct({
  directory: Schema.String,
  workspaceID: Schema.optionalKey(WorkspaceID),
  project: Project,
})
export type Location = typeof Location.Type
