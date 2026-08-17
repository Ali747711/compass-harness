import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { builtins } from "../src/tool/builtins"
import { parameters } from "../src/tool/tool"
import baseline from "./fixtures/tool-descriptions.json"

/**
 * Descriptions moved from inline template literals into colocated `.txt` files
 * so the prose the model reads is reviewable as prose.
 *
 * `fixtures/tool-descriptions.json` was captured by running the tool modules at
 * commit b0dd469, BEFORE the move, and must never be regenerated: it is the only
 * evidence that the wire text the model sees did not change. A diff here means
 * the refactor altered the product surface, which is what it exists to prevent.
 * Regenerating it from the current code would make this file self-confirming and
 * worthless — recapture only from that commit, or not at all.
 *
 * The `.txt` files carry {{TOKEN}} placeholders for values that are real
 * constants in the code, so the description is the rendered file rather than the
 * file verbatim. Baking the numbers in would put a second, frozen source of
 * truth beside the parameter schema, which still interpolates the live value.
 */
const TOOL_DIR = join(import.meta.dir, "..", "src", "tool")

/**
 * Tools that existed when the baseline was captured. A tool added afterwards
 * has no "text before the move" and cannot be checked against one — but the
 * baseline must still account for every tool it does cover, or a rename could
 * quietly drop a description out of the guarantee.
 */
const BASELINED = new Set(Object.keys(baseline))

describe("tool descriptions", () => {
  test("every baselined tool is still registered under the same name", () => {
    const registered = new Set(builtins.map((entry) => entry.name))
    for (const name of BASELINED) expect(registered.has(name), `${name} lost its baseline`).toBe(true)
  })

  /**
   * Named explicitly rather than derived, so adding a tool is a deliberate act
   * that shows up in a diff — not something that silently widens the exemption.
   */
  test("only known-new tools are exempt from the byte-identical check", () => {
    const exempt = builtins.map((entry) => entry.name).filter((name) => !BASELINED.has(name))
    expect(exempt).toEqual(["task"])
  })

  for (const { name, tool } of builtins) {
    describe(name, () => {
      test.if(BASELINED.has(name))("is byte-identical to the text captured before the move", () => {
        expect(tool.description).toBe((baseline as Record<string, string>)[name]!)
      })

      test("is the colocated .txt file with its placeholders filled", () => {
        // Every literal segment of the file must appear in the description, in
        // order — so the description is provably that document and not another.
        const raw = readFileSync(join(TOOL_DIR, `${name}.txt`), "utf8")
        let cursor = 0
        for (const segment of raw.split(/\{\{\w+\}\}/)) {
          const at = tool.description.indexOf(segment, cursor)
          expect(at, `segment missing from ${name} description`).toBeGreaterThanOrEqual(0)
          cursor = at + segment.length
        }
      })

      test("has no unreplaced placeholder left in the model-facing text", () => {
        expect(tool.description).not.toContain("{{")
      })

      test("is substantial enough for a model to choose the tool", () => {
        expect(tool.description.length).toBeGreaterThan(200)
      })
    })
  }

  test("no description ends up empty or whitespace-only", () => {
    for (const { name, tool } of builtins) {
      expect(tool.description.trim().length, name).toBeGreaterThan(0)
    }
  })

  /**
   * The description is only half the product surface; the parameter docs the
   * model sees are the other half and stayed inline, so guard that the move did
   * not disturb them.
   */
  test("parameter schemas still carry their own descriptions", () => {
    for (const { name, tool } of builtins) {
      const schema = parameters(tool) as { properties?: Record<string, { description?: string }> }
      const documented = Object.values(schema.properties ?? {}).filter(
        (property) => (property.description ?? "").length > 0,
      )
      expect(documented.length, name).toBeGreaterThan(0)
    }
  })
})
