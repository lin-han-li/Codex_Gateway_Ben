import type { StoredAccount } from "../../types"
import type { AccountQuotaSnapshot } from "./quota"

type DerivedAvailabilityState = {
  routing: {
    state: "eligible" | "soft_drained" | "excluded"
    reason: string | null
  }
  abnormalState?: {
    reason?: string | null
  } | null
}

export function createAutomaticAccountAvailabilityResolver(deps: {
  getQuotaSnapshot: (account: StoredAccount) => AccountQuotaSnapshot | null
  resolveDerivedState: (accountId: string, quota?: AccountQuotaSnapshot | null) => DerivedAvailabilityState
  makeStatusError: (statusCode: number, message: string) => unknown
}) {
  function resolveAutomaticAccountAvailability(input: {
    account: StoredAccount
    quota?: AccountQuotaSnapshot | null
    now?: number
  }) {
    if (!input.account.accessToken) {
      return {
        ok: false as const,
        reason: "account_access_token_missing",
        message: "Account access token is unavailable and cannot be used for routing",
        derived: null as DerivedAvailabilityState | null,
      }
    }

    const quota = input.quota !== undefined ? input.quota : deps.getQuotaSnapshot(input.account)
    const derived = deps.resolveDerivedState(input.account.id, quota)
    if (derived.routing.state === "eligible") {
      return {
        ok: true as const,
        reason: null,
        message: null,
        derived,
      }
    }

    const reason = derived.routing.reason ?? derived.abnormalState?.reason ?? "routing_excluded"
    let message = "Account is unavailable for routing"
    if (derived.routing.state === "soft_drained") {
      message = "Account quota is too low and has been excluded from routing"
    } else {
      switch (reason) {
        case "quota_exhausted_cooldown":
        case "quota_headroom_exhausted":
          message = "Account quota is exhausted and has been excluded from routing"
          break
        default:
          message = "Account is unhealthy and has been excluded from routing"
          break
      }
    }

    return {
      ok: false as const,
      reason,
      message: `${message} (${reason})`,
      derived,
    }
  }

  function ensureAutomaticAccountAvailable(account: StoredAccount, statusCode = 503) {
    const availability = resolveAutomaticAccountAvailability({ account })
    if (!availability.ok) {
      throw deps.makeStatusError(statusCode, availability.message)
    }
    return availability
  }

  return {
    resolveAutomaticAccountAvailability,
    ensureAutomaticAccountAvailable,
  }
}
