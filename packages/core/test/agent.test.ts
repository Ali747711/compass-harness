import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agents, find, parseAgentFile } from "../src/agent/agent"
import { deriveSubagentRuleset, evaluate } from "../src/permission/ruleset"
import { messageID, sessionID } from "@compass/schema"
import { task } from "../src/tool/task"
import { ToolFailure, type Context } from "../src/tool/tool"

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "compass-agent-")))

describe("built-in agents", () => {
  /**
   * Read-only by rule, not by request. Telling a model not to edit is a
   * suggestion; denying `edit` and `write` is what makes delegating a search
   * something you can rely on.
   */
  test("explore cannot edit or write, whatever it is told", () => {
    const explore = find(temp(), "explore")
    expect(explore).toBeDefined()
    expect(evaluate("edit", "any.ts", explore!.permission).action).toBe("deny")
    expect(evaluate("write", "any.ts", explore!.permission).action).toBe("deny")
    expect(evaluate("read", "any.ts", explore!.permission).action).toBe("allow")
  })

  test("that denial survives derivation into a child session", () => {
    const explore = find(temp(), "explore")!
    const derived = deriveSubagentRuleset({ parent: [], subagent: explore.permission })
    expect(evaluate("edit", "any.ts", derived).action).toBe("deny")
  })

  test("neither built-in may spawn another agent", () => {
    for (const name of ["explore", "general"]) {
      const agent = find(temp(), name)!
      const derived = deriveSubagentRuleset({ parent: [], subagent: agent.permission })
      expect(evaluate("task", "*", derived).action).toBe("deny")
    }
  })
})

describe("parseAgentFile", () => {
  test("splits frontmatter from the prompt body", () => {
    const agent = parseAgentFile(
      "reviewer",
      ["---", "description: Reviews a diff", "---", "You review code.", "Be specific."].join("\n"),
    )
    expect(agent.description).toBe("Reviews a diff")
    expect(agent.prompt).toBe("You review code.\nBe specific.")
  })

  test("reads permission rules out of the frontmatter", () => {
    const agent = parseAgentFile(
      "reviewer",
      ["---", "description: Reviews", "permission:", "  edit: deny", "  bash: allow", "---", "body"].join("\n"),
    )
    expect(evaluate("edit", "x", agent.permission).action).toBe("deny")
    expect(evaluate("bash", "x", agent.permission).action).toBe("allow")
  })

  /** A malformed file should cost its own definition, not the session. */
  test("treats a file with no frontmatter as all prompt", () => {
    const agent = parseAgentFile("plain", "just a prompt")
    expect(agent.prompt).toBe("just a prompt")
    expect(agent.description).toContain("plain")
    expect(agent.permission).toEqual([])
  })

  test("strips quotes from a quoted description", () => {
    const agent = parseAgentFile("x", ["---", 'description: "Quoted thing"', "---", "body"].join("\n"))
    expect(agent.description).toBe("Quoted thing")
  })
})

describe("discovery", () => {
  test("finds definitions in .compass/agent and lists them alongside the built-ins", () => {
    const project = temp()
    mkdirSync(join(project, ".compass", "agent"), { recursive: true })
    writeFileSync(
      join(project, ".compass", "agent", "reviewer.md"),
      ["---", "description: Reviews a diff", "---", "You review code."].join("\n"),
    )

    const names = agents(project).map((agent) => agent.name)
    expect(names).toContain("reviewer")
    expect(names).toContain("explore")
    rmSync(project, { recursive: true, force: true })
  })

  /** Adding or reshaping an agent should cost no code — that is the point of the format. */
  test("a project definition overrides a built-in of the same name", () => {
    const project = temp()
    mkdirSync(join(project, ".compass", "agent"), { recursive: true })
    writeFileSync(
      join(project, ".compass", "agent", "explore.md"),
      ["---", "description: Our own explorer", "---", "Do it our way."].join("\n"),
    )

    expect(find(project, "explore")?.description).toBe("Our own explorer")
    rmSync(project, { recursive: true, force: true })
  })

  test("a project with no .compass directory still has the built-ins", () => {
    expect(agents(temp()).map((agent) => agent.name)).toEqual(["explore", "general"])
  })
})

describe("the task tool", () => {
  const contextWith = (spawn?: Context["spawn"]): Context => ({
    sessionID: sessionID(),
    messageID: messageID(),
    callID: "call_1",
    directory: temp(),
    abort: new AbortController().signal,
    ask: () => Effect.void,
    ...(spawn === undefined ? {} : { spawn }),
  })

  const run = (input: Record<string, unknown>, context: Context) =>
    Effect.runPromise(task.execute(input as never, context).pipe(Effect.result))

  test("returns the child's answer and nothing else", async () => {
    const context = contextWith(() => Effect.succeed("the child's conclusion"))
    const result = await run({ description: "look it up", prompt: "find X", subagent_type: "explore" }, context)

    expect(result._tag).toBe("Success")
    expect((result as { success: { output: string } }).success.output).toBe("the child's conclusion")
  })

  test("names the agents that exist when asked for one that does not", async () => {
    const context = contextWith(() => Effect.succeed("unused"))
    const result = await run({ description: "d", prompt: "p", subagent_type: "nonexistent" }, context)

    expect(result._tag).toBe("Failure")
    expect((result as { failure: ToolFailure }).failure.message).toContain("explore")
  })

  test("refuses rather than pretending when there is nothing to delegate into", async () => {
    const result = await run({ description: "d", prompt: "p", subagent_type: "explore" }, contextWith())
    expect(result._tag).toBe("Failure")
  })

  test("propagates a failure from the child rather than reporting success", async () => {
    const context = contextWith(() => new ToolFailure({ message: "the child hit its step limit" }))
    const result = await run({ description: "d", prompt: "p", subagent_type: "general" }, context)

    expect(result._tag).toBe("Failure")
    expect((result as { failure: ToolFailure }).failure.message).toContain("step limit")
  })
})
