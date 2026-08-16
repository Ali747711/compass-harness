import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import { Data } from "effect"

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly providerID: string
  readonly reason: string
}> {}

export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
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
      if (!apiKey) throw new ProviderError({ providerID: ref.providerID, reason: "ANTHROPIC_API_KEY is not set" })
      return createAnthropic({ apiKey })(ref.modelID)
    }
    case "openai": {
      const apiKey = process.env["OPENAI_API_KEY"]
      if (!apiKey) throw new ProviderError({ providerID: ref.providerID, reason: "OPENAI_API_KEY is not set" })
      return createOpenAI({ apiKey })(ref.modelID)
    }
    default:
      throw new ProviderError({ providerID: ref.providerID, reason: `unknown provider "${ref.providerID}"` })
  }
}
