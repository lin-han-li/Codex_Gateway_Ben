export type UsageMetrics = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  estimatedCostUsd: number | null
  reasoningEffort: string | null
}

export type PoolRemainingMetrics = {
  primaryRemainPercent: number | null
  secondaryRemainPercent: number | null
  knownPrimaryCount: number
  knownSecondaryCount: number
  eligibleAccountCount: number
  quotaKnownAccountCount: number
  refreshedAt?: number
}

export type ServiceStatusSummary = {
  serviceOnline: boolean
  activeLocalServiceAddress: string
  bindServiceAddress: string
  preferredClientServiceAddress: string
  lanServiceAddresses: string[]
  managementAuthEnabled: boolean
  encryptionKeyConfigured: boolean
  upstreamPrivacyStrict: boolean
  officialStrictPassthrough: boolean
  officialAssets?: {
    clientVersion: string
    clientVersionSource: {
      kind: string
      path: string | null
    }
    promptSource: {
      kind: string
      path: string | null
    }
    modelsSource: {
      kind: string
      path: string | null
    }
    modelsFile: string | null
  }
  restartRequired: boolean
  checkedAt: number
}

export type DashboardMetrics = {
  refreshedAt: number
  providersTotal: number
  accountsTotal: number
  accountsActive: number
  accountsHealthy: number
  accountsUnhealthy: number
  accountsEligible: number
  accountsSoftDrained: number
  accountsExcluded: number
  abnormalByCategory: Record<string, number>
  virtualKeysTotal: number
  virtualKeysRevoked: number
  virtualKeysPool: number
  virtualKeysSingle: number
  usageTotals: Record<string, unknown>
  todayTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  estimatedCostUsd: number
  unpricedRequestCount: number
  todayRequestCount: number
  poolRemaining: PoolRemainingMetrics
  statsTimezone: string
  pricingMode: string
  pricingCatalogVersion: string
  serviceStatusSummary: ServiceStatusSummary
}
