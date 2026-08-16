import { messageID, sessionID } from "@compass/schema"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { readTool } from "../src/tool/read"
import { make as makeRegistry } from "../src/tool/registry"
import { SPILL_MAX_AGE_MS, Spill, spillPath, spillRoot } from "../src/tool/spill"
import { make as makeTool } from "../src/tool/tool"
import { MAX_LINES, bound, exceeds } from "../src/tool/truncate"

const allowAll = { ask: () => Effect.void }
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

function scratch() {
  return mkdtempSync(join(tmpdir(), "spill-"))
}

function context(directory: string) {
  return {
    sessionID: sessionID(),
    messageID: messageID(),
    callID: "call_1",
    directory,
    abort: new AbortController().signal,
  }
}

const huge = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line ${i}`).join("\n")

describe("truncate.exceeds", () => {
  test("is false for output within the budget", () => {
    expect(exceeds("a\nb\nc")).toBe(false)
  })

  test("is true past the line budget", () => {
    expect(exceeds(huge)).toBe(true)
  })

  test("is true past the byte budget even with few lines", () => {
    expect(exceeds("x".repeat(60 * 1024))).toBe(true)
  })

  test("agrees with bound, so a caller cannot spill without truncating", () => {
    expect(exceeds(huge)).toBe(bound(huge).truncated)
    expect(exceeds("small")).toBe(bound("small").truncated)
  })
})

describe("truncate note", () => {
  test("appends the note to the marker so the path rides along with the cut", () => {
    const result = bound(huge, { note: "Full output saved to /tmp/x.txt" })
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("truncated")
    expect(result.content).toContain("Full output saved to /tmp/x.txt")
  })

  test("is absent when nothing was cut", () => {
    const result = bound("tiny", { note: "should not appear" })
    expect(result.truncated).toBe(false)
    expect(result.content).toBe("tiny")
  })
})

describe("Spill", () => {
  test("writes the complete text and returns its path", async () => {
    const dir = scratch()
    const path = await run(Spill.write({ text: huge, directory: dir, sessionID: "ses_1", callID: "call_1" }))
    expect(path).toBeDefined()
    expect(readFileSync(path!, "utf8")).toBe(huge)
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes inside the session directory, so the read tool can reach it", async () => {
    const dir = scratch()
    const path = await run(Spill.write({ text: "x", directory: dir, sessionID: "ses_1", callID: "c" }))
    expect(path!.startsWith(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns undefined instead of failing when the write cannot happen", async () => {
    // A regular file where the spill root must be a directory makes mkdir fail.
    const dir = scratch()
    mkdirSync(dirname(spillRoot(dir)), { recursive: true })
    writeFileSync(spillRoot(dir), "not a directory")
    const path = await run(Spill.write({ text: "x", directory: dir, sessionID: "ses_1", callID: "c" }))
    expect(path).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * callID is the provider's toolCallId. It crosses a trust boundary and is a
   * bare string, so it is the one input here that can carry a traversal.
   */
  test("refuses a callID that would escape the spill root", async () => {
    const dir = scratch()
    const escape = `${"../".repeat(12)}pwned`
    expect(spillPath(dir, "ses_1", escape)).toBeUndefined()
    const path = await run(Spill.write({ text: "x", directory: dir, sessionID: "ses_1", callID: escape }))
    expect(path).toBeUndefined()
    expect(existsSync(join(dir, "..", "pwned.txt"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("refuses a sessionID that would escape the spill root", async () => {
    const dir = scratch()
    expect(spillPath(dir, "../../evil", "c")).toBeUndefined()
    expect(await run(Spill.write({ text: "x", directory: dir, sessionID: "../../evil", callID: "c" }))).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  test("refuses separators and dot segments outright", () => {
    const dir = scratch()
    for (const bad of ["a/b", "a\\b", "..", ".", "", "a\u0000b"]) {
      expect(spillPath(dir, "ses_1", bad)).toBeUndefined()
    }
    expect(spillPath(dir, "ses_1", "call_1")).toBeDefined()
    rmSync(dir, { recursive: true, force: true })
  })

  test("ignores its own directory from inside, protecting whatever project it runs in", async () => {
    const dir = scratch()
    await run(Spill.write({ text: "x", directory: dir, sessionID: "ses_1", callID: "c" }))
    expect(readFileSync(join(spillRoot(dir), ".gitignore"), "utf8").trim()).toBe("*")
    rmSync(dir, { recursive: true, force: true })
  })

  test("sweep survives an rm failure instead of crashing the run", async () => {
    // Effect.promise turns a rejection into a defect, which Effect.ignore at the
    // call site does NOT catch. A read-only parent makes rm fail for real.
    const dir = scratch()
    mkdirSync(join(spillRoot(dir), "old"), { recursive: true })
    const stale = new Date(Date.now() - SPILL_MAX_AGE_MS - 60_000)
    utimesSync(join(spillRoot(dir), "old"), stale, stale)
    chmodSync(spillRoot(dir), 0o500)
    const swept = await run(Spill.sweep(dir))
    expect(typeof swept).toBe("number")
    chmodSync(spillRoot(dir), 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  test("clear removes only the named session", async () => {
    const dir = scratch()
    await run(Spill.write({ text: "a", directory: dir, sessionID: "ses_a", callID: "c" }))
    await run(Spill.write({ text: "b", directory: dir, sessionID: "ses_b", callID: "c" }))
    await run(Spill.clear(dir, "ses_a"))
    expect(existsSync(join(spillRoot(dir), "ses_a"))).toBe(false)
    expect(existsSync(join(spillRoot(dir), "ses_b"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("sweep removes only directories past the retention window", async () => {
    const dir = scratch()
    mkdirSync(join(spillRoot(dir), "old"), { recursive: true })
    mkdirSync(join(spillRoot(dir), "fresh"), { recursive: true })
    const stale = new Date(Date.now() - SPILL_MAX_AGE_MS - 60_000)
    utimesSync(join(spillRoot(dir), "old"), stale, stale)

    const removed = await run(Spill.sweep(dir))
    expect(removed).toBe(1)
    expect(existsSync(join(spillRoot(dir), "old"))).toBe(false)
    expect(existsSync(join(spillRoot(dir), "fresh"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("sweep on a directory that never spilled is a no-op", async () => {
    const dir = scratch()
    expect(await run(Spill.sweep(dir))).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * The behaviour the task actually asks for, proven end to end: a huge result
 * reaches the model as a preview naming a path, and that path is readable by
 * the read tool without tripping the workspace guard.
 */
describe("oversized output through settle()", () => {
  const flood = makeTool({
    description: "emits far more than the budget allows",
    input: Schema.Struct({}),
    execute: () => Effect.succeed({ title: "flood", output: huge }),
  })

  test("returns a preview naming a spill file that holds the full text", async () => {
    const dir = scratch()
    const registry = makeRegistry([{ name: "flood", tool: flood }], allowAll)
    const settlement = await run(registry.settle({ name: "flood", input: {}, context: context(dir) }))

    expect(settlement.ok).toBe(true)
    if (!settlement.ok) throw new Error("expected success")

    // Bounded, and far smaller than what the tool produced.
    expect(settlement.result.output.length).toBeLessThan(huge.length)
    expect(settlement.result.output).toContain("truncated")

    const match = settlement.result.output.match(/Full output saved to (\S+\.txt)/)
    expect(match).not.toBeNull()
    expect(readFileSync(match![1]!, "utf8")).toBe(huge)

    rmSync(dir, { recursive: true, force: true })
  })

  test("the spilled path is readable by the read tool", async () => {
    const dir = scratch()
    const registry = makeRegistry([{ name: "flood", tool: flood }], allowAll)
    const settlement = await run(registry.settle({ name: "flood", input: {}, context: context(dir) }))
    if (!settlement.ok) throw new Error("expected success")
    const path = settlement.result.output.match(/Full output saved to (\S+\.txt)/)![1]!

    const asks: string[] = []
    const read = await run(
      readTool
        .execute(
          { filePath: path, offset: 10, limit: 3 } as never,
          {
            ...context(dir),
            ask: (request: { permission: string }) => {
              asks.push(request.permission)
              return Effect.void
            },
          } as never,
        )
        .pipe(Effect.result),
    )

    expect(read._tag).toBe("Success")
    // Inside the session directory, so no external_directory prompt.
    expect(asks).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  test("output within the budget is passed through untouched and spills nothing", async () => {
    const dir = scratch()
    const small = makeTool({
      description: "small",
      input: Schema.Struct({}),
      execute: () => Effect.succeed({ title: "small", output: "just this" }),
    })
    const registry = makeRegistry([{ name: "small", tool: small }], allowAll)
    const settlement = await run(registry.settle({ name: "small", input: {}, context: context(dir) }))
    if (!settlement.ok) throw new Error("expected success")

    expect(settlement.result.output).toBe("just this")
    expect(existsSync(spillRoot(dir))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("a failed spill still bounds the output and says the remainder is lost", async () => {
    const dir = scratch()
    mkdirSync(dirname(spillRoot(dir)), { recursive: true })
    writeFileSync(spillRoot(dir), "not a directory")
    const registry = makeRegistry([{ name: "flood", tool: flood }], allowAll)
    const settlement = await run(registry.settle({ name: "flood", input: {}, context: context(dir) }))

    // A convenience file that could not be written must not turn a successful
    // tool call into a failure.
    expect(settlement.ok).toBe(true)
    if (!settlement.ok) throw new Error("expected success")
    expect(settlement.result.output).toContain("could not be saved")
    rmSync(dir, { recursive: true, force: true })
  })
})
