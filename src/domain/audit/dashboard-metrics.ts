import type { DashboardMetrics, PoolRemainingMetrics, ServiceStatusSummary } from "./types"

type DashboardAccount = {
  id: string
  isActive: boolean
}

type DashboardVirtualKey = {
  isRevoked: boolean
  routingMode: string
}

type DashboardTodaySummary = {
  stats: {
    billableTokens?: number | null
    cachedInputTokens?: number | null
    reasoningOutputTokens?: number | null
    estimatedCostUsd?: number | null
    requestCount?: number | null
  } | null
  unpricedRequestCount: number
}

type PublicDerivedState = {
  health: unknown
  routing: {
    state: "eligible" | "soft_drained" | "excluded"
  }
  abnormalState: {
    category: string
  } | null
}

export type BuildDashboardMetricsDeps = {
  now?: number
  listProviders: () => Array<unknown>
  listAccounts: () => DashboardAccount[]
  listVirtualKeys: () => DashboardVirtualKey[]
  getTodaySummary: (now: number) => DashboardTodaySummary
  buildPoolRemainingMetrics: (now: number) => PoolRemainingMetrics
  resolvePublicAccountDerivedState: (accountId: string) => PublicDerivedState
  getUsageTotalsSnapshot: () => Record<string, unknown>
  buildServiceStatusSummary: (now: number) => ServiceStatusSummary
  statsTimezone: string
  pricingMode: string
  pricingCatalogVersion: string
}

export function buildDashboardMetrics(deps: BuildDashboardMetricsDeps): DashboardMetrics {
  const now = deps.now ?? Date.now()
  const accounts = deps.listAccounts()
  const keys = deps.listVirtualKeys()
  const todaySummary = deps.getTodaySummary(now)
  const todayStats = todaySummary.stats
  const todayTokens = Math.max(0, Math.floor(Number(todayStats?.billableTokens ?? 0)))
  const cachedInputTokens = Math.max(0, Math.floor(Number(todayStats?.cachedInputTokens ?? 0)))
  const reasoningOutputTokens = Math.max(0, Math.floor(Number(todayStats?.reasoningOutputTokens ?? 0)))
  const estimatedCostUsd = Math.max(0, Number(todayStats?.estimatedCostUsd ?? 0))
  const todayRequestCount = Math.max(0, Math.floor(Number(todayStats?.requestCount ?? 0)))
  const poolRemaining = deps.buildPoolRemainingMetrics(now)
  const abnormalByCategory: Record<string, number> = {
    normal: 0,
    quota_exhausted: 0,
    banned: 0,
    access_banned: 0,
    auth_invalid: 0,
    soft_drained: 0,
    transient: 0,
    unknown: 0,
  }

  let accountsHealthy = 0
  let accountsUnhealthy = 0
  let accountsEligible = 0
  let accountsSoftDrained = 0
  let accountsExcluded = 0

  for (const account of accounts) {
    const derived = deps.resolvePublicAccountDerivedState(account.id)
    if (derived.health) accountsUnhealthy += 1
    else accountsHealthy += 1

    if (derived.routing.state === "eligible") accountsEligible += 1
    else if (derived.routing.state === "soft_drained") accountsSoftDrained += 1
    else accountsExcluded += 1

    const category = derived.abnormalState?.category ?? "normal"
    abnormalByCategory[category] = (abnormalByCategory[category] ?? 0) + 1
  }

  return {
    refreshedAt: now,
    providersTotal: deps.listProviders().length,
    accountsTotal: accounts.length,
    accountsActive: accounts.filter((item) => item.isActive).length,
    accountsHealthy,
    accountsUnhealthy,
    accountsEligible,
    accountsSoftDrained,
    accountsExcluded,
    abnormalByCategory,
    virtualKeysTotal: keys.length,
    virtualKeysRevoked: keys.filter((item) => item.isRevoked).length,
    virtualKeysPool: keys.filter((item) => item.routingMode === "pool").length,
    virtualKeysSingle: keys.filter((item) => item.routingMode === "single").length,
    usageTotals: deps.getUsageTotalsSnapshot(),
    todayTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    estimatedCostUsd,
    unpricedRequestCount: todaySummary.unpricedRequestCount,
    todayRequestCount,
    poolRemaining,
    statsTimezone: deps.statsTimezone,
    pricingMode: deps.pricingMode,
    pricingCatalogVersion: deps.pricingCatalogVersion,
    serviceStatusSummary: deps.buildServiceStatusSummary(now),
  }
}
