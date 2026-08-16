import { messageID, sessionID } from "@compass/schema"
import { test, expect } from "bun:test"
import { Effect, Either } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { grepTool } from "../src/tool/grep"
import type { Context } from "../src/tool/tool"

const ctx = (directory: string, signal?: AbortSignal): Context => ({
  sessionID: sessionID(),
  messageID: messageID(),
  callID: "c",
  directory,
  abort: signal ?? new AbortController().signal,
})
const run = (input: any, dir: string, signal?: AbortSignal) =>
  Effect.runPromise(grepTool.execute(input, ctx(dir, signal)).pipe(Effect.either))

const orig = process.env["PATH"] ?? ""

test("PROBE: unreadable file in fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-"))
  writeFileSync(join(root, "ok.txt"), "TODO here\n")
  writeFileSync(join(root, "secret.txt"), "TODO hidden\n")
  chmodSync(join(root, "secret.txt"), 0o000)

  process.env["PATH"] = ""
  const fb = await run({ pattern: "TODO" }, root)
  process.env["PATH"] = orig
  const rg = await run({ pattern: "TODO" }, root)

  console.log(
    "FALLBACK:",
    Either.isLeft(fb) ? `FAIL -> ${fb.left.message}` : `OK -> ${JSON.stringify(fb.right.metadata)}`,
  )
  console.log(
    "RIPGREP :",
    Either.isLeft(rg) ? `FAIL -> ${rg.left.message}` : `OK -> ${JSON.stringify(rg.right.metadata)}`,
  )
  chmodSync(join(root, "secret.txt"), 0o644)
  expect(1).toBe(1)
})

test("PROBE: gitignore + node_modules divergence", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-"))
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n")
  writeFileSync(join(root, "ignored.txt"), "TODO ignored\n")
  writeFileSync(join(root, "kept.txt"), "TODO kept\n")
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "TODO dep\n")

  process.env["PATH"] = ""
  const fb = await run({ pattern: "TODO" }, root)
  process.env["PATH"] = orig
  const rg = await run({ pattern: "TODO" }, root)
  console.log("FALLBACK:", Either.isRight(fb) ? fb.right.output : fb.left.message)
  console.log("---")
  console.log("RIPGREP :", Either.isRight(rg) ? rg.right.output : rg.left.message)
  expect(1).toBe(1)
})

test("PROBE: include ignored when path is a single file (fallback)", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-"))
  writeFileSync(join(root, "a.ts"), "TODO ts\n")
  process.env["PATH"] = ""
  const fb = await run({ pattern: "TODO", path: "a.ts", include: "*.py" }, root)
  process.env["PATH"] = orig
  const rg = await run({ pattern: "TODO", path: "a.ts", include: "*.py" }, root)
  console.log(
    "FALLBACK:",
    Either.isRight(fb) ? JSON.stringify(fb.right.metadata) + " | " + fb.right.output.split("\n")[0] : fb.left.message,
  )
  console.log(
    "RIPGREP :",
    Either.isRight(rg) ? JSON.stringify(rg.right.metadata) + " | " + rg.right.output.split("\n")[0] : rg.left.message,
  )
  expect(1).toBe(1)
})

test("PROBE: long minified line", async () => {
  const root = mkdtempSync(join(tmpdir(), "probe-"))
  writeFileSync(join(root, "min.js"), "var x=1;".repeat(20000) + "NEEDLE_HERE;\n")
  process.env["PATH"] = ""
  const fb = await run({ pattern: "NEEDLE_HERE" }, root)
  process.env["PATH"] = orig
  const rg = await run({ pattern: "NEEDLE_HERE" }, root)
  console.log("FALLBACK:", Either.isRight(fb) ? JSON.stringify(fb.right.metadata) : fb.left.message)
  console.log("RIPGREP :", Either.isRight(rg) ? JSON.stringify(rg.right.metadata) : rg.left.message)
  expect(1).toBe(1)
})
