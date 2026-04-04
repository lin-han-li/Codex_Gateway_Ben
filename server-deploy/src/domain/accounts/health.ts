export type AccountHealthSnapshot = {
  status: "error"
  reason: string
  source: string
  updatedAt: number
  expiresAt: number | null
}

export function normalizeAccountHealthReason(reason: string) {
  const normalized = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return "upstream_auth_error"
  return normalized.slice(0, 240)
}

export function isStickyAccountHealthReason(reason: string) {
  switch (normalizeAccountHealthReason(reason)) {
    case "account_deactivated":
    case "workspace_deactivated":
    case "upstream_banned":
    case "upstream_forbidden":
    case "refresh_unauthorized":
    case "refresh_invalid_grant":
    case "refresh_invalid":
    case "refresh_token_missing":
    case "refresh_token_expired":
    case "login_required":
      return true
    default:
      return false
  }
}

export function isStickyAccountHealthSnapshot(snapshot?: AccountHealthSnapshot | null) {
  return Boolean(snapshot && isStickyAccountHealthReason(snapshot.reason))
}

export function resolveAccountHealthExpiry(reason: string, transientCooldownMs: number, now = Date.now()) {
  return isStickyAccountHealthReason(reason) ? null : now + transientCooldownMs
}

export function getActiveAccountHealthSnapshot(
  cache: Map<string, AccountHealthSnapshot>,
  accountId: string | null | undefined,
  normalizeIdentity: (value?: string | null | undefined) => string | undefined,
  now = Date.now(),
) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return null
  const snapshot = cache.get(normalizedAccountId)
  if (!snapshot) return null
  if (snapshot.expiresAt !== null && snapshot.expiresAt <= now) {
    cache.delete(normalizedAccountId)
    return null
  }
  return snapshot
}

export function canClearStickyAccountHealth(snapshot: AccountHealthSnapshot, source: string) {
  const normalizedSource = String(source ?? "").trim().toLowerCase()
  const reason = normalizeAccountHealthReason(snapshot.reason)
  if (normalizedSource === "responses" || normalizedSource === "chat") {
    return true
  }
  if (
    normalizedSource === "refresh" ||
    normalizedSource === "account-refresh" ||
    normalizedSource === "refresh-token-import" ||
    normalizedSource === "refresh-token-import-refresh"
  ) {
    return reason === "login_required" || reason.startsWith("refresh_")
  }
  return false
}
