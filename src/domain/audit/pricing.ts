import type { UsageMetrics } from "./types"

export const PRICING_MODE = "builtin-default"
export const PRICING_CATALOG_VERSION = "builtin-v1"

const GPT_5_4_INPUT_TIER_BREAKPOINT = 272_000
const MODEL_PRICE_PER_1K_TOKENS: Array<[string, number, number, number]> = [
  ["gpt-5.3-codex", 0.00175, 0.000175, 0.014],
  ["gpt-5.2-codex", 0.00175, 0.000175, 0.014],
  ["gpt-5.2", 0.00175, 0.000175, 0.014],
  ["gpt-5.1-codex-mini", 0.00025, 0.000025, 0.002],
  ["gpt-5.1-codex-max", 0.00125, 0.000125, 0.01],
  ["gpt-5.1-codex", 0.00125, 0.000125, 0.01],
  ["gpt-5.1", 0.00125, 0.000125, 0.01],
  ["gpt-5-codex", 0.00125, 0.000125, 0.01],
  ["gpt-5", 0.00125, 0.000125, 0.01],
  ["gpt-4.1", 0.002, 0.002, 0.008],
  ["gpt-4o", 0.0025, 0.0025, 0.01],
  ["gpt-4", 0.03, 0.03, 0.06],
  ["claude-3-7", 0.003, 0.003, 0.015],
  ["claude-3-5", 0.003, 0.003, 0.015],
  ["claude-3", 0.003, 0.003, 0.015],
]

type ModelPriceRates = {
  inputUsdPer1K: number
  cachedInputUsdPer1K: number
  outputUsdPer1K: number
}

function normalizeNonNegativeInt(value: unknown) {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.floor(numeric))
}

function normalizeNullableNonNegativeNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, numeric)
}

function resolveModelPricePer1K(model: string | null | undefined, inputTokensTotal: number): ModelPriceRates | null {
  const normalized = String(model ?? "")
    .trim()
    .toLowerCase()
  if (!normalized) return null

  if (normalized.startsWith("gpt-5.5-pro") || normalized.startsWith("gpt-5.4-pro")) {
    if (inputTokensTotal > GPT_5_4_INPUT_TIER_BREAKPOINT) {
      return { inputUsdPer1K: 0.06, cachedInputUsdPer1K: 0.06, outputUsdPer1K: 0.27 }
    }
    return { inputUsdPer1K: 0.03, cachedInputUsdPer1K: 0.03, outputUsdPer1K: 0.18 }
  }

  if (normalized.startsWith("gpt-5.5") || normalized.startsWith("gpt-5.4")) {
    if (inputTokensTotal > GPT_5_4_INPUT_TIER_BREAKPOINT) {
      return { inputUsdPer1K: 0.005, cachedInputUsdPer1K: 0.0005, outputUsdPer1K: 0.0225 }
    }
    return { inputUsdPer1K: 0.0025, cachedInputUsdPer1K: 0.00025, outputUsdPer1K: 0.015 }
  }

  for (const [prefix, inputUsdPer1K, cachedInputUsdPer1K, outputUsdPer1K] of MODEL_PRICE_PER_1K_TOKENS) {
    if (!normalized.startsWith(prefix)) continue
    return {
      inputUsdPer1K,
      cachedInputUsdPer1K,
      outputUsdPer1K,
    }
  }

  return null
}

function roundEstimatedCostUsd(value: number) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000
}

export function estimateUsageCostUsd(input: {
  model?: string | null
  promptTokens?: number | null
  cachedInputTokens?: number | null
  completionTokens?: number | null
}) {
  const promptTokens = normalizeNonNegativeInt(input.promptTokens)
  const cachedInputTokens = Math.min(promptTokens, normalizeNonNegativeInt(input.cachedInputTokens))
  const completionTokens = normalizeNonNegativeInt(input.completionTokens)
  if (promptTokens <= 0 && cachedInputTokens <= 0 && completionTokens <= 0) return null
  const rates = resolveModelPricePer1K(input.model ?? null, promptTokens)
  if (!rates) return null
  const billableInputTokens = Math.max(0, promptTokens - cachedInputTokens)
  return roundEstimatedCostUsd(
    (billableInputTokens / 1000) * rates.inputUsdPer1K +
      (cachedInputTokens / 1000) * rates.cachedInputUsdPer1K +
      (completionTokens / 1000) * rates.outputUsdPer1K,
  )
}

export function withEstimatedUsageCost(usage: UsageMetrics, model: string | null | undefined): UsageMetrics {
  const normalizedEstimatedCostUsd = normalizeNullableNonNegativeNumber(usage.estimatedCostUsd)
  if (normalizedEstimatedCostUsd !== null) {
    return {
      ...usage,
      estimatedCostUsd: normalizedEstimatedCostUsd,
    }
  }
  const estimatedCostUsd = estimateUsageCostUsd({
    model,
    promptTokens: usage.promptTokens,
    cachedInputTokens: usage.cachedInputTokens,
    completionTokens: usage.completionTokens,
  })
  if (estimatedCostUsd === null) return usage
  return {
    ...usage,
    estimatedCostUsd,
  }
}
