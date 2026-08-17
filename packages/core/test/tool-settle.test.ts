// Integration coverage for the path the model actually takes.
//
// Every other tool test calls `tool.execute(...)` directly, which skips input
// decoding, `ask` injection, and output bounding — exactly the three things the
// registry adds, and exactly where the M1 defects lived. These tests go through
// `registry.settle(...)` with the real builtins and real files on disk.

import { messageID, sessionID } from "@compass/schema"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Permission, layerAllowAll, layerDenyAll, layerRecording, type Request } from "../src/permission/permission"
import { builtins } from "../src/tool/builtins"
import {
  make as makeRegistry,
  type CallContext,
  type Interface as RegistryInterface,
  type Registration,
  type Settlement,
} from "../src/tool/registry"
import { ToolFailure, make as makeTool, type Result } from "../src/tool/tool"
import { MAX_BYTES, MAX_LINES } from "../src/tool/truncate"

let directory: string
let outside: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "compass-settle-"))
  outside = mkdtempSync(path.join(tmpdir(), "compass-settle-outside-"))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/**
 * The registry is built through the Permission layer rather than a hand-rolled
 * service, so the wiring under test is the same wiring the app uses.
 */
const registryFor = (permission: Layer.Layer<Permission>, extra: readonly Registration[] = []): RegistryInterface =>
  Effect.runSync(
    Effect.gen(function* () {
      const service = yield* Permission
      return makeRegistry([...builtins, ...extra], service)
    }).pipe(Effect.provide(permission), Effect.scoped),
  )

/** A CallContext carries no `ask` — the registry injects it. That is the point of these tests. */
const callContext = (overrides: Partial<CallContext> = {}): CallContext => ({
  sessionID: sessionID(),
  messageID: messageID(),
  callID: "call_settle_test",
  directory,
  abort: new AbortController().signal,
  ...overrides,
})

const settle = (registry: RegistryInterface, name: string, input: unknown, context: CallContext = callContext()) =>
  Effect.runPromise(registry.settle({ name, input, context }))

const expectOk = (settlement: Settlement): Result => {
  if (settlement.ok) return settlement.result
  throw new Error(`expected a successful settlement, got: ${settlement.error}`)
}

const expectFailed = (settlement: Settlement): string => {
  if (!settlement.ok) return settlement.error
  throw new Error(`expected a failed settlement, got: ${settlement.result.output}`)
}

describe("settle: output bounding of real tools", () => {
  /**
   * The highest-severity M1 defect. `read` states the continuation offset on the
   * last line; head-only clipping deleted it, so a paginated read of a large file
   * looked to the model like the whole file. Middle-out bounding must keep it.
   */
  test("keeps read's continuation footer when the page is bounded", async () => {
    const file = path.join(directory, "huge.txt")
    writeFileSync(file, `${Array.from({ length: 60_000 }, (_, index) => `line ${index}`).join("\n")}\n`)

    const registry = registryFor(layerAllowAll)
    const result = expectOk(await settle(registry, "read", { filePath: file, limit: 50_000 }))

    expect(result.output).toContain("Use offset=50000 to continue.")
    expect(result.output).toContain("(Showing lines 1-50000 of 60000.")
    // Head framing survives too, so the model still knows which file it is reading.
    // The path is shown relative to the session directory (see `displayPath`).
    expect(result.output.startsWith("<path>huge.txt</path>")).toBe(true)
    expect(result.output).toContain("1: line 0")
    // And the drop is announced rather than silent.
    expect(result.output).toMatch(/truncated/)
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(MAX_BYTES)
    expect(result.output.split("\n").length).toBeLessThanOrEqual(MAX_LINES)
  })

  test("read reports the full total line count in metadata even when bounded", async () => {
    const file = path.join(directory, "huge.txt")
    writeFileSync(file, `${Array.from({ length: 60_000 }, (_, index) => `line ${index}`).join("\n")}\n`)

    const registry = registryFor(layerAllowAll)
    const result = expectOk(await settle(registry, "read", { filePath: file, limit: 50_000 }))

    expect(result.metadata?.["totalLines"]).toBe(60_000)
    expect(result.metadata?.["more"]).toBe(true)
  })

  /**
   * A command that ran and failed is a successful tool run. Its exit code and
   * stderr are the only part of the output that matters, and they are last —
   * precisely what head-only clipping threw away.
   */
  test("keeps bash's exit code and stderr when stdout floods the budget", async () => {
    const registry = registryFor(layerAllowAll)
    const settlement = await settle(registry, "bash", {
      command: `awk 'BEGIN { for (i = 1; i <= 60000; i++) print "stdout line " i }'; echo "fatal: something broke" >&2; exit 42`,
      description: "Flood stdout and fail",
    })

    // A non-zero exit is bad news, not a broken tool.
    const result = expectOk(settlement)
    expect(result.output).toContain("fatal: something broke")
    expect(result.output).toContain("Exit code: 42")
    expect(result.output.trimEnd().endsWith("</bash_metadata>")).toBe(true)
    expect(result.output).toContain("stdout line 1")
    expect(result.output).toMatch(/truncated/)
    expect(result.metadata?.["exit"]).toBe(42)
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(MAX_BYTES)
  })

  test("passes output under the limit through byte-identically", async () => {
    const file = path.join(directory, "small.txt")
    writeFileSync(file, "alpha\nbeta\n")

    const registry = registryFor(layerAllowAll)
    const result = expectOk(await settle(registry, "read", { filePath: file }))

    expect(result.output).toBe(
      ["<path>small.txt</path>", "<content>", "1: alpha", "2: beta", "</content>", "", "(End of file - 2 lines)"].join(
        "\n",
      ),
    )
  })
})

