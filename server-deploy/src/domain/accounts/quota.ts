import type { StoredAccount } from "../../types"

export const DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS = 90 * 1000

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  windowSeconds: number | null
  windowMinutes: number | null
  resetsAt: number | null
}

export type AccountQuotaEntry = {
  limitId: string | null
  limitName: string | null
  primary: AccountQuotaWindow | null
  secondary: AccountQuotaWindow | null
}

export type AccountQuotaSnapshot = {
  status: "ok" | "error" | "unavailable"
  fetchedAt: number
  planType: string | null
  primary: AccountQuotaEntry | null
  additional: AccountQuotaEntry[]
  error: string | null
}

export type AccountPlanCohort = "free" | "paid" | "unknown"

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function asFiniteNumber(value: unknown) {
  const numeric = Number(value ?? NaN)
  if (!Number.isFinite(numeric)) return null
  return numeric
}

function toEpochMs(value: number | null) {
  if (!Number.isFinite(value ?? NaN)) return null
  if (!value) return null
  return value < 1_000_000_000_000 ? Math.floor(value * 1000) : Math.floor(value)
}

function normalizeIdentityText(value: unknown) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : null
}

export function normalizeQuotaWindow(window: unknown): AccountQuotaWindow | null {
  const record = asObjectRecord(window)
  if (!record) return null

  const usedNumeric = asFiniteNumber(record.used_percent)
  if (!Number.isFinite(usedNumeric ?? NaN)) return null
  const usedPercent = Math.max(0, Math.min(100, Math.round(usedNumeric ?? 0)))
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))

  const windowSecondsRaw = asFiniteNumber(record.limit_window_seconds)
  const windowSeconds = Number.isFinite(windowSecondsRaw ?? NaN) ? Math.max(0, Math.floor(windowSecondsRaw ?? 0)) : null
  const windowMinutes = Number.isFinite(windowSecondsRaw ?? NaN) ? Math.max(0, Math.floor((windowSecondsRaw ?? 0) / 60)) : null
  const resetsAt = toEpochMs(asFiniteNumber(record.reset_at))

  return {
    usedPercent,
    remainingPercent,
    windowSeconds,
    windowMinutes,
    resetsAt,
  }
}

export function normalizeQuotaEntry(rateLimit: unknown, limitId: string | null, limitName: string | null): AccountQuotaEntry | null {
  const details = asObjectRecord(rateLimit)
  if (!details) return null
  const primary = normalizeQuotaWindow(details.primary_window)
  const secondary = normalizeQuotaWindow(details.secondary_window)
  if (!primary && !secondary) return null
  return {
    limitId,
    limitName,
    primary,
    secondary,
  }
}

export function normalizeRateLimitUsagePayload(payload: unknown) {
  const root = asObjectRecord(payload) ?? {}
  const planTypeRaw = String(root.plan_type ?? "").trim()
  const planType = planTypeRaw.length > 0 ? planTypeRaw : null

  const allEntries: AccountQuotaEntry[] = []
  const seenEntryKeys = new Set<string>()
  const pushUniqueEntry = (entry: AccountQuotaEntry | null) => {
    if (!entry) return
    const key = `${entry.limitId ?? ""}::${entry.limitName ?? ""}`
    if (seenEntryKeys.has(key)) return
    seenEntryKeys.add(key)
    allEntries.push(entry)
  }

  const codexEntry = normalizeQuotaEntry(root.rate_limit, "codex", null)
  pushUniqueEntry(codexEntry)

  // OpenAI has started returning code review quota as a dedicated top-level field
  // instead of only via additional_rate_limits.
  const codeReviewEntry = normalizeQuotaEntry(root.code_review_rate_limit, "code_review", "code_review")
  pushUniqueEntry(codeReviewEntry)

  const additionalRaw = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : []
  for (const item of additionalRaw) {
    const row = asObjectRecord(item)
    if (!row) continue
    const meteredFeature = String(row.metered_feature ?? "").trim()
    const limitName = String(row.limit_name ?? "").trim()
    const limitId = meteredFeature.length > 0 ? meteredFeature : limitName.length > 0 ? limitName : null
    const entry = normalizeQuotaEntry(row.rate_limit, limitId, limitName || null)
    pushUniqueEntry(entry)
  }

  const primary = allEntries.find((item) => item.limitId === "codex") ?? allEntries[0] ?? null
  const additional = allEntries.filter((item) => item !== primary)
  return {
    planType,
    primary,
    additional,
  }
}

export function makeUnavailableQuota(reason?: string): AccountQuotaSnapshot {
  return {
    status: "unavailable",
    fetchedAt: Date.now(),
    planType: null,
    primary: null,
    additional: [],
    error: reason ? String(reason) : null,
  }
}

function defaultErrorFormatter(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error")
}

export function makeQuotaError(
  error: unknown,
  formatError: (error: unknown) => string = defaultErrorFormatter,
): AccountQuotaSnapshot {
  return {
    status: "error",
    fetchedAt: Date.now(),
    planType: null,
    primary: null,
    additional: [],
    error: formatError(error),
  }
}

export function isQuotaCacheFresh(
  snapshot: AccountQuotaSnapshot | undefined | null,
  now = Date.now(),
  ttlMs = DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS,
) {
  if (!snapshot) return false
  return now - Number(snapshot.fetchedAt || 0) <= ttlMs
}

