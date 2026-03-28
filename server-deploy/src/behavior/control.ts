type BehaviorMode = "enforce" | "observe"

type EgressKind = "ip" | "hint" | "agent" | "unknown"

export type BehaviorSignal = {
  clientTag: string
  egressId?: string
  egressKind: EgressKind
  regionTag?: string
}

export type BehaviorConfig = {
  enabled: boolean
  mode: BehaviorMode
  maxInFlightGlobal: number
  maxInFlightPerAccount: number
  windowMs: number
  maxRequestsPerWindowGlobal: number
  maxRequestsPerWindowPerAccount: number
  maxQueueWaitMs: number
  egressSwitchCooldownMs: number
  regionSwitchCooldownMs: number
  stateTtlMs: number
}

type AcquireInput = {
  accountId: string
  signal: BehaviorSignal
}

export type BehaviorAcquireSuccess = {
  ok: true
  waitMs: number
  notes: string[]
  release: () => void
}

export type BehaviorAcquireFailure = {
  ok: false
  status: number
  retryAfterMs?: number
  code: string
  message: string
  notes: string[]
}

export type BehaviorAcquireResult = BehaviorAcquireSuccess | BehaviorAcquireFailure

type EgressState = {
  egressId: string
  egressKind: EgressKind
  firstSeenAt: number
  lastSeenAt: number
}

type RegionState = {
  regionTag: string
  changedAt: number
  lastSeenAt: number
}

const UNKNOWN_REGION = "unknown"

function parseBooleanEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase()
  if (!raw) return fallback
  if (["1", "true", "yes", "on"].includes(raw)) return true
  if (["0", "false", "no", "off"].includes(raw)) return false
  return fallback
}

function parseIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name] ?? "")
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

function parseModeEnv(name: string, fallback: BehaviorMode): BehaviorMode {
  const raw = String(process.env[name] ?? "")
    .trim()
    .toLowerCase()
  if (raw === "enforce" || raw === "observe") return raw
  return fallback
}

function normalizeSignalToken(value?: string | null, maxLen = 128) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^\w.\-:]/g, "")
    .slice(0, maxLen)
  return normalized.length > 0 ? normalized : undefined
}

function firstHeaderValue(headers: Headers, key: string) {
  const raw = headers.get(key)
  if (!raw) return undefined
  const first = raw.split(",")[0]?.trim()
  return first || undefined
}

function resolveEgressFromHeaders(headers: Headers): { id?: string; kind: EgressKind } {
  const explicit = normalizeSignalToken(headers.get("x-egress-id"), 96)
  if (explicit) return { id: explicit, kind: "hint" }

  const forwarded = normalizeSignalToken(firstHeaderValue(headers, "x-forwarded-for"), 96)
  if (forwarded) return { id: forwarded, kind: "ip" }

  const realIp = normalizeSignalToken(firstHeaderValue(headers, "x-real-ip"), 96)
  if (realIp) return { id: realIp, kind: "ip" }

  const userAgent = normalizeSignalToken(headers.get("user-agent"), 128)
  if (userAgent) return { id: userAgent, kind: "agent" }

  return { id: undefined, kind: "unknown" }
}

