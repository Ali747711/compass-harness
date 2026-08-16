import { MessageID, SessionID } from "@compass/schema"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bashTool } from "../src/tool/bash"
import { decode, parameters, ToolFailure, type Context, type Result } from "../src/tool/tool"

let directory = ""

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "compass-bash-")))
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

const context = (overrides: Partial<Context> = {}): Context => ({
  sessionID: SessionID.make("ses_bash_test"),
  messageID: MessageID.make("msg_bash_test"),
  callID: "call_bash_test",
  directory,
  abort: new AbortController().signal,
  ...overrides,
})

interface Input {
  readonly command: string
  readonly timeout?: number
  readonly description?: string
}

const runTool = (input: Input, ctx: Context = context()): Promise<Result> =>
  Effect.runPromise(bashTool.execute({ description: "Run a test command", ...input }, ctx))

const failTool = (input: Input, ctx: Context = context()): Promise<ToolFailure> =>
  Effect.runPromise(bashTool.execute({ description: "Run a test command", ...input }, ctx).pipe(Effect.flip))

describe("bashTool", () => {
  test("captures stdout and reports a zero exit", async () => {
    const result = await runTool({ command: "echo hello" })
    expect(result.output).toBe("hello")
    expect(result.metadata?.["exit"]).toBe(0)
    expect(result.metadata?.["timedOut"]).toBe(false)
  })

  test("uses the description as the title and keeps the command in metadata", async () => {
    const result = await runTool({ command: "echo titled", description: "Print a greeting" })
    expect(result.title).toBe("Print a greeting")
    expect(result.metadata?.["command"]).toBe("echo titled")
  })

  test("runs in the session directory, not the process cwd", async () => {
    const result = await runTool({ command: "pwd" })
    expect(result.output).toBe(directory)
    expect(result.output).not.toBe(process.cwd())
  })

  test("side effects land in the session directory", async () => {
    await runTool({ command: "mkdir -p nested && echo written > nested/marker.txt" })
    const marker = Bun.file(join(directory, "nested", "marker.txt"))
    expect(await marker.exists()).toBe(true)
    expect((await marker.text()).trim()).toBe("written")
  })

  test("captures stderr alongside stdout", async () => {
    const result = await runTool({ command: "echo out; echo problem >&2" })
    expect(result.output).toContain("out")
    expect(result.output).toContain("<stderr>")
    expect(result.output).toContain("problem")
  })

  test("a non-zero exit is a successful result, not a ToolFailure", async () => {
    const result = await runTool({ command: "echo before failing; exit 3" })
    expect(result.output).toContain("before failing")
    expect(result.output).toContain("Exit code: 3")
    expect(result.metadata?.["exit"]).toBe(3)
  })

  test("reports missing commands through the shell's own exit code", async () => {
    const result = await runTool({ command: "definitely-not-a-real-binary-xyz" })
    expect(result.metadata?.["exit"]).toBe(127)
    expect(result.output).toContain("<stderr>")
  })

  test("says so explicitly when a command prints nothing", async () => {
    const result = await runTool({ command: "true" })
    expect(result.output).toBe("(no output)")
  })

  test("kills a command that exceeds its timeout and says it timed out", async () => {
    const started = Date.now()
    const result = await runTool({ command: "echo starting; sleep 30", timeout: 400 })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.metadata?.["timedOut"]).toBe(true)
    expect(result.output).toContain("starting")
    expect(result.output).toContain("exceeded its 400ms timeout")
  })

  test("clamps a timeout above the maximum instead of honouring it", async () => {
    const result = await runTool({ command: "true", timeout: 5_000_000 })
    expect(result.metadata?.["timeout"]).toBe(600_000)
  })

  test("defaults the timeout when none is supplied", async () => {
    const result = await runTool({ command: "true" })
    expect(result.metadata?.["timeout"]).toBe(120_000)
  })

  test("honours an abort signal raised while the command runs", async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 200)
    const result = await runTool({ command: "sleep 30" }, context({ abort: controller.signal }))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.metadata?.["aborted"]).toBe(true)
    expect(result.output).toContain("aborted by the user")
  })

  test("fails without spawning anything when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const sentinel = join(directory, "never-created.txt")
    const error = await failTool({ command: `echo x > ${sentinel}` }, context({ abort: controller.signal }))
    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("Aborted")
    expect(await Bun.file(sentinel).exists()).toBe(false)
  })

  test("does not hang on a command that reads stdin", async () => {
    const started = Date.now()
    const result = await runTool({ command: "cat", timeout: 3_000 })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result.metadata?.["exit"]).toBe(0)
    expect(result.metadata?.["timedOut"]).toBe(false)
  })

  test("reads a file through stdin redirection rather than the inherited stream", async () => {
    writeFileSync(join(directory, "input.txt"), "piped content\n")
    const result = await runTool({ command: "cat < input.txt" })
    expect(result.output).toBe("piped content")
  })

  test("returns large output in full and leaves bounding to the registry", async () => {
    const result = await runTool({ command: "seq 1 20000" })
    const lines = result.output.split("\n")
    expect(lines).toHaveLength(20_000)
    expect(lines[0]).toBe("1")
    expect(lines[19_999]).toBe("20000")
  })

  test("fails with an actionable message when the command is empty", async () => {
    const error = await failTool({ command: "   " })
    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("must not be empty")
  })

  test("fails with an actionable message when the directory does not exist", async () => {
    const missing = join(directory, "no-such-directory")
    const error = await failTool({ command: "true" }, context({ directory: missing }))
    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain(missing)
  })

  test("rejects a non-positive timeout at the schema boundary", async () => {
    const error = await Effect.runPromise(
      decode(bashTool, { command: "true", description: "Do nothing", timeout: 0 }).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(ToolFailure)
    expect(error.message).toContain("Invalid tool input")
  })

  test("requires a description so the user always sees a label", async () => {
    const error = await Effect.runPromise(decode(bashTool, { command: "true" }).pipe(Effect.flip))
    expect(error.message).toContain("Invalid tool input")
  })

  test("exposes documented parameters to the model", () => {
    const schema = parameters(bashTool) as {
      properties: Record<string, { description?: string }>
      required: readonly string[]
    }
    expect(Object.keys(schema.properties).toSorted()).toEqual(["command", "description", "timeout"])
    expect(schema.required.toSorted()).toEqual(["command", "description"])
    for (const property of Object.values(schema.properties)) {
      expect(property.description?.length ?? 0).toBeGreaterThan(20)
    }
  })

  test("declares the bash permission", () => {
    expect(bashTool.permission).toBe("bash")
    expect(bashTool.description).toContain("working directory")
  })
})