export function resolveQuotaEntryHeadroomPercent(entry: AccountQuotaEntry | null | undefined) {
  if (!entry) return null
  const values = [entry.primary?.remainingPercent, entry.secondary?.remainingPercent].filter((value) =>
    Number.isFinite(value),
  ) as number[]
  if (values.length === 0) return null
  return Math.max(0, Math.min(...values.map((value) => Math.round(value))))
}

export function resolveQuotaSnapshotHeadroomPercent(
  snapshot: AccountQuotaSnapshot | null | undefined,
  now = Date.now(),
  ttlMs = DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS,
) {
  if (!snapshot || snapshot.status !== "ok" || !isQuotaCacheFresh(snapshot, now, ttlMs)) return null
  const values = [snapshot.primary, ...snapshot.additional]
    .map((entry) => resolveQuotaEntryHeadroomPercent(entry))
    .filter((value) => Number.isFinite(value)) as number[]
  if (values.length === 0) return null
  return Math.max(0, Math.min(...values))
}

export function normalizeChatgptPlanType(value: unknown) {
  return normalizeIdentityText(String(value ?? ""))
}

export function resolveAccountPlanCohort(account: StoredAccount): AccountPlanCohort {
  if (String(account.providerId ?? "").trim().toLowerCase() !== "chatgpt") {
    return "unknown"
  }
  const metadata = account.metadata && typeof account.metadata === "object" ? account.metadata : {}
  const raw = normalizeChatgptPlanType(
    (metadata as Record<string, unknown>).chatgptPlanType ??
      (metadata as Record<string, unknown>).chatgpt_plan_type ??
      "",
  )
  if (!raw) return "unknown"
  if (raw.includes("free")) return "free"
  if (
    raw.includes("business") ||
    raw.includes("team") ||
    raw.includes("enterprise") ||
    raw.includes("pro") ||
    raw.includes("plus") ||
    raw.includes("paid")
  ) {
    return "paid"
  }
  return "unknown"
}

export function resolvePlanCohortPriority(cohort: AccountPlanCohort) {
  switch (cohort) {
    case "paid":
      return 0
    case "unknown":
      return 1
    default:
      return 2
  }
}

export function selectPreferredPlanCohort(input: {
  candidates: StoredAccount[]
  pressureScoreByAccountId: Map<string, number>
  headroomByAccountId: Map<string, number>
  preferredPlanCohort?: AccountPlanCohort | null
}) {
  const groups = new Map<
    AccountPlanCohort,
    {
      cohort: AccountPlanCohort
      accounts: StoredAccount[]
      pressureValues: number[]
      headroomValues: number[]
    }
  >()

  for (const account of input.candidates) {
    const cohort = resolveAccountPlanCohort(account)
    const existing = groups.get(cohort) ?? {
      cohort,
      accounts: [],
      pressureValues: [],
      headroomValues: [],
    }
    existing.accounts.push(account)
    const pressure = input.pressureScoreByAccountId.get(account.id)
    if (Number.isFinite(pressure)) existing.pressureValues.push(Number(pressure))
    const headroom = input.headroomByAccountId.get(account.id)
    if (Number.isFinite(headroom)) existing.headroomValues.push(Number(headroom))
    groups.set(cohort, existing)
  }

  const preferred = input.preferredPlanCohort ?? null
  if (preferred && groups.has(preferred)) {
    return preferred
  }

  const ranked = [...groups.values()].sort((a, b) => {
    const cohortPriorityA = resolvePlanCohortPriority(a.cohort)
    const cohortPriorityB = resolvePlanCohortPriority(b.cohort)
    if (cohortPriorityA !== cohortPriorityB) return cohortPriorityA - cohortPriorityB

    const avgPressureA =
      a.pressureValues.length > 0
        ? a.pressureValues.reduce((sum, value) => sum + value, 0) / a.pressureValues.length
        : Number.POSITIVE_INFINITY
    const avgPressureB =
      b.pressureValues.length > 0
        ? b.pressureValues.reduce((sum, value) => sum + value, 0) / b.pressureValues.length
        : Number.POSITIVE_INFINITY
    if (avgPressureA !== avgPressureB) return avgPressureA - avgPressureB

    const avgHeadroomA =
      a.headroomValues.length > 0
        ? a.headroomValues.reduce((sum, value) => sum + value, 0) / a.headroomValues.length
        : Number.NEGATIVE_INFINITY
    const avgHeadroomB =
      b.headroomValues.length > 0
        ? b.headroomValues.reduce((sum, value) => sum + value, 0) / b.headroomValues.length
        : Number.NEGATIVE_INFINITY
    if (avgHeadroomA !== avgHeadroomB) return avgHeadroomB - avgHeadroomA

    if (a.accounts.length !== b.accounts.length) return b.accounts.length - a.accounts.length
    return 0
  })

  return ranked[0]?.cohort ?? null
}

export function normalizeQuotaWindowRemainingPercent(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(Number(value)))) : null
}

export function resolveQuotaWindowRemainingPercent(
  snapshot: AccountQuotaSnapshot | null | undefined,
  window: "primary" | "secondary",
  now = Date.now(),
  ttlMs = DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS,
) {
  if (!snapshot || snapshot.status !== "ok" || !isQuotaCacheFresh(snapshot, now, ttlMs)) return null
  for (const entry of [snapshot.primary, ...snapshot.additional]) {
    const remainingPercent =
      window === "primary"
        ? normalizeQuotaWindowRemainingPercent(entry?.primary?.remainingPercent)
        : normalizeQuotaWindowRemainingPercent(entry?.secondary?.remainingPercent)
    if (remainingPercent !== null) return remainingPercent
  }
  return null
}
