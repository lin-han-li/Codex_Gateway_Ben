export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function getStatusErrorCode(error: unknown) {
  const status = Number((error as { statusCode?: unknown } | null)?.statusCode ?? NaN)
  if (!Number.isFinite(status)) return null
  const normalized = Math.floor(status)
  if (normalized < 100 || normalized > 599) return null
  return normalized
}

export function isLikelyAuthError(error: unknown) {
  const text = errorMessage(error).toLowerCase()
  return (
    text.includes("unauthorized") ||
    text.includes("authorization") ||
    text.includes("access token") ||
    text.includes("refresh token") ||
    text.includes("token exchange") ||
    text.includes("token refresh")
  )
}

export function isTransientUpstreamStatus(status: number) {
  return Number.isFinite(status) && status >= 500 && status <= 599
}

export function detectTransientUpstreamError(error: unknown) {
  const status = Number(getStatusErrorCode(error) ?? NaN)
  if (isTransientUpstreamStatus(status)) {
    return {
      matched: true as const,
      reason: `upstream_http_${status}`,
    }
  }

  const text = errorMessage(error).toLowerCase()
  if (
    [
      "unable to connect",
      "typo in the url or port",
      "socket connection was closed unexpectedly",
      "fetch failed",
      "connection refused",
      "connection reset",
      "timed out",
      "econnrefused",
      "econnreset",
      "etimedout",
      "ehostunreach",
      "enotfound",
    ].some((needle) => text.includes(needle))
  ) {
    return {
      matched: true as const,
      reason: "upstream_transport_error",
    }
  }

  return { matched: false as const }
}

export function detectRoutingBlockedAccount(input: { statusCode?: number | null; text?: string | null; error?: unknown }) {
  const status = Number(input.statusCode ?? getStatusErrorCode(input.error) ?? NaN)
  const corpus = [input.text, input.error ? errorMessage(input.error) : ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  const exactMatches: Array<[string, string]> = [
    ["account_deactivated", "account_deactivated"],
    ["account has been deactivated", "account_deactivated"],
    ["deactivated_workspace", "workspace_deactivated"],
    ["workspace has been deactivated", "workspace_deactivated"],
    ["workspace is deactivated", "workspace_deactivated"],
    ["deactivated workspace", "workspace_deactivated"],
    ["token refresh failed: 401", "refresh_unauthorized"],
    ["refresh failed: 401", "refresh_unauthorized"],
    ["invalid_grant", "refresh_invalid_grant"],
    ["invalid refresh token", "refresh_invalid"],
    ["refresh token is not available", "refresh_token_missing"],
    ["expired refresh token", "refresh_token_expired"],
    ["login required", "login_required"],
  ]
  for (const [needle, reason] of exactMatches) {
    if (corpus.includes(needle)) {
      return {
        matched: true as const,
        reason,
      }
    }
  }

  if (
    [
      /\bis ban(?:ned)?\b/i,
      /\bip(?:v[46])?\b.*\bban(?:ned)?\b/i,
      /\borigin\b.*\bban(?:ned)?\b/i,
      /\bhost\b.*\bban(?:ned)?\b/i,
      /\btemporar(?:ily)? banned\b/i,
    ].some((pattern) => pattern.test(corpus))
  ) {
    return {
      matched: true as const,
      reason: "upstream_banned",
    }
  }

  if ((status === 401 || status === 403) && isLikelyAuthError(input.error ?? corpus)) {
    return {
      matched: true as const,
      reason: status === 403 ? "upstream_forbidden" : "upstream_unauthorized",
    }
  }

  return { matched: false as const }
}

export function buildUpstreamAccountUnavailableFailure(input: {
  routingMode: string
  retryAfter?: string | null
}) {
  const headers = new Headers({
    "content-type": "application/json",
  })
  if (input.retryAfter) {
    headers.set("retry-after", input.retryAfter)
  }
  return {
    status: 503,
    headers,
    bodyText: JSON.stringify({
      error: {
        message:
          input.routingMode === "pool"
            ? "No healthy accounts available for pool routing"
            : "Upstream account is unavailable",
        type: "service_unavailable",
        code: "upstream_account_unavailable",
      },
    }),
  }
}

export function normalizeCaughtCodexFailure(input: {
  error: unknown
  routingMode: string
  retryAfter?: string | null
}) {
  const blocked = detectRoutingBlockedAccount({
    error: input.error,
  })
  if (blocked.matched) {
    return buildUpstreamAccountUnavailableFailure({
      routingMode: input.routingMode,
      retryAfter: input.retryAfter,
    })
  }

  if (input.routingMode !== "pool") {
    return null
  }

  const transient = detectTransientUpstreamError(input.error)
  if (transient.matched) {
    return buildUpstreamAccountUnavailableFailure({
      routingMode: input.routingMode,
      retryAfter: input.retryAfter,
    })
  }

  const status = Number(getStatusErrorCode(input.error) ?? NaN)
  if (isTransientUpstreamStatus(status)) {
    return buildUpstreamAccountUnavailableFailure({
      routingMode: input.routingMode,
      retryAfter: input.retryAfter,
    })
  }

  return null
}