function resolveRegionFromHeaders(headers: Headers) {
  const candidates = [
    headers.get("x-region"),
    headers.get("x-client-region"),
    headers.get("cf-ipcountry"),
    headers.get("x-vercel-ip-country"),
    headers.get("x-geo-country"),
    headers.get("x-client-country"),
  ]
  for (const candidate of candidates) {
    const normalized = normalizeSignalToken(candidate, 32)
    if (normalized) return normalized.toLowerCase()
  }
  return undefined
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function ensureArrayMapValue<K>(map: Map<K, number[]>, key: K) {
  const value = map.get(key)
  if (value) return value
  const created: number[] = []
  map.set(key, created)
  return created
}

function ensureCounterMapValue<K>(map: Map<K, number>, key: K) {
  return map.get(key) ?? 0
}

export function resolveBehaviorSignal(headers: Headers): BehaviorSignal {
  const egress = resolveEgressFromHeaders(headers)
  const regionTag = resolveRegionFromHeaders(headers) ?? undefined
  const clientTag = egress.id ?? normalizeSignalToken(headers.get("user-agent"), 128) ?? "unknown_client"
  return {
    clientTag,
    egressId: egress.id,
    egressKind: egress.kind,
    regionTag,
  }
}

export function resolveBehaviorConfigFromEnv(): BehaviorConfig {
  return {
    enabled: parseBooleanEnv("OAUTH_BEHAVIOR_ENABLED", true),
    mode: parseModeEnv("OAUTH_BEHAVIOR_MODE", "enforce"),
    maxInFlightGlobal: parseIntegerEnv("OAUTH_BEHAVIOR_MAX_IN_FLIGHT_GLOBAL", 16, 1, 4096),
    maxInFlightPerAccount: parseIntegerEnv("OAUTH_BEHAVIOR_MAX_IN_FLIGHT_PER_ACCOUNT", 4, 1, 1024),
    windowMs: parseIntegerEnv("OAUTH_BEHAVIOR_WINDOW_MS", 1000, 100, 120000),
    maxRequestsPerWindowGlobal: parseIntegerEnv("OAUTH_BEHAVIOR_MAX_REQ_WINDOW_GLOBAL", 160, 1, 20000),
    maxRequestsPerWindowPerAccount: parseIntegerEnv("OAUTH_BEHAVIOR_MAX_REQ_WINDOW_PER_ACCOUNT", 40, 1, 5000),
    maxQueueWaitMs: parseIntegerEnv("OAUTH_BEHAVIOR_MAX_QUEUE_WAIT_MS", 3000, 0, 120000),
    egressSwitchCooldownMs: parseIntegerEnv("OAUTH_BEHAVIOR_EGRESS_SWITCH_COOLDOWN_MS", 30 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    regionSwitchCooldownMs: parseIntegerEnv("OAUTH_BEHAVIOR_REGION_SWITCH_COOLDOWN_MS", 30 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    stateTtlMs: parseIntegerEnv("OAUTH_BEHAVIOR_STATE_TTL_MS", 24 * 60 * 60 * 1000, 60 * 1000, 14 * 24 * 60 * 60 * 1000),
  }
}

export class BehaviorController {
  private readonly config: BehaviorConfig
  private inFlightGlobal = 0
  private readonly inFlightByAccount = new Map<string, number>()
  private readonly globalRequestTimes: number[] = []
  private readonly accountRequestTimes = new Map<string, number[]>()
  private readonly egressByAccount = new Map<string, EgressState>()
  private readonly regionByAccount = new Map<string, RegionState>()
  private lastCleanupAt = 0

  constructor(config: BehaviorConfig) {
    this.config = config
  }

  private pruneWindow(timestamps: number[], now: number) {
    const oldest = now - this.config.windowMs
    while (timestamps.length > 0 && timestamps[0] < oldest) {
      timestamps.shift()
    }
  }

  private computeRateWaitMs(timestamps: number[], limit: number, now: number) {
    this.pruneWindow(timestamps, now)
    if (timestamps.length < limit) return 0
    const oldest = timestamps[0]
    return Math.max(0, oldest + this.config.windowMs - now)
  }

  private cleanupState(now: number) {
    if (now - this.lastCleanupAt < 60_000) return
    this.lastCleanupAt = now
    const oldest = now - this.config.stateTtlMs

    for (const [accountId, state] of this.egressByAccount.entries()) {
      if (state.lastSeenAt < oldest) this.egressByAccount.delete(accountId)
    }
    for (const [accountId, state] of this.regionByAccount.entries()) {
      if (state.lastSeenAt < oldest) this.regionByAccount.delete(accountId)
    }
    for (const [accountId, timestamps] of this.accountRequestTimes.entries()) {
      this.pruneWindow(timestamps, now)
      if (timestamps.length === 0) this.accountRequestTimes.delete(accountId)
    }
    this.pruneWindow(this.globalRequestTimes, now)
    for (const [accountId, value] of this.inFlightByAccount.entries()) {
      if (value <= 0) this.inFlightByAccount.delete(accountId)
    }
  }

  private evaluateEgressSwitch(input: AcquireInput, now: number) {
    if (!input.signal.egressId) return null
    if (input.signal.egressKind !== "ip" && input.signal.egressKind !== "hint") return null
    const previous = this.egressByAccount.get(input.accountId)
    if (!previous) return null
    if (previous.egressKind !== "ip" && previous.egressKind !== "hint") return null
    if (previous.egressId === input.signal.egressId) return null

    const elapsed = Math.max(0, now - previous.lastSeenAt)
    const remaining = Math.max(0, this.config.egressSwitchCooldownMs - elapsed)
    if (remaining <= 0) return null
    return {
      code: "egress_switch_too_fast",
      message: `Account switched egress too quickly: ${previous.egressId} -> ${input.signal.egressId}`,
      retryAfterMs: remaining,
    }
  }

  private evaluateRegionSwitch(input: AcquireInput, now: number) {
    const current = (input.signal.regionTag ?? UNKNOWN_REGION).toLowerCase()
    if (current === UNKNOWN_REGION) return null
    const previous = this.regionByAccount.get(input.accountId)
    if (!previous) return null
    if (previous.regionTag === current) return null

    const elapsed = Math.max(0, now - previous.lastSeenAt)
    const remaining = Math.max(0, this.config.regionSwitchCooldownMs - elapsed)
    if (remaining <= 0) return null
    return {
      code: "region_switch_too_fast",
      message: `Account switched region too quickly: ${previous.regionTag} -> ${current}`,
      retryAfterMs: remaining,
    }
  }

  private reserve(accountId: string, now: number) {
    this.inFlightGlobal += 1
    const accountInFlight = ensureCounterMapValue(this.inFlightByAccount, accountId)
    this.inFlightByAccount.set(accountId, accountInFlight + 1)

    this.globalRequestTimes.push(now)
    const accountTimes = ensureArrayMapValue(this.accountRequestTimes, accountId)
    accountTimes.push(now)
  }

  private markIdentity(input: AcquireInput, now: number) {
    const egressId = input.signal.egressId
    if (egressId) {
      const previous = this.egressByAccount.get(input.accountId)
      if (previous && previous.egressId === egressId) {
        previous.lastSeenAt = now
      } else {
        this.egressByAccount.set(input.accountId, {
          egressId,
          egressKind: input.signal.egressKind,
          firstSeenAt: now,
          lastSeenAt: now,
        })
      }
    }

    const regionTag = (input.signal.regionTag ?? UNKNOWN_REGION).toLowerCase()
    if (regionTag !== UNKNOWN_REGION) {
      const previous = this.regionByAccount.get(input.accountId)
      if (previous && previous.regionTag === regionTag) {
        previous.lastSeenAt = now
      } else {
        this.regionByAccount.set(input.accountId, {
          regionTag,
          changedAt: now,
          lastSeenAt: now,
        })
      }
    }
  }

  private release(accountId: string) {
    this.inFlightGlobal = Math.max(0, this.inFlightGlobal - 1)
    const accountInFlight = ensureCounterMapValue(this.inFlightByAccount, accountId)
    const next = Math.max(0, accountInFlight - 1)
    if (next <= 0) {
      this.inFlightByAccount.delete(accountId)
      return
    }
    this.inFlightByAccount.set(accountId, next)
  }

  async acquire(input: AcquireInput): Promise<BehaviorAcquireResult> {
    if (!this.config.enabled) {
      return {
        ok: true,
        waitMs: 0,
        notes: [],
        release: () => undefined,
      }
    }

    const notes: string[] = []
    const startedAt = Date.now()
    const now = startedAt

    this.cleanupState(now)

    const egressViolation = this.evaluateEgressSwitch(input, now)
    if (egressViolation) {
      if (this.config.mode === "enforce") {
        return {
          ok: false,
          status: 409,
          retryAfterMs: egressViolation.retryAfterMs,
          code: egressViolation.code,
          message: egressViolation.message,
          notes,
        }
      }
      notes.push(`observe:${egressViolation.code}`)
    }

    const regionViolation = this.evaluateRegionSwitch(input, now)
    if (regionViolation) {
      if (this.config.mode === "enforce") {
        return {
          ok: false,
          status: 409,
          retryAfterMs: regionViolation.retryAfterMs,
          code: regionViolation.code,
          message: regionViolation.message,
          notes,
        }
      }
      notes.push(`observe:${regionViolation.code}`)
    }

    while (true) {
      const loopNow = Date.now()
      this.cleanupState(loopNow)
      this.pruneWindow(this.globalRequestTimes, loopNow)
      const accountTimes = ensureArrayMapValue(this.accountRequestTimes, input.accountId)
      this.pruneWindow(accountTimes, loopNow)

      const globalInFlight = this.inFlightGlobal
      const accountInFlight = ensureCounterMapValue(this.inFlightByAccount, input.accountId)
      const concurrencyWait = globalInFlight >= this.config.maxInFlightGlobal || accountInFlight >= this.config.maxInFlightPerAccount ? 25 : 0

      const globalRateWait = this.computeRateWaitMs(this.globalRequestTimes, this.config.maxRequestsPerWindowGlobal, loopNow)
      const accountRateWait = this.computeRateWaitMs(accountTimes, this.config.maxRequestsPerWindowPerAccount, loopNow)
      const waitMs = Math.max(concurrencyWait, globalRateWait, accountRateWait)

      if (waitMs <= 0) {
        this.reserve(input.accountId, loopNow)
        this.markIdentity(input, loopNow)
        return {
          ok: true,
          waitMs: Math.max(0, loopNow - startedAt),
          notes,
          release: () => this.release(input.accountId),
        }
      }

      const elapsed = Math.max(0, loopNow - startedAt)
      if (elapsed + waitMs > this.config.maxQueueWaitMs) {
        return {
          ok: false,
          status: 429,
          retryAfterMs: waitMs,
          code: "rate_or_concurrency_limited",
          message: "Behavior guard throttled request to keep Codex-compatible traffic cadence",
          notes,
        }
      }

      await sleep(Math.min(waitMs, 60))
    }
  }
}
