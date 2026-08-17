import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import { Data } from "effect"

/**
 * The provider could not even be constructed — no key, or a name we do not know.
 *
 * The field is `message`, not `reason`, and that is load-bearing rather than
 * cosmetic. Effect's TaggedError populates `Error.message` from a `message`
 * prop and leaves it empty otherwise, and every layer downstream — classify,
 * describe, the CLI's explain — reads `.message`. Named anything else, a
 * missing API key exits 1 having printed a blank line.
 */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly providerID: string
  readonly message: string
}> {}

export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
}

/**
 * What a model can hold. `context` is the whole window; `input` is the separate
 * input ceiling some providers impose, which is lower and therefore binding
 * when it exists.
 *
 * opencode reads this from models.dev, a catalog they maintain. We have none
 * yet, so this is a small table with a deliberately conservative fallback: an
 * unrecognised model is assumed to have the smallest window we would plausibly
 * meet. Guessing high means learning the truth as a failed request partway
 * through a conversation; guessing low only compacts somewhat early.
 */
export interface ModelLimit {
  readonly context: number
  readonly output: number
  readonly input?: number
}

const FALLBACK_LIMIT: ModelLimit = { context: 128_000, output: 8_192 }

const LIMITS: Record<string, ModelLimit> = {
  "anthropic/claude-opus-4": { context: 200_000, output: 32_000 },
  "anthropic/claude-sonnet-4": { context: 200_000, output: 64_000 },
  "anthropic/claude-haiku-4": { context: 200_000, output: 64_000 },
  "openai/gpt-4.1": { context: 1_047_576, output: 32_768 },
  "openai/gpt-4o": { context: 128_000, output: 16_384 },
  "openai/o3": { context: 200_000, output: 100_000 },
}

/** Longest-prefix match, so `claude-sonnet-4-5-20260101` still resolves to its family. */
export function modelLimit(ref: ModelRef): ModelLimit {
  const key = `${ref.providerID}/${ref.modelID}`
  const exact = LIMITS[key]
  if (exact) return exact
  const prefix = Object.keys(LIMITS)
    .filter((candidate) => key.startsWith(candidate))
    .sort((a, b) => b.length - a.length)[0]
  return prefix === undefined ? FALLBACK_LIMIT : LIMITS[prefix]!
}

export const defaultModel: ModelRef = {
  providerID: process.env["COMPASS_PROVIDER"] ?? "anthropic",
  modelID: process.env["COMPASS_MODEL"] ?? "claude-sonnet-4-5",
}

/** Accepts "provider/model"; falls back to the configured default. */
export function parseModel(value: string | undefined): ModelRef {
  if (!value) return defaultModel
  const slash = value.indexOf("/")
  if (slash === -1) return { providerID: defaultModel.providerID, modelID: value }
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

export function resolveModel(ref: ModelRef): LanguageModel {
  switch (ref.providerID) {
    case "anthropic": {
      const apiKey = process.env["ANTHROPIC_API_KEY"]
      if (!apiKey)
        throw new ProviderError({
          providerID: ref.providerID,
          message: "ANTHROPIC_API_KEY is not set. Export it and try again.",
        })
      return createAnthropic({ apiKey })(ref.modelID)
    }
    case "openai": {
      const apiKey = process.env["OPENAI_API_KEY"]
      if (!apiKey)
        throw new ProviderError({
          providerID: ref.providerID,
          message: "OPENAI_API_KEY is not set. Export it and try again.",
        })
      return createOpenAI({ apiKey })(ref.modelID)
    }
    default:
      throw new ProviderError({
        providerID: ref.providerID,
        message: `Unknown provider "${ref.providerID}". Known providers: anthropic, openai.`,
      })
  }
}
