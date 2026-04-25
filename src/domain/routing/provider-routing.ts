import type { StoredAccount } from "../../types"
import {
  resolveAccountPlanCohort,
  selectPreferredPlanCohort,
  type AccountPlanCohort,
} from "../accounts/quota"

export type ProviderRoutingHints = {
  excludeAccountIds: string[]
  deprioritizedAccountIds: string[]
  headroomByAccountId: Map<string, number>
  pressureScoreByAccountId: Map<string, number>
  preferredPlanCohort: AccountPlanCohort | null
}

export type ProviderRoutingHintsOptions = {
  allowTransientUnhealthy?: boolean
  preferredPlanCohort?: AccountPlanCohort | null
  cohortMode?: "strict" | "prefer" | "off"
}

function normalizeIdentityText(value: unknown) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : null
}

export function buildProviderRoutingHintsFromState(input: {
  providerId: string
  accounts: StoredAccount[]
  headroomByAccountId: Map<string, number>
  pressureScoreByAccountId: Map<string, number>
  quotaExcludedAccountIds?: Iterable<string>
  unhealthyExcludedAccountIds?: Iterable<string>
  consistencyExcludedAccountIds?: Iterable<string>
  deprioritizedAccountIds?: Iterable<string>
  preferredPlanCohort?: AccountPlanCohort | null
  cohortMode?: "strict" | "prefer" | "off"
}) {
  const normalizedProviderId = normalizeIdentityText(input.providerId)?.toLowerCase()
  const deprioritized = new Set(input.deprioritizedAccountIds ?? [])
  const excluded = new Set([
    ...(input.quotaExcludedAccountIds ?? []),
    ...(input.unhealthyExcludedAccountIds ?? []),
    ...(input.consistencyExcludedAccountIds ?? []),
  ])
  const cohortMode = input.cohortMode ?? "prefer"
  let preferredPlanCohort: AccountPlanCohort | null = input.preferredPlanCohort ?? null

  if (normalizedProviderId === "chatgpt" && cohortMode !== "off") {
    const candidates = input.accounts.filter(
      (account) =>
        account.providerId.toLowerCase() === "chatgpt" &&
        Boolean(account.accessToken) &&
        !excluded.has(account.id),
    )
    if (!(cohortMode === "strict" && preferredPlanCohort)) {
      preferredPlanCohort = selectPreferredPlanCohort({
        candidates,
        pressureScoreByAccountId: input.pressureScoreByAccountId,
        headroomByAccountId: input.headroomByAccountId,
        preferredPlanCohort,
      })
    }
    if (preferredPlanCohort) {
      for (const account of candidates) {
        if (resolveAccountPlanCohort(account) !== preferredPlanCohort) {
          if (cohortMode === "strict") {
            excluded.add(account.id)
          } else {
            deprioritized.add(account.id)
          }
        }
      }
    }
  }

  return {
    excludeAccountIds: [...excluded],
    deprioritizedAccountIds: [...deprioritized].filter((accountId) => !excluded.has(accountId)),
    headroomByAccountId: input.headroomByAccountId,
    pressureScoreByAccountId: input.pressureScoreByAccountId,
    preferredPlanCohort: cohortMode === "off" ? null : preferredPlanCohort,
  }
}

export function buildRelaxedProviderRoutingHintsFromState(
  input: Omit<Parameters<typeof buildProviderRoutingHintsFromState>[0], "cohortMode">,
) {
  return buildProviderRoutingHintsFromState({
    ...input,
    cohortMode: "off",
  })
}
