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

describe("tool descriptions", () => {
  test("the baseline covers every registered tool", () => {
    expect(Object.keys(baseline).sort()).toEqual(builtins.map((entry) => entry.name).sort())
  })

  for (const { name, tool } of builtins) {
    describe(name, () => {
      test("is byte-identical to the text captured before the move", () => {
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
