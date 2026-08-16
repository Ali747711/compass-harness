import { MessageID, SessionID } from "@compass/schema"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Request as PermissionRequest } from "../src/permission/permission"
import { bashTool } from "../src/tool/bash"
import { make as makeRegistry } from "../src/tool/registry"
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
  ask: () => Effect.void,
  abort: new AbortController().signal,
  ...overrides,
})

/** Records what a tool asked for. bash should never reach the policy itself. */
const recording = (log: PermissionRequest[]) =>
  context({
    ask: (request) =>
      Effect.sync(() => {
        log.push(request)
      }),
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntil = async (until: () => boolean, budget = 5_000) => {
  const deadline = Date.now() + budget
  while (Date.now() < deadline && !until()) await Bun.sleep(25)
  return until()
}

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

  /**
   * Separate buffers concatenated at the end always put every stderr line after
   * every stdout line, so the model cannot tell where in the output an error
   * appeared. The writes are spaced out because ordering between two pipes is
   * only meaningful once the reader has observed the earlier one.
   */
  test("interleaves stderr with stdout in arrival order", async () => {
    const result = await runTool({
      command: "echo first; sleep 0.2; echo middle >&2; sleep 0.2; echo last",
      timeout: 10_000,
    })
    expect(result.output).toContain("first")
    expect(result.output).toContain("<stderr>")
    expect(result.output.indexOf("first")).toBeLessThan(result.output.indexOf("middle"))
    expect(result.output.indexOf("middle")).toBeLessThan(result.output.indexOf("last"))
  }, 20_000)

  test("keeps a run of stderr in one block rather than tagging every chunk", async () => {
    const result = await runTool({ command: "{ echo one; echo two; } >&2" })
    expect(result.output.match(/<stderr>/g)).toHaveLength(1)
    expect(result.output).toContain("one\ntwo")
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

  /**
   * `trap '' TERM` sets SIGTERM to ignored, and an ignored disposition is inherited
   * across exec, so the `sleep` ignores it too: nothing in this process group dies
   * until the escalation timer fires. Delete that timer and the tool blocks for the
   * full 8s sleep instead of returning in roughly timeout + grace.
   */
  test("escalates to SIGKILL when the command ignores SIGTERM", async () => {
    const started = Date.now()
    const result = await runTool({ command: "trap '' TERM; sleep 8", timeout: 300 })
    const elapsed = Date.now() - started
    expect(result.metadata?.["timedOut"]).toBe(true)
    expect(result.metadata?.["signal"]).toBe("SIGKILL")
    // Long enough to prove the grace period was honoured, short enough to prove
    // the sleep was cut off rather than allowed to finish.
    expect(elapsed).toBeGreaterThan(1_500)
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)

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

  /**
   * The window between the check at entry and the listener being attached. An
   * abort that lands in it never fires the listener, so checking only once at
   * entry leaves the command running to its full timeout.
   */
  test("honours an abort that lands while the child is being spawned", async () => {
    const controller = new AbortController()
    controller.abort()
    // Reports "not aborted" exactly once, reproducing an abort that lands after the
    // check at entry. Listeners attached to an already-aborted signal never fire, so
    // only a second check can catch it.
    let peeked = false
    const racing = new Proxy(controller.signal, {
      get(target, property) {
        if (property === "aborted" && !peeked) {
          peeked = true
          return false
        }
        // Reads go to the real signal: AbortSignal's accessors reject a proxy receiver.
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })

    const started = Date.now()
    const result = await runTool({ command: "sleep 8" }, context({ abort: racing }))
    expect(result.metadata?.["aborted"]).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 30_000)

  /**
   * Interruption is not the abort signal: the fiber is torn down without anyone
   * touching `context.abort`, so only a finalizer can reach the child. Without one
   * the shell and its group outlive the turn that spawned them.
   */
  test("kills the child process group when the fiber is interrupted", async () => {
    const pidFile = join(directory, "interrupt-pid.txt")
    const marker = join(directory, "interrupt-survived.txt")
    const fiber = Effect.runFork(
      bashTool.execute(
        { command: `echo $$ > ${pidFile}; sleep 8; echo alive > ${marker}`, description: "Sleep for a while" },
        context(),
      ),
    )

    expect(await waitUntil(() => Bun.file(pidFile).size > 0)).toBe(true)
    const pid = Number((await Bun.file(pidFile).text()).trim())
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(alive(pid)).toBe(false)
    expect(await Bun.file(marker).exists()).toBe(false)
  }, 30_000)

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

  /**
   * The failure signals live at the end of the output, so head-first bounding used
   * to delete exactly the part the model needs: a command that failed after a wall
   * of stdout read as a clean success. Middle-out bounding keeps the tail.
   */
  test("keeps the exit code and stderr visible after the registry bounds huge output", async () => {
    const registry = makeRegistry([{ name: "bash", tool: bashTool }], { ask: () => Effect.void })
    const { ask, ...call } = context()
    expect(ask).toBeFunction()
    const settlement = await Effect.runPromise(
      registry.settle({
        name: "bash",
        input: { command: "seq 1 20000; echo it-broke >&2; exit 7", description: "Flood then fail" },
        context: call,
      }),
    )
    expect(settlement.ok).toBe(true)
    if (!settlement.ok) throw new Error("expected a successful settlement")
    expect(settlement.result.output).toMatch(/truncated/)
    expect(settlement.result.output).toContain("<stderr>")
    expect(settlement.result.output).toContain("it-broke")
    expect(settlement.result.output).toContain("Exit code: 7")
    expect(settlement.result.metadata?.["exit"]).toBe(7)
  }, 30_000)

  test("never reaches the permission policy itself; the registry gates it by name", async () => {
    const asked: PermissionRequest[] = []
    const result = await runTool({ command: "echo gated" }, recording(asked))
    expect(result.output).toBe("gated")
    expect(asked).toHaveLength(0)
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