describe("settle: input decoding and containment", () => {
  test("turns a wrong parameter type into a model-actionable failure, not a throw", async () => {
    const registry = registryFor(layerAllowAll)
    const error = expectFailed(await settle(registry, "read", { filePath: 42 }))

    expect(error).toMatch(/Invalid tool input/)
    expect(error).toMatch(/filePath/)
  })

  test("reports a missing required parameter rather than crashing", async () => {
    const registry = registryFor(layerAllowAll)
    const error = expectFailed(await settle(registry, "bash", { command: "true" }))

    expect(error).toMatch(/Invalid tool input/)
    expect(error).toMatch(/description/)
  })

  test("reports an unknown tool name without throwing", async () => {
    const registry = registryFor(layerAllowAll)
    const error = expectFailed(await settle(registry, "definitely_not_a_tool", { anything: true }))

    expect(error).toMatch(/Unknown tool: definitely_not_a_tool/)
  })

  test("contains a raw defect and keeps serving later calls", async () => {
    const kaboom = makeTool({
      description: "throws a raw defect",
      input: Schema.Struct({}),
      execute: () =>
        Effect.sync((): Result => {
          throw new Error("unexpected explosion")
        }),
    })
    const registry = registryFor(layerAllowAll, [{ name: "kaboom", tool: kaboom }])

    expect(expectFailed(await settle(registry, "kaboom", {}))).toBe("unexpected explosion")

    const file = path.join(directory, "after.txt")
    writeFileSync(file, "still here\n")
    const result = expectOk(await settle(registry, "read", { filePath: file }))
    expect(result.output).toContain("1: still here")
  })

  test("surfaces an expected ToolFailure as a failed settlement", async () => {
    const refuse = makeTool({
      description: "always refuses",
      input: Schema.Struct({}),
      execute: () => Effect.fail(new ToolFailure({ message: "deliberate failure" })),
    })
    const registry = registryFor(layerAllowAll, [{ name: "refuse", tool: refuse }])

    expect(expectFailed(await settle(registry, "refuse", {}))).toBe("deliberate failure")
  })
})

describe("settle: permission injection", () => {
  test("refuses an out-of-tree write and leaves nothing on disk", async () => {
    const target = path.join(outside, "escaped.txt")
    const registry = registryFor(layerDenyAll)

    const error = expectFailed(await settle(registry, "write", { filePath: target, content: "should not land" }))

    expect(error).toContain("outside the session directory")
    expect(existsSync(target)).toBe(false)
  })

  test("allows the same out-of-tree write when permission is granted", async () => {
    const target = path.join(outside, "escaped.txt")
    const registry = registryFor(layerAllowAll)

    const result = expectOk(await settle(registry, "write", { filePath: target, content: "landed" }))

    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, "utf-8")).toBe("landed")
    // The escape is stated, not silent.
    expect(result.output).toContain("outside the session directory")
  })

  test("asks exactly once for external_directory on an out-of-tree path", async () => {
    const log: Request[] = []
    const registry = registryFor(layerRecording(log))
    const target = path.join(outside, "recorded.txt")

    expectOk(await settle(registry, "write", { filePath: target, content: "recorded" }))

    expect(log.length).toBe(1)
    expect(log.at(0)?.permission).toBe("external_directory")
    expect(log.at(0)?.patterns).toEqual([path.join(outside, "*")])
  })

  test("asks nothing for an in-tree path", async () => {
    const log: Request[] = []
    const registry = registryFor(layerRecording(log))
    const target = path.join(directory, "nested", "inside.txt")

    expectOk(await settle(registry, "write", { filePath: target, content: "inside" }))

    expect(log.length).toBe(0)
    expect(readFileSync(target, "utf-8")).toBe("inside")
  })

  test("a denying policy never reaches the filesystem for a read either", async () => {
    const target = path.join(outside, "secret.txt")
    writeFileSync(target, "top secret\n")
    const registry = registryFor(layerDenyAll)

    const error = expectFailed(await settle(registry, "read", { filePath: target }))

    expect(error).toContain("outside the session directory")
    expect(error).not.toContain("top secret")
  })
})
