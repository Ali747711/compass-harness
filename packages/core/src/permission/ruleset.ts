// Ported from opencode (MIT).
// Sources: packages/core/src/util/wildcard.ts (matcher),
//          packages/opencode/src/permission/index.ts:28-38 (evaluate),
//          packages/opencode/src/agent/subagent-permissions.ts (derivation)
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt

export type Action = "allow" | "deny" | "ask"

export interface Rule {
  /** Action name, or a wildcard over them. `bash`, `edit`, `*`. */
  readonly permission: string
  /** What the action is being taken against — a path glob, a command prefix. */
  readonly pattern: string
  readonly action: Action
}

export type Ruleset = readonly Rule[]

/**
 * Glob matching, copied verbatim.
 *
 * The trailing-space case is the non-obvious part: a pattern ending `" *"` also
 * matches the bare command, so `git *` covers plain `git`. Without it every
 * rule needs writing twice.
 */
export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

/**
 * The rule governing an action, or `ask` when nothing matches.
 *
 * `findLast`, so later rules win — rulesets are composed least-specific first
 * and a caller appends to override. Defaulting to `ask` rather than `allow` is
 * what makes an unlisted action a decision rather than an assumption.
 */
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return (
    rulesets.flat().findLast((rule) => match(permission, rule.permission) && match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

/**
 * The ruleset a subagent's session runs under. Ported verbatim in substance.
 *
 * The asymmetry is the whole point and is easy to get backwards. The child
 * inherits the parent's **deny** rules and its `external_directory` rules, and
 * nothing else. Parent *allows* deliberately do not flow down: they govern what
 * the parent agent may do, not what anything it spawns may do. Inheriting them
 * would mean a permissive parent silently widens every child.
 *
 * `todowrite` and `task` are denied unless the subagent's own ruleset names
 * them — the first because a child scribbling on the parent's todo list is
 * confusing rather than useful, the second because a subagent that can spawn
 * subagents is how a bounded delegation becomes an unbounded one.
 */
export function deriveSubagentRuleset(input: { parent: Ruleset; subagent: Ruleset }): Ruleset {
  const canTask = input.subagent.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.some((rule) => rule.permission === "todowrite")
  return [
    // The child's own capabilities go first, because `evaluate` takes the last
    // match — so everything after this line overrides them. opencode keeps the
    // subagent's ruleset out of this array entirely and passes it to `evaluate`
    // as a separate argument; folding it in here reaches the same result with
    // one ruleset to reason about, provided the order is this way round.
    ...input.subagent,
    // A parent deny is final. Appended after the child's rules precisely so it
    // wins: otherwise a permissive subagent definition is a way to escape a
    // restricted parent, which is the failure this function exists to prevent.
    ...input.parent.filter((rule) => rule.permission === "external_directory" || rule.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" } as const]),
    ...(canTask ? [] : [{ permission: "task", pattern: "*", action: "deny" } as const]),
  ]
}
