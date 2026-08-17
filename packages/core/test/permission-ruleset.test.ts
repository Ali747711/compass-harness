import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Permission, PermissionDenied, layerRuleset, type Request } from "../src/permission/permission"
import { deriveSubagentRuleset, evaluate, match, type Ruleset } from "../src/permission/ruleset"

const allow = (permission: string, pattern = "*") => ({ permission, pattern, action: "allow" as const })
const deny = (permission: string, pattern = "*") => ({ permission, pattern, action: "deny" as const })

describe("match", () => {
  test("matches literally and by wildcard", () => {
    expect(match("bash", "bash")).toBe(true)
    expect(match("bash", "*")).toBe(true)
    expect(match("bash", "edit")).toBe(false)
  })

  test("treats path separators uniformly", () => {
    expect(match("src/a.ts", "src/*")).toBe(true)
    expect(match("src\\a.ts", "src/*")).toBe(true)
  })

  /** So `git *` covers a bare `git`, instead of every rule needing writing twice. */
  test("a trailing ' *' also matches the bare command", () => {
    expect(match("git", "git *")).toBe(true)
    expect(match("git status", "git *")).toBe(true)
    expect(match("gitk", "git *")).toBe(false)
  })

  test("does not let a regex metacharacter in the pattern run wild", () => {
    expect(match("a.ts", "a.ts")).toBe(true)
    expect(match("axts", "a.ts")).toBe(false)
  })
})

describe("evaluate", () => {
  /** Unlisted is a decision to make, not an assumption to grant. */
  test("defaults to ask when nothing matches", () => {
    expect(evaluate("bash", "rm -rf /", []).action).toBe("ask")
  })

  test("the last matching rule wins, so a later rule overrides an earlier one", () => {
    const ruleset: Ruleset = [allow("bash"), deny("bash", "rm *")]
    expect(evaluate("bash", "ls", ruleset).action).toBe("allow")
    expect(evaluate("bash", "rm -rf /", ruleset).action).toBe("deny")
  })

  test("composes rulesets left to right", () => {
    expect(evaluate("bash", "ls", [deny("bash")], [allow("bash")]).action).toBe("allow")
    expect(evaluate("bash", "ls", [allow("bash")], [deny("bash")]).action).toBe("deny")
  })
})

describe("deriveSubagentRuleset", () => {
  /**
   * The invariant the whole function exists for. A permissive subagent
   * definition must not be a way out of a restricted parent.
   */
  test("a parent deny survives a child that allows the same thing", () => {
    const derived = deriveSubagentRuleset({
      parent: [deny("bash", "rm *")],
      subagent: [allow("bash")],
    })
    expect(evaluate("bash", "rm -rf /", derived).action).toBe("deny")
    // ...while everything the child was allowed still works.
    expect(evaluate("bash", "ls", derived).action).toBe("allow")
  })

  /**
   * Deliberately asymmetric. Parent allows govern the parent agent, not
   * whatever it spawns — inheriting them would let a permissive parent silently
   * widen every child.
   */
  test("a parent allow does not flow down to the child", () => {
    const derived = deriveSubagentRuleset({ parent: [allow("bash")], subagent: [] })
    expect(evaluate("bash", "ls", derived).action).toBe("ask")
  })

  test("external_directory rules are inherited whatever their action", () => {
    const derived = deriveSubagentRuleset({
      parent: [allow("external_directory", "/tmp/*")],
      subagent: [],
    })
    expect(evaluate("external_directory", "/tmp/x", derived).action).toBe("allow")
  })

  /** A subagent that can spawn subagents turns bounded delegation into unbounded. */
  test("denies task unless the child's own ruleset names it", () => {
    expect(evaluate("task", "*", deriveSubagentRuleset({ parent: [], subagent: [] })).action).toBe("deny")
    const permitted = deriveSubagentRuleset({ parent: [], subagent: [allow("task")] })
    expect(evaluate("task", "*", permitted).action).toBe("allow")
  })

  test("denies todowrite unless the child's own ruleset names it", () => {
    expect(evaluate("todowrite", "*", deriveSubagentRuleset({ parent: [], subagent: [] })).action).toBe("deny")
  })

  /** A forced deny is a default, not an override — a parent deny still outranks it. */
  test("a parent deny still applies to a child that permitted task", () => {
    const derived = deriveSubagentRuleset({ parent: [deny("task")], subagent: [allow("task")] })
    expect(evaluate("task", "*", derived).action).toBe("deny")
  })
})

describe("layerRuleset", () => {
  const run = (ruleset: Ruleset, request: Request, onAsk?: (r: Request) => Effect.Effect<boolean>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const permission = yield* Permission
        return yield* permission.ask(request).pipe(Effect.result)
      }).pipe(
        Effect.provide(layerRuleset({ ruleset, ...(onAsk === undefined ? {} : { onAsk: (r: Request) => onAsk(r) }) })),
        Effect.scoped,
      ) as Effect.Effect<{ _tag: string }>,
    )

  test("grants an allowed action", async () => {
    const result = await run([allow("bash")], { permission: "bash", patterns: ["ls"] })
    expect(result._tag).toBe("Success")
  })

  test("refuses a denied action", async () => {
    const result = await run([deny("bash")], { permission: "bash", patterns: ["ls"] })
    expect(result._tag).toBe("Failure")
  })

  /** A write touching two paths, one forbidden, is a forbidden write. */
  test("one denied pattern denies the whole request", async () => {
    const ruleset = [allow("edit"), deny("edit", "/etc/*")]
    const result = await run([...ruleset], { permission: "edit", patterns: ["src/a.ts", "/etc/passwd"] })
    expect(result._tag).toBe("Failure")
  })

  test("grants an unmatched action, since there is nobody to ask yet", async () => {
    const result = await run([], { permission: "bash", patterns: ["ls"] })
    expect(result._tag).toBe("Success")
  })

  test("defers to onAsk when one is supplied, and honours a refusal", async () => {
    const asked: string[] = []
    const result = await run([], { permission: "bash", patterns: ["rm -rf /"] }, (request) => {
      asked.push(request.permission)
      return Effect.succeed(false)
    })
    expect(asked).toEqual(["bash"])
    expect(result._tag).toBe("Failure")
  })

  test("names the offending pattern when it refuses", async () => {
    const denied = await Effect.runPromise(
      Effect.gen(function* () {
        const permission = yield* Permission
        return yield* permission.ask({ permission: "bash", patterns: ["rm -rf /"] }).pipe(Effect.flip)
      }).pipe(
        Effect.provide(layerRuleset({ ruleset: [deny("bash")] })),
        Effect.scoped,
      ) as Effect.Effect<PermissionDenied>,
    )
    expect(denied.message).toContain("rm -rf /")
  })
})
