import { messageID, partID, sessionID, type Part } from "@compass/schema"
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_KEEP_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
  buildPrompt,
  estimateTokens,
  lastCompaction,
  select,
  serialize,
  summaryFits,
  type Entry,
} from "../src/session/compaction"

const ids = { messageID: messageID(), sessionID: sessionID() }

const text = (value: string): Part => ({ id: partID(), ...ids, type: "text", text: value })

const tool = (over: Partial<Extract<Part, { type: "tool" }>> = {}): Part => ({
  id: partID(),
  ...ids,
  type: "tool",
  callID: "c1",
  tool: "read",
  state: "completed",
  input: { filePath: "a.ts" },
  output: "file contents",
  ...over,
})

const user = (value: string): Entry => ({ info: { role: "user" }, parts: [text(value)] })
const assistant = (...parts: Part[]): Entry => ({ info: { role: "assistant" }, parts })

describe("serialize", () => {
  test("labels each speaker so the summarizer reads a transcript", () => {
    expect(serialize(user("fix the build"))).toBe("[User]: fix the build")
    expect(serialize(assistant(text("on it")))).toBe("[Assistant]: on it")
  })

  test("keeps a tool call next to the result it produced", () => {
    expect(serialize(assistant(tool()))).toBe(
      '[Assistant tool call]: read({"filePath":"a.ts"})\n[Tool result]: file contents',
    )
  })

  test("records a failed tool as failed rather than dropping it", () => {
    expect(serialize(assistant(tool({ state: "error", error: "ENOENT" })))).toContain("[Tool error]: ENOENT")
  })

  test("shows an unsettled call without inventing a result for it", () => {
    const rendered = serialize(assistant(tool({ state: "running" })))
    expect(rendered).toContain("[Assistant tool call]")
    expect(rendered).not.toContain("[Tool result]")
  })

  /** Tool output is the bulk of a transcript and the least worth preserving in full. */
  test("clips oversized tool output", () => {
    const rendered = serialize(assistant(tool({ output: "x".repeat(5_000) })))
    expect(rendered).toContain("[truncated]")
    expect(rendered.length).toBeLessThan(3_000)
  })

  /**
   * Reasoning is stored but never replayed, so it was never in the context this
   * summary shrinks. Feeding it to the summarizer would inflate the prompt with
   * content that costs nothing — and reasoning often exceeds the reply, so it
   * could push past summaryFits and disable compaction altogether.
   */
  test("leaves reasoning out, since it never reached the provider", () => {
    const reasoning: Part = { id: partID(), ...ids, type: "reasoning", text: "a long internal monologue" }
    expect(serialize(assistant(reasoning, text("the answer")))).toBe("[Assistant]: the answer")
  })

  test("renders nothing for a message with no content", () => {
    expect(serialize(assistant())).toBe("")
  })
})

describe("select", () => {
  test("keeps recent turns verbatim and hands the rest to the summary", () => {
    const entries = Array.from({ length: 40 }, (_, i) => user("x".repeat(4_000) + i))
    const selected = select(entries, 2_000)

    expect(selected).toBeDefined()
    expect(selected!.head.length).toBeGreaterThan(0)
    // The newest turn is the one that must survive intact.
    expect(selected!.recent).toContain("39")
    expect(selected!.head).not.toContain(selected!.recent)
  })

  test("keeps everything when the whole conversation fits the budget", () => {
    const selected = select([user("short"), assistant(text("also short"))], DEFAULT_KEEP_TOKENS)
    expect(selected!.head).toBe("")
    expect(selected!.recent).toContain("[User]: short")
  })

  /**
   * A single turn bigger than the whole budget goes into the summary and the
   * verbatim tail comes back empty.
   *
   * This looks lossy — the newest turn is exactly what you would want to keep —
   * but the alternative is worse. Keeping a turn that alone exceeds the budget
   * means the next request overflows again, compaction runs again, and the
   * session loops without ever shrinking. Summarizing everything terminates.
   */
  test("summarizes even the newest turn when it alone exceeds the budget", () => {
    const selected = select([user("old"), user("y".repeat(100_000))], 100)
    expect(selected!.recent).toBe("")
    expect(selected!.head).toContain("yyy")
  })

  test("reports nothing to do for an empty conversation", () => {
    expect(select([], DEFAULT_KEEP_TOKENS)).toBeUndefined()
    expect(select([assistant()], DEFAULT_KEEP_TOKENS)).toBeUndefined()
  })

  /** A prior summary is fed in separately; re-serializing it would nest summaries. */
  test("excludes an existing compaction marker from the conversation", () => {
    const marker: Entry = {
      info: { role: "assistant" },
      parts: [{ id: partID(), ...ids, type: "compaction", summary: "S", recent: "R" }],
    }
    const selected = select([marker, user("after")], DEFAULT_KEEP_TOKENS)
    expect(selected!.recent).toBe("[User]: after")
    expect(`${selected!.head}${selected!.recent}`).not.toContain("S")
  })
})

describe("buildPrompt", () => {
  test("asks for a fresh summary when there is no prior one", () => {
    const prompt = buildPrompt({ context: ["[User]: hello"] })
    expect(prompt).toContain("<conversation>")
    expect(prompt).toContain("## Objective")
    expect(prompt).not.toContain("<prior-summary>")
  })

  /** The recursive case: the second compaction summarizes the first summary. */
  test("carries a prior summary in and warns that dropping it loses it", () => {
    const prompt = buildPrompt({ previousSummary: "## Objective\n- ship", context: ["[User]: next"] })
    expect(prompt).toContain("<prior-summary>")
    expect(prompt).toContain("anything you do not carry into the new summary is lost")
  })
})

describe("summaryFits", () => {
  /**
   * The circular failure this exists to prevent: compaction runs because the
   * context is full, and its prompt is built out of that same context.
   */
  test("refuses a summary request that would itself overflow", () => {
    const huge = "x".repeat(200_000 * 4)
    expect(summaryFits(huge, { context: 200_000, output: 64_000 })).toBe(false)
  })

  test("allows one that fits with the reply budget reserved", () => {
    const small = "x".repeat(1_000)
    expect(summaryFits(small, { context: 200_000, output: 64_000 })).toBe(true)
  })

  test("reserves the summary's own output even when the model reports none", () => {
    const prompt = "x".repeat((200_000 - SUMMARY_OUTPUT_TOKENS + 100) * 4)
    expect(summaryFits(prompt, { context: 200_000, output: 0 })).toBe(false)
  })
})

describe("lastCompaction", () => {
  test("finds the most recent boundary, not the first", () => {
    const marker = (summary: string): Entry => ({
      info: { role: "assistant" },
      parts: [{ id: partID(), ...ids, type: "compaction", summary, recent: "" }],
    })
    const found = lastCompaction([marker("first"), user("a"), marker("second"), user("b")])
    expect(found).toBeDefined()
    expect(found!.index).toBe(2)
    expect((found!.part as { summary: string }).summary).toBe("second")
  })

  test("reports none for a conversation that was never compacted", () => {
    expect(lastCompaction([user("a"), assistant(text("b"))])).toBeUndefined()
  })
})

describe("estimateTokens", () => {
  test("scales with length", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("x".repeat(400))).toBe(100)
  })
})
