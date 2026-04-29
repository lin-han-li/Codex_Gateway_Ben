import { Hono } from "hono"
import { z } from "zod"
import os from "node:os"
import path from "node:path"
import * as zlib from "node:zlib"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { AppConfig, ensureAppDirs } from "./config"
import {
  loadCodexInstructionsText,
  resolveCodexClientVersion,
  resolveCodexRuntimeAssetStatus,
  toWholeCodexClientVersion,
  type CodexOfficialAssetSource,
} from "./codex-version"
import { buildCodexUserAgent, isFirstPartyCodexOriginator } from "./codex-identity"
import { buildDashboardMetrics as buildAuditDashboardMetrics } from "./domain/audit/dashboard-metrics"
import { estimateUsageCostUsd, PRICING_CATALOG_VERSION, PRICING_MODE, withEstimatedUsageCost } from "./domain/audit/pricing"
import type { UsageMetrics } from "./domain/audit/types"
import { createAutomaticAccountAvailabilityResolver } from "./domain/accounts/availability"
import {
  canClearStickyAccountHealth,
  getActiveAccountHealthSnapshot,
  isStickyAccountHealthReason,
  isStickyAccountHealthSnapshot,
  normalizeAccountHealthReason,
  resolveAccountHealthExpiry,
  type AccountHealthSnapshot,
} from "./domain/accounts/health"
import {
  DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS,
  makeQuotaError,
  makeUnavailableQuota,
  isQuotaCacheFresh,
  normalizeQuotaEntry,
  normalizeQuotaWindow,
  normalizeRateLimitUsagePayload,
  normalizeQuotaWindowRemainingPercent,
  resolveAccountPlanCohort,
  resolvePlanCohortPriority,
  resolveQuotaSnapshotHeadroomPercent,
  resolveQuotaWindowRemainingPercent,
  type AccountPlanCohort,
  type AccountQuotaEntry,
  type AccountQuotaSnapshot,
  type AccountQuotaWindow,
} from "./domain/accounts/quota"
import {
  buildRelaxedProviderRoutingHintsFromState,
  buildProviderRoutingHintsFromState,
  type ProviderRoutingHints,
  type ProviderRoutingHintsOptions,
} from "./domain/routing/provider-routing"
import { buildVirtualKeyModeError, describeVirtualKeyClientMode } from "./domain/virtual-keys/mode"
import { BehaviorController, resolveBehaviorSignal, type BehaviorAcquireFailure, type BehaviorConfig } from "./behavior/control"
import {
  buildUpstreamAccountUnavailableFailure,
  detectRoutingBlockedAccount,
  detectTransientUpstreamError,
  errorMessage,
  getStatusErrorCode,
  isLikelyAuthError,
  isTransientUpstreamStatus,
  normalizeCaughtCodexFailure,
} from "./behavior/codex-failure"
import { fetchWithUpstreamRetry, type UpstreamRetryPolicy } from "./behavior/upstream-retry"
import { AccountStore, type VirtualApiKeyRecord } from "./store/db"
import { LocalCallbackServer } from "./oauth/callback-server"
import { ProviderRegistry } from "./providers/registry"
import { LoginSessionManager } from "./oauth/session-manager"
import type { RefreshResult, StoredAccount } from "./types"
import { isSecretEncryptionEnabled } from "./security/secrets"
import { RestrictedForwardProxy } from "./proxy/forward-proxy"
import {
  bindClientIdentifierToAccount,
  isAccountBoundSessionFieldKey,
} from "./upstream-session-binding"
import { registerAccountRoutes } from "./routes/accounts"
import { registerAuditRoutes } from "./routes/audits"
import { registerBridgeRoutes } from "./routes/bridge"
import { registerDashboardRoutes } from "./routes/dashboard"
import { registerLoginRoutes } from "./routes/login"
import { registerModelsRoutes } from "./routes/models"
import { registerSettingsRoutes } from "./routes/settings"
import { registerVirtualKeysRoutes } from "./routes/virtual-keys"
import { buildCodexOAuthBridgeBindingKeys } from "./codex-bridge-binding"
import { writeCodexLocalAuth } from "./codex-local-auth"

await ensureAppDirs()

const accountStore = new AccountStore(AppConfig.dbFile)
const callbackServer = new LocalCallbackServer(1455, "/auth/callback")
const providers = new ProviderRegistry(callbackServer)
const loginSessions = new LoginSessionManager(accountStore, providers)
const chatHistory = new Map<string, Array<{ role: "user" | "assistant"; text: string }>>()
const usageEventEncoder = new TextEncoder()
const usageEventClients = new Map<
  string,
  {
    controller: ReadableStreamDefaultController<Uint8Array>
    heartbeat: ReturnType<typeof setInterval>
  }
>()
let bootstrapLogState = ""

type RequestAuditCompatInput = {
  route: string
  method: string
  providerId?: string | null
  accountId?: string | null
  virtualKeyId?: string | null
  clientMode?: "codex" | "cursor" | null
  wireApi?: "responses" | "chat_completions" | null
  model?: string | null
  sessionId?: string | null
  requestBytes?: number
  requestBody?: Uint8Array
  responseBytes?: number
  statusCode?: number
  latencyMs?: number
  upstreamRequestId?: string | null
  error?: string | null
  clientTag?: string | null
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
  estimatedCostUsd?: number | null
  reasoningEffort?: string | null
  usage?: UsageMetrics
}

type RequestAuditOverlay = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  estimatedCostUsd: number | null
  reasoningEffort: string | null
  updatedAt: number
}

const REQUEST_AUDIT_OVERLAY_LIMIT = 4000
const requestAuditOverlays = new Map<string, RequestAuditOverlay>()
const extendedUsageTotalsState = {
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  estimatedCostUsd: 0,
  pricedTokens: 0,
  updatedAt: 0,
}
const STATS_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"

function roundProjectedCostUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value * 1_000_000_000) / 1_000_000_000
}

function normalizeCoverageRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(0, Math.min(1, value))
}

function buildUsageCostProjection(input: { totalTokens: number; pricedTokens: number; estimatedCostUsd: number }) {
  const totalTokens = Math.max(0, Math.floor(Number(input.totalTokens ?? 0)))
  const pricedTokens = Math.max(0, Math.floor(Number(input.pricedTokens ?? 0)))
  const estimatedCostUsd = Math.max(0, Number(input.estimatedCostUsd ?? 0))
  const estimatedCostCoverageRatio = totalTokens > 0 ? normalizeCoverageRatio(pricedTokens / totalTokens) : 0
  const estimatedCostFromTotalTokensUsd =
    totalTokens > 0 && pricedTokens > 0 && estimatedCostUsd > 0
      ? roundProjectedCostUsd((estimatedCostUsd / pricedTokens) * totalTokens)
      : 0
  return {
    pricedTokens,
    estimatedCostCoverageRatio,
    estimatedCostFromTotalTokensUsd,
  }
}

type AccountRoutingState = {
  state: "eligible" | "soft_drained" | "excluded"
  reason: string | null
  headroomPercent: number | null
  softDrainThresholdPercent: number
}

type AccountAbnormalCategory =
  | "normal"
  | "quota_exhausted"
  | "banned"
  | "access_banned"
  | "auth_invalid"
  | "soft_drained"
  | "transient"
  | "unknown"

type PublicAccountHealthSnapshot = AccountHealthSnapshot & {
  routingExcluded: boolean
}

type AccountAbnormalState = {
  classification: AccountAbnormalCategory
  category: AccountAbnormalCategory
  label: string
  reason: string
  source: string | null
  detectedAt: number | null
  expiresAt: number | null
  confidence: "high" | "medium" | "low"
  deleteEligible: boolean
}

const ACCOUNT_QUOTA_CACHE_TTL_MS = DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS
const ACCOUNT_QUOTA_POLL_INTERVAL_MS = 60 * 1000
const ACCOUNT_QUOTA_POLL_BATCH_SIZE = 8
const ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD = 10
const ACCOUNT_TRANSIENT_HEALTH_COOLDOWN_MS = 60 * 1000
const PROVIDER_PRESSURE_HINTS_TTL_MS = 1000
const accountQuotaCache = new Map<string, AccountQuotaSnapshot>()
const accountHealthCache = new Map<string, AccountHealthSnapshot>()
const accountQuotaRefreshInFlight = new Set<string>()
let accountQuotaPollInFlight = false
let accountQuotaPollCursor = 0
const providerPressureHintsCache = new Map<
  string,
  {
    generatedAt: number
    pressureScoreByAccountId: Map<string, number>
  }
>()

const app = new Hono()

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") {
    await next()
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    c.header("Pragma", "no-cache")
    c.header("Expires", "0")
    return
  }
  if (!isManagementAuthorized(c)) {
    return c.json({ error: "Unauthorized management token" }, 401)
  }
  await next()
  c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
  c.header("Pragma", "no-cache")
  c.header("Expires", "0")
})

const DEFAULT_CHATGPT_CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
const DEFAULT_OPENAI_API_BASE = "https://api.openai.com/v1"
const CODEX_ORIGINATOR = process.env.OAUTH_CODEX_ORIGINATOR ?? "codex_cli_rs"
const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_CLIENT_WHOLE_VERSION = toWholeCodexClientVersion(CODEX_CLIENT_VERSION)
const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FORCED_WORKSPACE_ID = String(process.env.OAUTH_CODEX_ALLOWED_WORKSPACE_ID ?? "").trim()
const EVENT_STREAM_TOKEN_TTL_MS = 5 * 60 * 1000
const eventStreamAccessTokens = new Map<string, number>()

function normalizeHost(host?: string | null) {
  return String(host ?? "").trim().toLowerCase()
}

function isLoopbackHost(host?: string | null) {
  const value = normalizeHost(host)
  return value === "127.0.0.1" || value === "localhost" || value === "::1"
}

function isNonLoopbackBindingHost(host?: string | null) {
  const value = normalizeHost(host)
  if (!value) return false
  if (value === "0.0.0.0" || value === "::") return true
  return !isLoopbackHost(value)
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

function resolveApiBaseFromEndpoint(input: { baseEnv?: string | null; endpointEnv?: string | null; fallbackBase: string }) {
  const fromBase = String(input.baseEnv ?? "").trim()
  if (fromBase) return trimTrailingSlash(fromBase)

  const fromEndpoint = String(input.endpointEnv ?? "").trim()
  if (!fromEndpoint) return input.fallbackBase

  try {
    const parsed = new URL(fromEndpoint)
    const pathname = parsed.pathname.replace(/\/+$/, "")
    if (pathname.endsWith("/responses")) {
      parsed.pathname = pathname.slice(0, -"/responses".length) || "/"
    } else if (pathname.endsWith("/models")) {
      parsed.pathname = pathname.slice(0, -"/models".length) || "/"
    }
    parsed.search = ""
    parsed.hash = ""
    return trimTrailingSlash(parsed.toString())
  } catch {
    if (fromEndpoint.endsWith("/responses")) return trimTrailingSlash(fromEndpoint.slice(0, -"/responses".length))
    if (fromEndpoint.endsWith("/models")) return trimTrailingSlash(fromEndpoint.slice(0, -"/models".length))
    return trimTrailingSlash(fromEndpoint)
  }
}

function resolveChatgptCodexApiBaseUrl() {
  return resolveApiBaseFromEndpoint({
    baseEnv: process.env.OAUTH_CODEX_API_BASE,
    endpointEnv: process.env.OAUTH_CODEX_API_ENDPOINT,
    fallbackBase: DEFAULT_CHATGPT_CODEX_API_BASE,
  })
}

function resolveOpenAIApiBaseUrl() {
  return resolveApiBaseFromEndpoint({
    baseEnv: process.env.OAUTH_OPENAI_API_BASE,
    endpointEnv: process.env.OAUTH_OPENAI_API_ENDPOINT,
    fallbackBase: DEFAULT_OPENAI_API_BASE,
  })
}

function resolveCodexRateLimitsEndpoint(codexApiBase: string) {
  const normalized = trimTrailingSlash(codexApiBase)
  const lowered = normalized.toLowerCase()
  if (lowered.includes("/backend-api")) {
    const withoutCodex = lowered.endsWith("/codex") ? normalized.slice(0, -"/codex".length) : normalized
    return `${trimTrailingSlash(withoutCodex)}/wham/usage`
  }
  return `${normalized}/usage`
}

const CHATGPT_CODEX_API_BASE = resolveChatgptCodexApiBaseUrl()
const CHATGPT_RESPONSES_ENDPOINT = `${CHATGPT_CODEX_API_BASE}/responses`
const CHATGPT_MODELS_ENDPOINT = `${CHATGPT_CODEX_API_BASE}/models`
const CHATGPT_RATE_LIMITS_ENDPOINT = resolveCodexRateLimitsEndpoint(CHATGPT_CODEX_API_BASE)

const OPENAI_API_BASE = resolveOpenAIApiBaseUrl()
const OPENAI_RESPONSES_ENDPOINT = `${OPENAI_API_BASE}/responses`
const OPENAI_MODELS_ENDPOINT = `${OPENAI_API_BASE}/models`
const OPENAI_RATE_LIMITS_ENDPOINT = `${OPENAI_API_BASE}/api/codex/usage`

const CODEX_API_BASE = CHATGPT_CODEX_API_BASE
const CODEX_RESPONSES_ENDPOINT = CHATGPT_RESPONSES_ENDPOINT
const CODEX_MODELS_ENDPOINT = CHATGPT_MODELS_ENDPOINT
const CODEX_RATE_LIMITS_ENDPOINT = CHATGPT_RATE_LIMITS_ENDPOINT
const CODEX_USER_AGENT = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)
const FORWARD_PROXY_ENABLED = String(process.env.OAUTH_APP_FORWARD_PROXY_ENABLED ?? "1").trim() !== "0"
const FORWARD_PROXY_PORT = Number(process.env.OAUTH_APP_FORWARD_PROXY_PORT ?? String(AppConfig.port + 1))
const FORWARD_PROXY_ALLOWED_HOSTS = String(
  process.env.OAUTH_APP_FORWARD_PROXY_ALLOWED_HOSTS ??
    "api.openai.com,auth.openai.com,ab.chatgpt.com,chatgpt.com,.chatgpt.com,openai.com,.openai.com,oaistatic.com,.oaistatic.com,oaiusercontent.com,.oaiusercontent.com,github.com,.github.com,githubusercontent.com,.githubusercontent.com,githubassets.com,.githubassets.com",
)
  .split(",")
  .map((item) => String(item ?? "").trim().toLowerCase())
  .filter(Boolean)
const FORWARD_PROXY_ENFORCE_ALLOWLIST =
  String(process.env.OAUTH_APP_FORWARD_PROXY_ENFORCE_ALLOWLIST ?? "0").trim() === "1"
let forwardProxy: RestrictedForwardProxy | null = null
let server: ReturnType<typeof Bun.serve> | null = null
let fatalShutdown = false

function parseIntegerEnvValue(name: string, fallback: number, min: number, max: number) {
  const rawValue = String(process.env[name] ?? "").trim()
  if (!rawValue) return fallback
  const raw = Number(rawValue)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

const PROXY_MAX_REQUEST_BODY_BYTES = parseIntegerEnvValue(
  "OAUTH_PROXY_MAX_REQUEST_BODY_BYTES",
  64 * 1024 * 1024,
  1024 * 1024,
  512 * 1024 * 1024,
)
const PROXY_HEAVY_BODY_BYTES = parseIntegerEnvValue("OAUTH_PROXY_HEAVY_BODY_BYTES", 1024 * 1024, 0, 128 * 1024 * 1024)
const PROXY_MAX_IN_FLIGHT = parseIntegerEnvValue("OAUTH_PROXY_MAX_IN_FLIGHT", 12, 1, 128)
const PROXY_MAX_HEAVY_IN_FLIGHT = parseIntegerEnvValue("OAUTH_PROXY_MAX_HEAVY_IN_FLIGHT", 2, 1, 32)
const PROXY_QUEUE_WAIT_MS = parseIntegerEnvValue("OAUTH_PROXY_QUEUE_WAIT_MS", 45_000, 0, 10 * 60 * 1000)
const PROXY_MAX_QUEUE = parseIntegerEnvValue("OAUTH_PROXY_MAX_QUEUE", 256, 0, 5000)
const STRICT_PRIVACY_SANITIZED_LOG_INTERVAL_MS = parseIntegerEnvValue(
  "OAUTH_STRICT_PRIVACY_SANITIZED_LOG_INTERVAL_MS",
  60_000,
  1000,
  10 * 60 * 1000,
)
const USAGE_TRACK_MAX_TEXT_CHARS = parseIntegerEnvValue(
  "OAUTH_USAGE_TRACK_MAX_TEXT_CHARS",
  4 * 1024 * 1024,
  64 * 1024,
  64 * 1024 * 1024,
)

type ProxyPressureLease = {
  release: () => void
}

type ProxyPressureQueueItem = {
  heavy: boolean
  label: string
  resolve: (lease: ProxyPressureLease) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

class ProxyRequestPressureLimiter {
  private globalInFlight = 0
  private heavyInFlight = 0
  private queue: ProxyPressureQueueItem[] = []

  constructor(
    private readonly maxInFlight: number,
    private readonly maxHeavyInFlight: number,
    private readonly maxQueue: number,
    private readonly queueWaitMs: number,
  ) {}

  async acquire(input: { heavy: boolean; label: string; signal?: AbortSignal | null }): Promise<ProxyPressureLease> {
    if (input.signal?.aborted) {
      throw makeStatusError(499, "Client cancelled request before it entered the gateway queue")
    }
    if (this.canAcquire(input.heavy)) {
      return this.reserve(input.heavy)
    }
    if (this.queue.length >= this.maxQueue) {
      throw makeStatusError(429, "Gateway is busy; too many requests are queued")
    }
    if (this.queueWaitMs <= 0) {
      throw makeStatusError(429, "Gateway is busy; request concurrency limit reached")
    }

    return await new Promise<ProxyPressureLease>((resolve, reject) => {
      const item: ProxyPressureQueueItem = {
        heavy: input.heavy,
        label: input.label,
        resolve,
        reject,
        signal: input.signal ?? undefined,
      }
      item.timer = setTimeout(() => {
        this.removeQueued(item)
        reject(makeStatusError(429, "Gateway is busy; request waited too long in queue"))
      }, this.queueWaitMs)
      item.onAbort = () => {
        this.removeQueued(item)
        reject(makeStatusError(499, "Client cancelled request while it was queued"))
      }
      item.signal?.addEventListener("abort", item.onAbort, { once: true })
      this.queue.push(item)
      this.drain()
    })
  }

  private canAcquire(heavy: boolean) {
    return this.globalInFlight < this.maxInFlight && (!heavy || this.heavyInFlight < this.maxHeavyInFlight)
  }

  private reserve(heavy: boolean): ProxyPressureLease {
    this.globalInFlight += 1
    if (heavy) this.heavyInFlight += 1
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.globalInFlight = Math.max(0, this.globalInFlight - 1)
        if (heavy) this.heavyInFlight = Math.max(0, this.heavyInFlight - 1)
        this.drain()
      },
    }
  }

  private removeQueued(item: ProxyPressureQueueItem) {
    const index = this.queue.indexOf(item)
    if (index >= 0) this.queue.splice(index, 1)
    if (item.timer) clearTimeout(item.timer)
    if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort)
  }

  private drain() {
    for (let index = 0; index < this.queue.length; ) {
      const item = this.queue[index]
      if (!item || !this.canAcquire(item.heavy)) {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      if (item.timer) clearTimeout(item.timer)
      if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort)
      item.resolve(this.reserve(item.heavy))
    }
  }
}

const proxyRequestPressureLimiter = new ProxyRequestPressureLimiter(
  PROXY_MAX_IN_FLIGHT,
  PROXY_MAX_HEAVY_IN_FLIGHT,
  PROXY_MAX_QUEUE,
  PROXY_QUEUE_WAIT_MS,
)

type UpstreamProfile = {
  providerMode: "chatgpt" | "openai"
  responsesEndpoint: string
  modelsEndpoint: string
  rateLimitsEndpoint: string
  attachChatgptAccountId: boolean
  canRefreshOn401: boolean
}

function isOpenAIApiKeyAccount(account: Pick<StoredAccount, "providerId" | "methodId">) {
  const provider = String(account.providerId ?? "")
    .trim()
    .toLowerCase()
  const method = String(account.methodId ?? "")
    .trim()
    .toLowerCase()
  return provider === "openai" || method === "api" || method === "api-key"
}

function resolveUpstreamProfileByProviderId(providerId?: string | null): UpstreamProfile {
  if (String(providerId ?? "").trim().toLowerCase() === "openai") {
    return {
      providerMode: "openai",
      responsesEndpoint: OPENAI_RESPONSES_ENDPOINT,
      modelsEndpoint: OPENAI_MODELS_ENDPOINT,
      rateLimitsEndpoint: OPENAI_RATE_LIMITS_ENDPOINT,
      attachChatgptAccountId: false,
      canRefreshOn401: false,
    }
  }
  return {
    providerMode: "chatgpt",
    responsesEndpoint: CHATGPT_RESPONSES_ENDPOINT,
    modelsEndpoint: CHATGPT_MODELS_ENDPOINT,
    rateLimitsEndpoint: CHATGPT_RATE_LIMITS_ENDPOINT,
    attachChatgptAccountId: true,
    canRefreshOn401: true,
  }
}

function resolveUpstreamProfileForAccount(account: Pick<StoredAccount, "providerId" | "methodId">): UpstreamProfile {
  return resolveUpstreamProfileByProviderId(isOpenAIApiKeyAccount(account) ? "openai" : account.providerId)
}

// Codex 官方默认重试策略（固定，不暴露为可配置项）
const OFFICIAL_UPSTREAM_RETRY_POLICY: UpstreamRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 200,
  retry429: false,
  retry5xx: true,
  retryTransport: true,
}

const INTERACTIVE_FAST_RETRY_POLICY: Partial<UpstreamRetryPolicy> = {
  maxAttempts: 1,
  baseDelayMs: 120,
  retry429: false,
  retry5xx: true,
  retryTransport: true,
}

const POOL_FAIL_FAST_RETRY_POLICY: Partial<UpstreamRetryPolicy> = {
  maxAttempts: 0,
  baseDelayMs: 80,
  retry429: false,
  retry5xx: true,
  retryTransport: true,
}

const POOL_REROUTE_MAX_ATTEMPTS = 3

type BehaviorAcquireError = Error & {
  behaviorFailure: BehaviorAcquireFailure
}

function createBehaviorAcquireError(behaviorFailure: BehaviorAcquireFailure): BehaviorAcquireError {
  const error = new Error(behaviorFailure.message) as BehaviorAcquireError
  error.name = "BehaviorAcquireError"
  error.behaviorFailure = behaviorFailure
  return error
}

function getBehaviorAcquireFailure(error: unknown): BehaviorAcquireFailure | null {
  const candidate = error as Partial<BehaviorAcquireError> | null
  if (!candidate || typeof candidate !== "object") return null
  const behaviorFailure = candidate.behaviorFailure as BehaviorAcquireFailure | undefined
  if (!behaviorFailure || behaviorFailure.ok !== false) return null
  return behaviorFailure
}

function toBehaviorAcquireResponse(behaviorFailure: BehaviorAcquireFailure) {
  const retryAfterSeconds = behaviorFailure.retryAfterMs
    ? Math.max(1, Math.ceil(behaviorFailure.retryAfterMs / 1000))
    : undefined
  return new Response(
    JSON.stringify({
      error: behaviorFailure.message,
      code: behaviorFailure.code,
    }),
    {
      status: behaviorFailure.status,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
      },
    },
  )
}

// Codex 官方无“行为层”参数；此处固定禁用，避免引入非官方可配置行为差异
const OFFICIAL_BEHAVIOR_CONFIG: BehaviorConfig = {
  enabled: false,
  mode: "observe",
  maxInFlightGlobal: 16,
  maxInFlightPerAccount: 4,
  windowMs: 1000,
  maxRequestsPerWindowGlobal: 160,
  maxRequestsPerWindowPerAccount: 40,
  maxQueueWaitMs: 3000,
  egressSwitchCooldownMs: 30 * 60 * 1000,
  regionSwitchCooldownMs: 30 * 60 * 1000,
  stateTtlMs: 6 * 60 * 60 * 1000,
}

if (isNonLoopbackBindingHost(AppConfig.host) && !isSecretEncryptionEnabled()) {
  throw new Error("OAUTH_APP_ENCRYPTION_KEY is required when binding to non-loopback host")
}

type RuntimeSettings = {
  localServiceAddress: string
  adminToken: string
  encryptionKey: string
  upstreamPrivacyStrict: boolean
  officialStrictPassthrough: boolean
  themeId: string
  codexInstallationId: string
  codexOAuthBridgeBindings: Record<string, { virtualKeyId: string; updatedAt: number }>
}

const DEFAULT_UI_THEME_ID = "ocean"
const UI_THEME_IDS = new Set(["ocean", "slate", "forest", "sunset", "grape", "business"])

function normalizeUiThemeId(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase()
  return UI_THEME_IDS.has(normalized) ? normalized : DEFAULT_UI_THEME_ID
}

type ServiceAddressInfo = {
  bindServiceAddress: string
  activeLocalServiceAddress: string
  lanServiceAddresses: string[]
  preferredClientServiceAddress: string
}

function parseIPv4(host: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
  const octets = host.split(".").map((part) => Number(part))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null
  return octets
}

function isPrivateLanIPv4(host: string) {
  const octets = parseIPv4(host)
  if (!octets) return false
  const [a, b] = octets
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

function isAllowedLocalBindHost(host: string) {
  if (["127.0.0.1", "localhost", "0.0.0.0"].includes(host)) return true
  return isPrivateLanIPv4(host)
}

function scoreLanInterface(name: string, address: string) {
  const label = `${name} ${address}`.toLowerCase()
  let score = 0
  if (/\b(wi-?fi|wlan|wireless)\b/.test(label)) score += 120
  if (/\b(ethernet|eth|lan)\b/.test(label)) score += 100
  if (/\b(vmware|virtualbox|hyper-v|vbox|vethernet|wsl|docker|podman|tailscale|zerotier|hamachi|npcap|tap|tun)\b/.test(label)) {
    score -= 200
  }
  if (address.startsWith("192.168.")) score += 30
  if (address.startsWith("10.")) score += 20
  if (address.startsWith("172.")) score += 10
  return score
}

function collectLanIPv4Addresses() {
  const values = new Map<string, number>()
  const interfaces = os.networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.family !== "IPv4" || entry.internal) continue
      if (!isPrivateLanIPv4(entry.address)) continue
      values.set(entry.address, scoreLanInterface(name, entry.address))
    }
  }
  return [...values.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
    .map(([address]) => address)
}

function formatServiceAddress(host: string, port: number) {
  return `http://${host}:${port}`
}

function buildFallbackServiceAddressInfo(host: string, port: number): ServiceAddressInfo {
  const normalizedHost = String(host ?? "").trim() || "127.0.0.1"
  const normalizedPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 4777
  const bindServiceAddress = formatServiceAddress(normalizedHost, normalizedPort)
  const activeLocalServiceAddress =
    normalizedHost === "0.0.0.0" ? formatServiceAddress("127.0.0.1", normalizedPort) : bindServiceAddress
  return {
    bindServiceAddress,
    activeLocalServiceAddress,
    lanServiceAddresses: [],
    preferredClientServiceAddress: activeLocalServiceAddress,
  }
}

function buildServiceAddressInfo(host: string, port: number): ServiceAddressInfo {
  const fallback = buildFallbackServiceAddressInfo(host, port)
  const normalizedHost = String(host ?? "").trim() || "127.0.0.1"
  const normalizedPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 4777
  const lanHosts =
    normalizedHost === "0.0.0.0" ? collectLanIPv4Addresses() : isPrivateLanIPv4(normalizedHost) ? [normalizedHost] : []
  const lanServiceAddresses = lanHosts.map((lanHost) => formatServiceAddress(lanHost, normalizedPort))
  const preferredClientServiceAddress = normalizedHost === "0.0.0.0" ? fallback.activeLocalServiceAddress : fallback.bindServiceAddress
  return {
    ...fallback,
    lanServiceAddresses,
    preferredClientServiceAddress,
  }
}

function getSafeServiceAddressInfo(host: string, port: number): ServiceAddressInfo {
  try {
    return buildServiceAddressInfo(host, port)
  } catch (error) {
    console.warn(`[oauth-multi-login] buildServiceAddressInfo failed: ${errorMessage(error)}`)
    return buildFallbackServiceAddressInfo(host, port)
  }
}

function normalizeLocalServiceAddress(raw: string) {
  const value = String(raw ?? "").trim()
  if (!value) return ""
  const parsed = new URL(value)
  if (parsed.protocol !== "http:") {
    throw new Error("Local service address must use http")
  }
  const host = parsed.hostname.toLowerCase()
  if (!isAllowedLocalBindHost(host)) {
    throw new Error("Local service address host must be localhost / 127.0.0.1 / 0.0.0.0 / LAN IPv4")
  }
  if (!parsed.port) {
    throw new Error("Local service address must include a port")
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Local service address port must be between 1 and 65535")
  }

  parsed.username = ""
  parsed.password = ""
  parsed.hash = ""
  parsed.search = ""
  parsed.pathname = ""
  return parsed.toString()
}

function parseSettingsJson(raw: string) {
  const normalized = String(raw ?? "").replace(/^\uFEFF/, "").trim()
  if (!normalized) return {} as Partial<RuntimeSettings>
  return JSON.parse(normalized) as Partial<RuntimeSettings>
}

async function loadRuntimeSettings() {
  const defaults: RuntimeSettings = {
    localServiceAddress: "",
    adminToken: "",
    encryptionKey: "",
    upstreamPrivacyStrict: true,
    officialStrictPassthrough: false,
    themeId: DEFAULT_UI_THEME_ID,
    codexInstallationId: crypto.randomUUID(),
    codexOAuthBridgeBindings: {},
  }

  try {
    if (!existsSync(AppConfig.settingsFile)) return defaults
    const content = await readFile(AppConfig.settingsFile, "utf8")
    const parsed = parseSettingsJson(content)
    return {
      localServiceAddress: parsed?.localServiceAddress ? normalizeLocalServiceAddress(parsed.localServiceAddress) : defaults.localServiceAddress,
      adminToken: String(parsed?.adminToken ?? "").trim(),
      encryptionKey: String(parsed?.encryptionKey ?? "").trim(),
      upstreamPrivacyStrict: parsed?.upstreamPrivacyStrict === false ? false : true,
      officialStrictPassthrough: parsed?.officialStrictPassthrough === true,
      themeId: normalizeUiThemeId(parsed?.themeId),
      codexInstallationId: normalizeNullableString(parsed?.codexInstallationId, 200) ?? defaults.codexInstallationId,
      codexOAuthBridgeBindings:
        parsed?.codexOAuthBridgeBindings && typeof parsed.codexOAuthBridgeBindings === "object"
          ? parsed.codexOAuthBridgeBindings
          : defaults.codexOAuthBridgeBindings,
    }
  } catch {
    return defaults
  }
}

async function saveRuntimeSettings(settings: RuntimeSettings) {
  await writeFile(AppConfig.settingsFile, JSON.stringify(settings, null, 2), "utf8")
}

const runtimeSettings = await loadRuntimeSettings()
const behaviorController = new BehaviorController(OFFICIAL_BEHAVIOR_CONFIG)
const upstreamRetryPolicy = { ...OFFICIAL_UPSTREAM_RETRY_POLICY }

async function setCodexOAuthBridgeBinding(input: {
  virtualKeyId: string
  accessToken?: string | null
  idToken?: string | null
  accountId?: string | null
  email?: string | null
}) {
  const virtualKeyId = normalizeNullableString(input.virtualKeyId, 200)
  if (!virtualKeyId) throw new Error("Virtual key id is required")
  const keys = buildCodexOAuthBridgeBindingKeys(input)
  if (keys.length === 0) {
    throw new Error("Current Codex login does not expose a usable account identity for gateway binding")
  }
  const nextBindings = { ...(runtimeSettings.codexOAuthBridgeBindings ?? {}) }
  const updatedAt = Date.now()
  for (const key of keys) {
    nextBindings[key] = {
      virtualKeyId,
      updatedAt,
    }
  }
  runtimeSettings.codexOAuthBridgeBindings = nextBindings
  await saveRuntimeSettings(runtimeSettings)
  return {
    keys,
    updatedAt,
  }
}

function getEffectiveManagementToken() {
  return String(AppConfig.adminToken ?? "").trim() || String(runtimeSettings.adminToken ?? "").trim()
}

function getEffectiveEncryptionKey() {
  return String(AppConfig.encryptionKey ?? "").trim() || String(runtimeSettings.encryptionKey ?? "").trim()
}

function isStrictUpstreamPrivacyEnabled() {
  return runtimeSettings.upstreamPrivacyStrict !== false
}

function isOfficialStrictPassthroughEnabled() {
  return runtimeSettings.officialStrictPassthrough === true
}

const OFFICIAL_CODEX_CLIENT_METADATA_HEADER_NAMES = new Set([
  "x-codex-installation-id",
  "x-codex-window-id",
  "x-codex-parent-thread-id",
  "x-openai-subagent",
])
const RESPONSES_TURN_STATE_HEADER = "x-codex-turn-state"
const WS_REQUEST_HEADER_TRACEPARENT_CLIENT_METADATA_KEY = "ws_request_header_traceparent"
const WS_REQUEST_HEADER_TRACESTATE_CLIENT_METADATA_KEY = "ws_request_header_tracestate"
const responsesTurnStateBySessionId = new Map<string, string>()

function getStoredResponsesTurnState(sessionRouteId?: string | null) {
  const normalizedSessionId = normalizeNullableString(sessionRouteId, 240)
  if (!normalizedSessionId) return null
  return normalizeNullableString(responsesTurnStateBySessionId.get(normalizedSessionId), 512)
}

function storeResponsesTurnState(sessionRouteId?: string | null, turnState?: string | null) {
  const normalizedSessionId = normalizeNullableString(sessionRouteId, 240)
  const normalizedTurnState = normalizeNullableString(turnState, 512)
  if (!normalizedSessionId || !normalizedTurnState) return
  responsesTurnStateBySessionId.set(normalizedSessionId, normalizedTurnState)
}

function clearStoredResponsesTurnState(sessionRouteId?: string | null) {
  const normalizedSessionId = normalizeNullableString(sessionRouteId, 240)
  if (!normalizedSessionId) return
  responsesTurnStateBySessionId.delete(normalizedSessionId)
}

function persistResponsesTurnStateFromHeaders(sessionRouteId?: string | null, headers?: Headers | null) {
  const turnState = normalizeNullableString(headers?.get(RESPONSES_TURN_STATE_HEADER), 512)
  if (!turnState) {
    clearStoredResponsesTurnState(sessionRouteId)
    return
  }
  storeResponsesTurnState(sessionRouteId, turnState)
}

function buildTraceClientMetadata(incoming?: Headers) {
  const metadata: Record<string, string> = {}
  const traceparent = normalizeNullableString(incoming?.get("traceparent"), 512)
  const tracestate = normalizeNullableString(incoming?.get("tracestate"), 512)
  if (traceparent) metadata[WS_REQUEST_HEADER_TRACEPARENT_CLIENT_METADATA_KEY] = traceparent
  if (tracestate) metadata[WS_REQUEST_HEADER_TRACESTATE_CLIENT_METADATA_KEY] = tracestate
  return Object.keys(metadata).length > 0 ? metadata : null
}

function buildResponsesTurnMetadataHeader(sessionRouteId?: string | null) {
  const turnId = normalizeNullableString(sessionRouteId, 240)
  if (!turnId) return null
  return JSON.stringify({ turn_id: turnId })
}

function buildResponsesClientMetadata(input: { incoming?: Headers; sessionRouteId?: string | null }) {
  return {
    ...buildOfficialCodexClientMetadata(input),
    ...(buildTraceClientMetadata(input.incoming) ?? {}),
  }
}

function appendResponsesProtocolHeaders(headers: Headers, input: { incoming?: Headers; sessionRouteId?: string | null }) {
  const storedTurnState = getStoredResponsesTurnState(input.sessionRouteId)
  if (storedTurnState) {
    headers.set(RESPONSES_TURN_STATE_HEADER, storedTurnState)
  }
  const turnMetadata = buildResponsesTurnMetadataHeader(input.sessionRouteId)
  if (turnMetadata) {
    headers.set("x-codex-turn-metadata", turnMetadata)
  }
  return headers
}

function withResponsesProtocolMetadata(
  parsedRoot: Record<string, unknown> | null,
  input: { incoming?: Headers; sessionRouteId?: string | null },
) {
  return withOfficialCodexClientMetadata(parsedRoot, buildResponsesClientMetadata(input))
}

function stripResponsesClientMetadata(parsedRoot: Record<string, unknown> | null) {
  if (!parsedRoot) return parsedRoot
  if (!hasOwnKey(parsedRoot, "client_metadata") && !hasOwnKey(parsedRoot, "clientMetadata")) {
    return parsedRoot
  }
  const next = { ...parsedRoot }
  delete next.client_metadata
  delete next.clientMetadata
  return next
}

function finalizeResponsesUpstreamHeaders(sessionRouteId?: string | null, headers?: Headers | null) {
  persistResponsesTurnStateFromHeaders(sessionRouteId, headers)
  return headers ? new Headers(headers) : new Headers()
}

function maybeResetResponsesTurnState(sessionRouteId?: string | null, statusCode?: number | null) {
  if (statusCode === 401) {
    clearStoredResponsesTurnState(sessionRouteId)
  }
}

function buildResponsesAuditWriter(
  route: string,
  method: string,
  resolveDefaults: () => {
    reasoningEffort?: string | null
    clientMode?: "codex" | "cursor" | null
    wireApi?: "responses" | "chat_completions" | null
  },
) {
  return (
    input: Omit<RequestAuditCompatInput, "route" | "method">,
    sessionRouteId?: string | null,
  ) => {
    const defaults = resolveDefaults()
    return writeRequestAuditCompat({
      route,
      method,
      ...input,
      reasoningEffort: input.reasoningEffort ?? defaults.reasoningEffort ?? null,
      clientMode: input.clientMode ?? defaults.clientMode ?? null,
      wireApi: input.wireApi ?? defaults.wireApi ?? null,
      error:
        input.error && getStoredResponsesTurnState(sessionRouteId)
          ? `${input.error} [turn_state=${getStoredResponsesTurnState(sessionRouteId)}]`
          : input.error,
    })
  }
}

function getCodexInstallationId() {
  return normalizeNullableString(runtimeSettings.codexInstallationId, 200) ?? crypto.randomUUID()
}

function resolveCodexWindowId(sessionRouteId?: string | null) {
  const normalized = normalizeNullableString(sessionRouteId, 200)
  return normalized ? `${normalized}:0` : null
}

function pickCodexForwardMetadataHeader(incoming: Headers | undefined, headerName: string) {
  return normalizeNullableString(incoming?.get(headerName), 400)
}

function buildOfficialCodexClientMetadata(input: { incoming?: Headers; sessionRouteId?: string | null }) {
  const metadata: Record<string, string> = {
    "x-codex-installation-id": getCodexInstallationId(),
  }

  const windowId = resolveCodexWindowId(input.sessionRouteId)
  if (windowId) {
    metadata["x-codex-window-id"] = windowId
  }

  const parentThreadId = pickCodexForwardMetadataHeader(input.incoming, "x-codex-parent-thread-id")
  if (parentThreadId) {
    metadata["x-codex-parent-thread-id"] = parentThreadId
  }

  const subagent = pickCodexForwardMetadataHeader(input.incoming, "x-openai-subagent")
  if (subagent) {
    metadata["x-openai-subagent"] = subagent
  }

  return metadata
}

function mergeOfficialCodexClientMetadata(
  clientMetadata: Record<string, unknown> | null | undefined,
  codexClientMetadata: Record<string, string> | null | undefined,
) {
  const officialEntries = Object.entries(codexClientMetadata ?? {})
  if (officialEntries.length === 0) return clientMetadata ?? null

  const next = clientMetadata && !Array.isArray(clientMetadata) ? { ...clientMetadata } : {}
  for (const [key, value] of officialEntries) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      next[key] = value
    }
  }
  return next
}

function appendOfficialCodexForwardHeaders(headers: Headers, codexClientMetadata: Record<string, string> | null | undefined) {
  for (const [key, value] of Object.entries(codexClientMetadata ?? {})) {
    if (!OFFICIAL_CODEX_CLIENT_METADATA_HEADER_NAMES.has(key)) continue
    headers.set(key, value)
  }
}

function withOfficialCodexClientMetadata(
  parsedRoot: Record<string, unknown> | null,
  codexClientMetadata: Record<string, string> | null | undefined,
) {
  const root = parsedRoot ?? {}
  const existingClientMetadata = asRecord(root.client_metadata) ?? asRecord(root.clientMetadata)
  const mergedClientMetadata = mergeOfficialCodexClientMetadata(existingClientMetadata, codexClientMetadata)
  if (!mergedClientMetadata) return parsedRoot
  if (existingClientMetadata && mergedClientMetadata === existingClientMetadata) return parsedRoot
  return {
    ...root,
    client_metadata: mergedClientMetadata,
  }
}

function buildUpstreamForwardHeadersForAccount(input: {
  incoming?: Headers
  accessToken: string
  accountId?: string
  boundAccountId?: string
  providerMode?: UpstreamProfile["providerMode"]
  attachChatgptAccountId?: boolean
  organizationId?: string
  projectId?: string
  codexClientMetadata?: Record<string, string> | null
}) {
  return buildUpstreamForwardHeaders({
    incoming: input.incoming,
    accessToken: input.accessToken,
    accountId: input.accountId,
    boundAccountId: input.boundAccountId,
    providerMode: input.providerMode,
    attachChatgptAccountId: input.attachChatgptAccountId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    codexClientMetadata: input.codexClientMetadata,
  })
}

function buildAccountOpenAIHeadersForProfile(account: StoredAccount, providerMode?: UpstreamProfile["providerMode"]) {
  return providerMode === "openai" ? resolveAccountOpenAIHeaders(account) : null
}

function mergeParsedJsonBodyWithCodexMetadata(input: {
  body?: Uint8Array
  parsedRoot?: Record<string, unknown> | null
  codexClientMetadata?: Record<string, string> | null
}) {
  const mergedRoot = withOfficialCodexClientMetadata(input.parsedRoot ?? null, input.codexClientMetadata)
  const encodedRoot = mergedRoot ?? input.parsedRoot
  if (!encodedRoot) return input.body
  return new TextEncoder().encode(JSON.stringify(encodedRoot))
}

const STRICT_PRIVACY_SESSION_KEYS_LOWER = new Set([
  "session_id",
  "sessionid",
  "session-id",
  "x-session-id",
  "x-client-request-id",
  "previous_response_id",
  "previousresponseid",
  "previous-response-id",
  "conversation",
  "conversation_id",
  "conversationid",
  "conversation-id",
  "thread_id",
  "threadid",
  "thread-id",
  "prompt_cache_key",
  "promptcachekey",
  "prompt-cache-key",
  "x-prompt-cache-key",
])

const STRICT_PRIVACY_QUERY_DROP_PATTERN = /(^|_)(user|email|mail|phone|mobile|ip|device|machine|host|account|workspace|org|organization|tenant)(_|$)/i

function anonymizeClientIdentifier(raw: unknown) {
  const value = String(raw ?? "").trim()
  if (!value) return value
  const seed = [getEffectiveEncryptionKey(), getEffectiveManagementToken(), AppConfig.dataDir, AppConfig.name, "strict-privacy-v1"].join("|")
  const digest = createHash("sha256")
    .update(seed)
    .update("|")
    .update(value)
    .digest("hex")
  return `anon_${digest.slice(0, 40)}`
}

function rewriteClientIdentifierForUpstream(input: {
  accountId?: string | null
  fieldKey?: string | null
  value?: unknown
  strictPrivacy?: boolean
}) {
  const normalized = String(input.value ?? "").trim()
  if (!normalized) return normalized
  if (isOfficialStrictPassthroughEnabled() && isAccountBoundSessionFieldKey(input.fieldKey)) {
    return normalized
  }
  if (input.accountId && isAccountBoundSessionFieldKey(input.fieldKey)) {
    return bindClientIdentifierToAccount(input)
  }
  if (input.strictPrivacy && isAccountBoundSessionFieldKey(input.fieldKey)) {
    return anonymizeClientIdentifier(normalized)
  }
  return normalized
}

function appendSanitizedUpstreamQueryParams(input: {
  incoming: URL
  upstream: URL
  strictPrivacy: boolean
  accountId?: string | null
}) {
  input.incoming.searchParams.forEach((value, key) => {
    const normalizedKey = String(key).trim().toLowerCase()
    if (STRICT_PRIVACY_SESSION_KEYS_LOWER.has(normalizedKey)) {
      const rewritten = rewriteClientIdentifierForUpstream({
        accountId: input.accountId,
        fieldKey: normalizedKey,
        value,
        strictPrivacy: input.strictPrivacy,
      })
      if (rewritten) input.upstream.searchParams.append(key, rewritten)
      return
    }
    if (!input.strictPrivacy) {
      input.upstream.searchParams.append(key, value)
      return
    }
    if (STRICT_PRIVACY_QUERY_DROP_PATTERN.test(normalizedKey)) return
    input.upstream.searchParams.append(key, value)
  })
}

startServerEventHooks()

const CODEX_RUNTIME_ASSETS = resolveCodexRuntimeAssetStatus()

async function loadCodexInstructions() {
  return loadCodexInstructionsText()
}

const CHAT_INSTRUCTIONS_LOADED = await loadCodexInstructions()
const CHAT_INSTRUCTIONS = CHAT_INSTRUCTIONS_LOADED.content
const CHAT_INSTRUCTIONS_SOURCE: CodexOfficialAssetSource = CHAT_INSTRUCTIONS_LOADED.source

function toSerializableAssetSource(source: CodexOfficialAssetSource) {
  return {
    kind: source.kind,
    path: source.path,
  }
}

function buildOfficialAssetsStatus() {
  return {
    clientVersion: CODEX_RUNTIME_ASSETS.clientVersion,
    clientVersionSource: toSerializableAssetSource(CODEX_RUNTIME_ASSETS.clientVersionSource),
    promptSource: toSerializableAssetSource(CHAT_INSTRUCTIONS_SOURCE),
    modelsSource: toSerializableAssetSource(CODEX_RUNTIME_ASSETS.modelsSource),
    modelsFile: CODEX_RUNTIME_ASSETS.modelsFile,
  }
}

const OFFICIAL_ASSETS_STATUS = buildOfficialAssetsStatus()

console.log(
  `[oauth-multi-login] codex assets version=${OFFICIAL_ASSETS_STATUS.clientVersion} version_source=${OFFICIAL_ASSETS_STATUS.clientVersionSource.kind} prompt_source=${OFFICIAL_ASSETS_STATUS.promptSource.kind} models_source=${OFFICIAL_ASSETS_STATUS.modelsSource.kind}`,
)
if (OFFICIAL_ASSETS_STATUS.clientVersionSource.path) {
  console.log(`[oauth-multi-login] codex client version source: ${OFFICIAL_ASSETS_STATUS.clientVersionSource.path}`)
}
if (OFFICIAL_ASSETS_STATUS.promptSource.path) {
  console.log(`[oauth-multi-login] codex prompt source: ${OFFICIAL_ASSETS_STATUS.promptSource.path}`)
}
if (OFFICIAL_ASSETS_STATUS.modelsFile) {
  console.log(`[oauth-multi-login] codex models source: ${OFFICIAL_ASSETS_STATUS.modelsFile}`)
}
if (OFFICIAL_ASSETS_STATUS.modelsSource.kind === "fallback") {
  console.log("[oauth-multi-login] codex model catalog source: hardcoded fallback")
}
if (
  OFFICIAL_ASSETS_STATUS.clientVersionSource.kind === "fallback" ||
  OFFICIAL_ASSETS_STATUS.promptSource.kind === "fallback"
) {
  console.warn("[oauth-multi-login] codex official assets are partially unavailable; fallback values are active")
}

type CodexModelCatalogEntry = {
  id: string
  displayName: string
  description: string | null
  visibility: string
  supportedInApi: boolean
  defaultReasoningLevel: string
  supportedReasoningLevels: string[]
  supportsParallelToolCalls: boolean
  supportsReasoningSummaries: boolean
  supportVerbosity: boolean
  defaultVerbosity: string | null
  defaultReasoningSummary: string | null
  reasoningSummaryFormat: string | null
  preferWebsockets: boolean
  minimalClientVersion: string | null
  contextWindow: number | null
  maxContextWindow: number | null
  apiMetadata: Record<string, unknown>
}

type CodexOfficialModelsFile = {
  models?: Array<Record<string, unknown> & {
    slug?: string
    display_name?: string
    description?: string
    visibility?: string
    supported_in_api?: boolean
    default_reasoning_level?: string
    supported_reasoning_levels?: Array<{ effort?: string }>
    supports_parallel_tool_calls?: boolean
    supports_reasoning_summaries?: boolean
    support_verbosity?: boolean
    default_verbosity?: string
    default_reasoning_summary?: string
    reasoning_summary_format?: string
    prefer_websockets?: boolean
    minimal_client_version?: string
    context_window?: number
    max_context_window?: number
    effective_context_window_percent?: number
    experimental_supported_tools?: unknown[]
    additional_speed_tiers?: string[]
    input_modalities?: string[]
    truncation_policy?: Record<string, unknown>
    supports_image_detail_original?: boolean
    apply_patch_tool_type?: string
    web_search_tool_type?: string
    shell_type?: string
    supports_search_tool?: boolean
  }>
}

const OFFICIAL_CODEX_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
] as const

const OFFICIAL_CODEX_REASONING_LEVEL_IDS = OFFICIAL_CODEX_REASONING_LEVELS.map((level) => level.effort)

const OFFICIAL_CODEX_ALL_PLAN_IDS = [
  "business",
  "edu",
  "education",
  "enterprise",
  "enterprise_cbp_usage_based",
  "finserv",
  "free",
  "free_workspace",
  "go",
  "hc",
  "k12",
  "plus",
  "pro",
  "prolite",
  "quorum",
  "self_serve_business_usage_based",
  "team",
] as const

const OFFICIAL_CODEX_PAID_PLAN_IDS = OFFICIAL_CODEX_ALL_PLAN_IDS.filter(
  (plan) => plan !== "free" && plan !== "free_workspace" && plan !== "k12",
)

function createFallbackModelCatalogEntry(input: {
  id: string
  displayName?: string
  description?: string
  visibility?: string
  supportedInApi?: boolean
  defaultReasoningLevel?: string
  supportedReasoningLevels?: string[]
  supportsParallelToolCalls?: boolean
  supportsReasoningSummaries?: boolean
  supportVerbosity?: boolean
  defaultVerbosity?: string | null
  defaultReasoningSummary?: string | null
  reasoningSummaryFormat?: string | null
  preferWebsockets?: boolean
  minimalClientVersion?: string | null
  contextWindow?: number | null
  maxContextWindow?: number | null
  apiMetadata?: Record<string, unknown>
}) {
  const entry: CodexModelCatalogEntry = {
    id: input.id,
    displayName: input.displayName ?? input.id,
    description: input.description ?? null,
    visibility: input.visibility ?? "list",
    supportedInApi: input.supportedInApi !== false,
    defaultReasoningLevel: input.defaultReasoningLevel ?? "medium",
    supportedReasoningLevels: [...(input.supportedReasoningLevels ?? ["medium"])],
    supportsParallelToolCalls: input.supportsParallelToolCalls !== false,
    supportsReasoningSummaries: input.supportsReasoningSummaries !== false,
    supportVerbosity: input.supportVerbosity !== false,
    defaultVerbosity: input.defaultVerbosity ?? null,
    defaultReasoningSummary: input.defaultReasoningSummary ?? null,
    reasoningSummaryFormat: input.reasoningSummaryFormat ?? null,
    preferWebsockets: input.preferWebsockets !== false,
    minimalClientVersion: input.minimalClientVersion ?? null,
    contextWindow: Number.isFinite(Number(input.contextWindow)) ? Math.max(0, Math.floor(Number(input.contextWindow))) : null,
    maxContextWindow: Number.isFinite(Number(input.maxContextWindow))
      ? Math.max(0, Math.floor(Number(input.maxContextWindow)))
      : null,
    apiMetadata: {},
  }

  entry.apiMetadata = {
    slug: entry.id,
    display_name: entry.displayName,
    description: entry.description,
    visibility: entry.visibility,
    supported_in_api: entry.supportedInApi,
    default_reasoning_level: entry.defaultReasoningLevel,
    supported_reasoning_levels: entry.supportedReasoningLevels.map((effort) => ({ effort })),
    supports_parallel_tool_calls: entry.supportsParallelToolCalls,
    supports_reasoning_summaries: entry.supportsReasoningSummaries,
    support_verbosity: entry.supportVerbosity,
    default_verbosity: entry.defaultVerbosity,
    default_reasoning_summary: entry.defaultReasoningSummary,
    reasoning_summary_format: entry.reasoningSummaryFormat,
    prefer_websockets: entry.preferWebsockets,
    minimal_client_version: entry.minimalClientVersion,
    context_window: entry.contextWindow,
    max_context_window: entry.maxContextWindow,
    ...(input.apiMetadata ?? {}),
  }

  return entry
}

const FALLBACK_MODEL_CATALOG: CodexModelCatalogEntry[] = [
  createFallbackModelCatalogEntry({
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Frontier model for complex coding, research, and real-world work.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: [...OFFICIAL_CODEX_REASONING_LEVEL_IDS],
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    supportVerbosity: true,
    defaultVerbosity: "low",
    defaultReasoningSummary: "none",
    reasoningSummaryFormat: "experimental",
    preferWebsockets: true,
    minimalClientVersion: "0.124.0",
    contextWindow: 272000,
    maxContextWindow: 272000,
    apiMetadata: {
      supported_reasoning_levels: [...OFFICIAL_CODEX_REASONING_LEVELS],
      shell_type: "shell_command",
      priority: 0,
      additional_speed_tiers: ["fast"],
      available_in_plans: [...OFFICIAL_CODEX_ALL_PLAN_IDS],
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_image_detail_original: true,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
    },
  }),
  createFallbackModelCatalogEntry({
    id: "gpt-5.4",
    displayName: "gpt-5.4",
    description: "Strong model for everyday coding.",
    defaultReasoningLevel: "xhigh",
    supportedReasoningLevels: [...OFFICIAL_CODEX_REASONING_LEVEL_IDS],
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    supportVerbosity: true,
    defaultVerbosity: "low",
    defaultReasoningSummary: "none",
    reasoningSummaryFormat: "experimental",
    preferWebsockets: true,
    minimalClientVersion: "0.98.0",
    contextWindow: 272000,
    maxContextWindow: 1000000,
    apiMetadata: {
      supported_reasoning_levels: [...OFFICIAL_CODEX_REASONING_LEVELS],
      shell_type: "shell_command",
      priority: 2,
      additional_speed_tiers: ["fast"],
      available_in_plans: [...OFFICIAL_CODEX_PAID_PLAN_IDS],
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_image_detail_original: true,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
    },
  }),
  createFallbackModelCatalogEntry({
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Small, fast, and cost-efficient model for simpler coding tasks.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    supportVerbosity: true,
    defaultVerbosity: "medium",
    defaultReasoningSummary: "none",
    reasoningSummaryFormat: "experimental",
    preferWebsockets: true,
    minimalClientVersion: "0.98.0",
    contextWindow: 272000,
    maxContextWindow: 272000,
    apiMetadata: {
      supported_reasoning_levels: [...OFFICIAL_CODEX_REASONING_LEVELS],
      shell_type: "shell_command",
      priority: 4,
      additional_speed_tiers: [],
      available_in_plans: [...OFFICIAL_CODEX_ALL_PLAN_IDS],
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_image_detail_original: true,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
    },
  }),
  createFallbackModelCatalogEntry({
    id: "gpt-5.3-codex",
    displayName: "gpt-5.3-codex",
    description: "Coding-optimized model.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    supportVerbosity: true,
    defaultVerbosity: "low",
    defaultReasoningSummary: "none",
    reasoningSummaryFormat: "experimental",
    preferWebsockets: true,
    minimalClientVersion: "0.98.0",
    contextWindow: 272000,
    maxContextWindow: 272000,
    apiMetadata: {
      supported_reasoning_levels: [...OFFICIAL_CODEX_REASONING_LEVELS],
      shell_type: "shell_command",
      priority: 6,
      additional_speed_tiers: [],
      available_in_plans: [...OFFICIAL_CODEX_PAID_PLAN_IDS],
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_image_detail_original: true,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      upgrade: {
        model: "gpt-5.4",
        migration_markdown:
          "Introducing GPT-5.4\n\nCodex just got an upgrade with GPT-5.4, our most capable model for professional work. It outperforms prior models while being more token efficient, with notable improvements on long-running tasks, tool calling, computer use, and frontend development.\n\nLearn more: https://openai.com/index/introducing-gpt-5-4\n\nYou can always keep using GPT-5.3-Codex if you prefer.\n",
      },
    },
  }),
  createFallbackModelCatalogEntry({
    id: "gpt-5.2",
    displayName: "gpt-5.2",
    description: "Optimized for professional work and long-running agents.",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    supportVerbosity: true,
    defaultVerbosity: "low",
    defaultReasoningSummary: "auto",
    reasoningSummaryFormat: "none",
    preferWebsockets: true,
    minimalClientVersion: "0.0.1",
    contextWindow: 272000,
    maxContextWindow: 272000,
    apiMetadata: {
      supported_reasoning_levels: [...OFFICIAL_CODEX_REASONING_LEVELS],
      shell_type: "shell_command",
      priority: 10,
      additional_speed_tiers: [],
      available_in_plans: [...OFFICIAL_CODEX_ALL_PLAN_IDS],
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_image_detail_original: false,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      upgrade: {
        model: "gpt-5.4",
        migration_markdown:
          "Introducing GPT-5.4\n\nCodex just got an upgrade with GPT-5.4, our most capable model for professional work. It outperforms prior models while being more token efficient, with notable improvements on long-running tasks, tool calling, computer use, and frontend development.\n\nLearn more: https://openai.com/index/introducing-gpt-5-4\n\nYou can always keep using GPT-5.3-Codex if you prefer.\n",
      },
    },
  }),
  createFallbackModelCatalogEntry({
    id: "codex-auto-review",
    displayName: "Codex Auto Review",
    description: "Automatic approval review model for Codex.",
    visibility: "hide",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    supportsParallelToolCalls: true,
    supportsReasoningSummaries: true,
    supportVerbosity: true,
    defaultVerbosity: "low",
    defaultReasoningSummary: "none",
    reasoningSummaryFormat: "experimental",
    preferWebsockets: true,
    minimalClientVersion: "0.98.0",
    contextWindow: 272000,
    maxContextWindow: 1000000,
    apiMetadata: {
      supported_reasoning_levels: [...OFFICIAL_CODEX_REASONING_LEVELS],
      shell_type: "shell_command",
      priority: 29,
      additional_speed_tiers: [],
      available_in_plans: [...OFFICIAL_CODEX_PAID_PLAN_IDS],
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_image_detail_original: true,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
    },
  }),
]

async function loadCodexModelCatalog(): Promise<CodexModelCatalogEntry[]> {
  const modelsFilePath =
    OFFICIAL_ASSETS_STATUS.modelsSource.kind !== "fallback" ? OFFICIAL_ASSETS_STATUS.modelsFile : null
  if (modelsFilePath && existsSync(modelsFilePath)) {
    try {
      const raw = await readFile(modelsFilePath, "utf8")
      const parsed = JSON.parse(raw) as CodexOfficialModelsFile
      const mapped = (parsed.models ?? [])
        .filter((model) => model && model.supported_in_api !== false)
        .map((model) => {
          const id = extractModelID(model.slug)
          if (!id) return null
          const supported =
            (model.supported_reasoning_levels ?? [])
              .map((level) => extractModelID(level.effort))
              .filter((level): level is string => Boolean(level)) || []
          const normalizedSupported = supported.length > 0 ? supported : ["medium"]
          const defaultReasoningLevel = extractModelID(model.default_reasoning_level) ?? "medium"
          const contextWindow = Number.isFinite(Number(model.context_window))
            ? Math.max(0, Math.floor(Number(model.context_window)))
            : null
          const maxContextWindow = Number.isFinite(Number(model.max_context_window))
            ? Math.max(0, Math.floor(Number(model.max_context_window)))
            : null
          const defaultVerbosity = extractModelID(model.default_verbosity)
          const defaultReasoningSummary = extractModelID(model.default_reasoning_summary)
          const reasoningSummaryFormat = extractModelID(model.reasoning_summary_format)
          const visibility = extractModelID(model.visibility) ?? "list"
          const supportedInApi = model.supported_in_api !== false
          const displayName = extractModelID(model.display_name) ?? id
          const description = extractModelID(model.description)
          const minimalClientVersion = extractModelID(model.minimal_client_version)
          const apiMetadata: Record<string, unknown> = {}
          const metadataKeys = [
            "slug",
            "display_name",
            "description",
            "visibility",
            "supported_in_api",
            "default_reasoning_level",
            "supported_reasoning_levels",
            "supports_parallel_tool_calls",
            "supports_reasoning_summaries",
            "support_verbosity",
            "default_verbosity",
            "default_reasoning_summary",
            "reasoning_summary_format",
            "prefer_websockets",
            "minimal_client_version",
            "context_window",
            "max_context_window",
            "effective_context_window_percent",
            "experimental_supported_tools",
            "input_modalities",
            "truncation_policy",
            "auto_compact_token_limit",
            "supports_image_detail_original",
            "apply_patch_tool_type",
            "web_search_tool_type",
            "shell_type",
            "base_instructions",
            "model_messages",
            "availability_nux",
            "upgrade",
            "priority",
            "additional_speed_tiers",
            "available_in_plans",
            "supports_search_tool",
          ] as const
          for (const key of metadataKeys) {
            if (hasOwnKey(model, key)) {
              apiMetadata[key] = model[key]
            }
          }
          return {
            id,
            displayName,
            description,
            visibility,
            supportedInApi,
            defaultReasoningLevel,
            supportedReasoningLevels: normalizedSupported,
            supportsParallelToolCalls: model.supports_parallel_tool_calls !== false,
            supportsReasoningSummaries: model.supports_reasoning_summaries !== false,
            supportVerbosity: model.support_verbosity !== false,
            defaultVerbosity,
            defaultReasoningSummary,
            reasoningSummaryFormat,
            preferWebsockets: model.prefer_websockets !== false,
            minimalClientVersion,
            contextWindow,
            maxContextWindow,
            apiMetadata,
          } satisfies CodexModelCatalogEntry
        })
        .filter((item): item is CodexModelCatalogEntry => Boolean(item))
      if (mapped.length > 0) return mapped
    } catch {
      // ignore and continue
    }
  }

  return FALLBACK_MODEL_CATALOG
}

function serializeChatModelCatalogEntry(input: CodexModelCatalogEntry) {
  return {
    id: input.id,
    displayName: input.displayName,
    description: input.description,
    visibility: input.visibility,
    supportedInApi: input.supportedInApi,
    defaultReasoningLevel: input.defaultReasoningLevel,
    supportedReasoningLevels: [...input.supportedReasoningLevels],
    supportsParallelToolCalls: input.supportsParallelToolCalls,
    supportsReasoningSummaries: input.supportsReasoningSummaries,
    supportVerbosity: input.supportVerbosity,
    defaultVerbosity: input.defaultVerbosity,
    defaultReasoningSummary: input.defaultReasoningSummary,
    reasoningSummaryFormat: input.reasoningSummaryFormat,
    preferWebsockets: input.preferWebsockets,
    minimalClientVersion: input.minimalClientVersion,
    contextWindow: input.contextWindow,
    maxContextWindow: input.maxContextWindow,
    inputModalities: Array.isArray(input.apiMetadata.input_modalities)
      ? [...(input.apiMetadata.input_modalities as string[])]
      : [],
    truncationPolicy:
      input.apiMetadata.truncation_policy && typeof input.apiMetadata.truncation_policy === "object"
        ? { ...(input.apiMetadata.truncation_policy as Record<string, unknown>) }
        : null,
    autoCompactTokenLimit:
      input.apiMetadata.auto_compact_token_limit !== undefined ? input.apiMetadata.auto_compact_token_limit : null,
    supportsImageDetailOriginal: input.apiMetadata.supports_image_detail_original === true,
    applyPatchToolType: extractModelID(input.apiMetadata.apply_patch_tool_type),
    webSearchToolType: extractModelID(input.apiMetadata.web_search_tool_type),
    shellType: extractModelID(input.apiMetadata.shell_type),
    availabilityNux:
      input.apiMetadata.availability_nux && typeof input.apiMetadata.availability_nux === "object"
        ? { ...(input.apiMetadata.availability_nux as Record<string, unknown>) }
        : null,
    upgrade:
      input.apiMetadata.upgrade && typeof input.apiMetadata.upgrade === "object"
        ? { ...(input.apiMetadata.upgrade as Record<string, unknown>) }
        : null,
    priority: Number.isFinite(Number(input.apiMetadata.priority))
      ? Math.max(0, Math.floor(Number(input.apiMetadata.priority)))
      : null,
    additionalSpeedTiers: Array.isArray(input.apiMetadata.additional_speed_tiers)
      ? [...(input.apiMetadata.additional_speed_tiers as unknown[])]
      : [],
    availableInPlans: Array.isArray(input.apiMetadata.available_in_plans)
      ? [...(input.apiMetadata.available_in_plans as unknown[])]
      : [],
    supportsSearchTool: input.apiMetadata.supports_search_tool === true,
  }
}

const CODEX_MODEL_CATALOG = await loadCodexModelCatalog()
const DEFAULT_CHAT_MODELS = CODEX_MODEL_CATALOG.filter(
  (item) => item.supportedInApi && item.visibility.toLowerCase() !== "hide",
).map((item) => item.id)
const CURSOR_STABLE_MODEL_IDS = [...DEFAULT_CHAT_MODELS]
const MODEL_REASONING_LEVELS: Record<string, string[]> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.supportedReasoningLevels]),
)
const MODEL_DEFAULT_REASONING_LEVELS: Record<string, string> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.defaultReasoningLevel]),
)
const MODEL_SUPPORTS_PARALLEL_TOOL_CALLS: Record<string, boolean> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.supportsParallelToolCalls]),
)
const MODEL_MAX_CONTEXT_WINDOWS: Record<string, number | null> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.maxContextWindow]),
)
const MODEL_CONTEXT_WINDOWS: Record<string, number | null> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.contextWindow]),
)
const MODEL_SUPPORTS_REASONING_SUMMARIES: Record<string, boolean> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.supportsReasoningSummaries]),
)
const MODEL_SUPPORTS_VERBOSITY: Record<string, boolean> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.supportVerbosity]),
)
const MODEL_DEFAULT_VERBOSITIES: Record<string, string | null> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.defaultVerbosity]),
)
const MODEL_DEFAULT_REASONING_SUMMARIES: Record<string, string | null> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.defaultReasoningSummary]),
)
const MODEL_VISIBILITIES: Record<string, string> = Object.fromEntries(CODEX_MODEL_CATALOG.map((item) => [item.id, item.visibility]))

function resolveChatModelCatalog() {
  return CODEX_MODEL_CATALOG.filter((item) => item.supportedInApi && item.visibility.toLowerCase() !== "hide").map((item) =>
    serializeChatModelCatalogEntry(item),
  )
}

function resolveChatModelList() {
  return resolveChatModelCatalog()
}

function resolveDefaultChatModelId() {
  return DEFAULT_CHAT_MODELS[0] ?? CODEX_MODEL_CATALOG[0]?.id ?? "gpt-5.5"
}

function buildChatModelsResponsePayload() {
  return {
    models: resolveChatModelCatalog(),
    defaultModelId: resolveDefaultChatModelId(),
  }
}

function getModelCatalogEntry(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return null
  return CODEX_MODEL_CATALOG.find((item) => item.id === normalized) ?? null
}

function resolveModelContextWindow(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return null
  return MODEL_MAX_CONTEXT_WINDOWS[normalized] ?? null
}

function resolveModelBaseContextWindow(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return null
  return MODEL_CONTEXT_WINDOWS[normalized] ?? null
}

function resolveSupportedReasoningLevelsForModel(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return []
  return [...(MODEL_REASONING_LEVELS[normalized] ?? [])]
}

function resolveDefaultReasoningEffortForModel(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return "medium"
  const explicit = MODEL_DEFAULT_REASONING_LEVELS[normalized]
  if (explicit) return explicit
  const supported = resolveSupportedReasoningLevelsForModel(normalized)
  if (supported.includes("medium")) return "medium"
  return supported[0] ?? "medium"
}

function normalizeReasoningEffortForModel(model: string, effort?: string | null) {
  const normalizedEffort = normalizeReasoningEffort(effort)
  const normalizedModel = extractModelID(model)
  if (!normalizedModel) return normalizedEffort ?? "medium"
  const supported = resolveSupportedReasoningLevelsForModel(normalizedModel)
  if (!normalizedEffort) return resolveDefaultReasoningEffortForModel(normalizedModel)
  if (supported.length === 0 || supported.includes(normalizedEffort)) return normalizedEffort
  return normalizedEffort
}

function isModelIdOnlyHardcodedOverride(model: string) {
  const normalized = extractModelID(model)
  return Boolean(normalized && (normalized === "gpt-5.5" || normalized.startsWith("gpt-5.5-")))
}

function isUnknownGpt55ModelVariant(model: string) {
  const normalized = extractModelID(model)
  return Boolean(normalized && normalized !== "gpt-5.5" && normalized.startsWith("gpt-5.5-"))
}

function modelSupportsReasoningSummaries(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return false
  if (isUnknownGpt55ModelVariant(normalized)) return false
  if (hasOwnKey(MODEL_SUPPORTS_REASONING_SUMMARIES, normalized)) {
    return MODEL_SUPPORTS_REASONING_SUMMARIES[normalized] !== false
  }
  return normalized.startsWith("gpt-5") || normalized.startsWith("o") || normalized.startsWith("codex-")
}

function resolveDefaultReasoningSummaryForModel(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return null
  if (hasOwnKey(MODEL_DEFAULT_REASONING_SUMMARIES, normalized)) {
    return MODEL_DEFAULT_REASONING_SUMMARIES[normalized] ?? null
  }
  return modelSupportsReasoningSummaries(normalized) ? "auto" : null
}

function modelSupportsVerbosity(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return false
  if (isUnknownGpt55ModelVariant(normalized)) return false
  if (hasOwnKey(MODEL_SUPPORTS_VERBOSITY, normalized)) {
    return MODEL_SUPPORTS_VERBOSITY[normalized] !== false
  }
  return normalized.startsWith("gpt-5") || normalized.startsWith("codex-")
}

function resolveDefaultVerbosityForModel(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return null
  if (hasOwnKey(MODEL_DEFAULT_VERBOSITIES, normalized)) {
    return MODEL_DEFAULT_VERBOSITIES[normalized] ?? null
  }
  return modelSupportsVerbosity(normalized) ? "low" : null
}

function buildReasoningPayloadForModel(model: string, effort?: string | null) {
  if (!modelSupportsReasoningSummaries(model)) return null
  const reasoning: Record<string, unknown> = {
    effort: normalizeReasoningEffortForModel(model, effort ?? null),
  }
  const summary = resolveDefaultReasoningSummaryForModel(model)
  if (summary && summary !== "none") {
    reasoning.summary = summary
  }
  return reasoning
}

function buildForcedReasoningPayloadForModel(model: string, effort?: string | null) {
  const normalizedEffort = normalizeReasoningEffortForModel(model, effort ?? null)
  if (!normalizedEffort) return null
  return {
    effort: normalizedEffort,
  }
}

function resolveVirtualKeyRequestOverrides(key: {
  fixedModel?: unknown
  fixedReasoningEffort?: unknown
}) {
  return {
    fixedModel: extractModelID(key.fixedModel),
    fixedReasoningEffort: normalizeReasoningEffort(key.fixedReasoningEffort),
  }
}

function applyVirtualKeyOverridesToResponsesBody(
  parsedRoot: Record<string, unknown> | null,
  overrides: {
    fixedModel?: string | null
    fixedReasoningEffort?: string | null
  },
) {
  if (!overrides.fixedModel && !overrides.fixedReasoningEffort) return parsedRoot
  const next: Record<string, unknown> = { ...(parsedRoot ?? {}) }
  if (overrides.fixedModel) {
    next.model = overrides.fixedModel
  }
  if (overrides.fixedReasoningEffort) {
    next.reasoning_effort = overrides.fixedReasoningEffort
    next.model_reasoning_effort = overrides.fixedReasoningEffort
    const reasoning = buildForcedReasoningPayloadForModel(
      overrides.fixedModel ?? extractModelID(next.model) ?? "gpt-5.4",
      overrides.fixedReasoningEffort,
    )
    if (reasoning) {
      next.reasoning = reasoning
    }
  }
  return next
}

function buildTextConfigForModel(model: string) {
  if (!modelSupportsVerbosity(model)) return null
  const verbosity = resolveDefaultVerbosityForModel(model)
  if (!verbosity) return null
  return {
    verbosity,
  }
}

function shouldAutoTruncateModel(model: string) {
  const maxContextWindow = resolveModelContextWindow(model)
  if (maxContextWindow && maxContextWindow > 0 && maxContextWindow <= 272000) return true
  const contextWindow = resolveModelBaseContextWindow(model)
  return Boolean(contextWindow && contextWindow > 0 && contextWindow <= 272000)
}

function modelSupportsTruncationParameter(model: string) {
  const normalized = extractModelID(model)
  if (!normalized) return true
  return !isModelIdOnlyHardcodedOverride(normalized)
}

function shouldSendAutoTruncation(model: string, modelConfig: ResponsesModelConfig) {
  if (!modelSupportsTruncationParameter(model)) return false
  return modelConfig.requiredAutoTruncation || shouldAutoTruncateModel(model)
}

const StartLoginSchema = z.object({
  providerId: z.string().min(1),
  methodId: z.string().min(1),
  options: z.record(z.string(), z.string()).optional().default({}),
})

const CodeSchema = z.object({
  code: z.string().min(1),
})

const ChatSchema = z.object({
  accountId: z.string().min(1),
  model: z.string().trim().min(1).max(120),
  message: z.string().min(1).max(12000),
  sessionId: z.string().optional(),
})

const VirtualKeyChatSchema = z.object({
  keyId: z.string().min(1),
  model: z.string().trim().min(1).max(120),
  message: z.string().min(1).max(12000),
  sessionId: z.string().optional(),
})

const IssueVirtualKeySchema = z.object({
  accountId: z.string().min(1).optional(),
  providerId: z.string().trim().min(1).optional().default("chatgpt"),
  routingMode: z.enum(["single", "pool"]).optional().default("pool"),
  accountScope: z.enum(["all", "member", "free"]).optional().default("all"),
  clientMode: z.enum(["codex", "cursor"]).optional().default("codex"),
  wireApi: z.enum(["responses", "chat_completions"]).optional(),
  name: z.string().trim().max(120).optional(),
  fixedModel: z.string().trim().max(120).nullable().optional(),
  fixedReasoningEffort: z.string().trim().max(64).nullable().optional(),
  validityDays: z.number().int().min(1).max(3650).nullable().optional().default(30),
})

const CursorChatContentPartSchema = z.union([
  z.object({
    type: z.string().trim().min(1),
    text: z.string().optional(),
  }),
  z.object({
    type: z.string().trim().min(1),
    input_text: z.string().optional(),
    text: z.string().optional(),
  }),
])

const CursorToolSchema = z.object({
  type: z.string().trim().min(1).default("function"),
  function: z
    .object({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(4000).optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})

const CursorChatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(CursorChatContentPartSchema)]).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  tool_call_id: z.string().trim().min(1).max(200).optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(200).optional(),
        type: z.string().trim().min(1).default("function"),
        function: z.object({
          name: z.string().trim().min(1).max(200),
          arguments: z.string().optional().default(""),
        }),
      }),
    )
    .optional(),
})

const CursorChatCompletionsSchema = z.object({
  model: z.string().trim().min(1).max(120),
  messages: z.array(CursorChatMessageSchema).min(1),
  tools: z.array(CursorToolSchema).optional().default([]),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  stream: z.boolean().optional().default(false),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  user: z.string().trim().min(1).max(200).optional(),
  parallel_tool_calls: z.boolean().optional(),
})

const BulkDeleteAccountsSchema = z.object({
  ids: z.array(z.string().trim().min(1)).max(500).optional().default([]),
  accountIds: z.array(z.string().trim().min(1)).max(500).optional().default([]),
  mode: z.string().trim().optional(),
})

const ExportAccountsSchema = z.object({
  ids: z.array(z.string().trim().min(1)).max(500).optional().default([]),
})

const RenameVirtualKeySchema = z.object({
  name: z.string().trim().max(120).nullable().optional().default(null),
})

const RenewVirtualKeySchema = z.object({
  validityDays: z.number().int().min(1).max(3650).nullable().optional().default(30),
})

const UpdateVirtualKeySchema = z.object({
  accountId: z.string().trim().min(1).nullable().optional(),
  providerId: z.string().trim().min(1).optional(),
  routingMode: z.enum(["single", "pool"]).optional(),
  accountScope: z.enum(["all", "member", "free"]).optional(),
  clientMode: z.enum(["codex", "cursor"]).optional(),
  wireApi: z.enum(["responses", "chat_completions"]).optional(),
  name: z.string().trim().max(120).nullable().optional(),
  fixedModel: z.string().trim().max(120).nullable().optional(),
  fixedReasoningEffort: z.string().trim().max(64).nullable().optional(),
})

const SyncOAuthSchema = z.object({
  providerId: z.enum(["chatgpt", "openai"]).default("chatgpt"),
  providerName: z.string().trim().min(1).max(80).optional().default("ChatGPT"),
  methodId: z.string().trim().min(1).max(80).optional().default("codex-oauth"),
  displayName: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().email().optional(),
  accountId: z.string().trim().min(1).max(160).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  id_token: z.string().optional(),
  expiresAt: z.number().int().positive().optional(),
  organizationId: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  chatgptPlanType: z.string().trim().min(1).max(120).optional(),
  chatgptUserId: z.string().trim().min(1).max(200).optional(),
  completedPlatformOnboarding: z.boolean().optional(),
  isOrgOwner: z.boolean().optional(),
  keyName: z.string().trim().max(120).optional(),
  issueVirtualKey: z.boolean().optional().default(true),
})

function normalizeImportedJsonString(value: unknown) {
  if (value == null) return undefined
  const normalized = String(value).trim()
  return normalized.length > 0 ? normalized : undefined
}

function preprocessImportedJsonString(value: unknown) {
  return normalizeImportedJsonString(value)
}

function preprocessImportedJsonDateValue(value: unknown) {
  if (value == null) return undefined
  if (typeof value === "number" && Number.isFinite(value)) return value
  return normalizeImportedJsonString(value)
}

const ImportJsonOptionalString = (schema: z.ZodString) =>
  z.preprocess(preprocessImportedJsonString, schema.optional())

const ImportJsonAccountSchema = z
  .object({
    type: ImportJsonOptionalString(z.string().max(80)),
    email: ImportJsonOptionalString(z.string().email()),
    access_token: ImportJsonOptionalString(z.string().min(1)),
    accessToken: ImportJsonOptionalString(z.string().min(1)),
    refresh_token: ImportJsonOptionalString(z.string().min(1)),
    refreshToken: ImportJsonOptionalString(z.string().min(1)),
    id_token: ImportJsonOptionalString(z.string().min(1)),
    idToken: ImportJsonOptionalString(z.string().min(1)),
    account_id: ImportJsonOptionalString(z.string().max(200)),
    accountId: ImportJsonOptionalString(z.string().max(200)),
    workspace_id: ImportJsonOptionalString(z.string().max(200)),
    workspaceId: ImportJsonOptionalString(z.string().max(200)),
    client_id: ImportJsonOptionalString(z.string().max(200)),
    clientId: ImportJsonOptionalString(z.string().max(200)),
    session_token: ImportJsonOptionalString(z.string().max(500)),
    sessionToken: ImportJsonOptionalString(z.string().max(500)),
    email_service: ImportJsonOptionalString(z.string().max(120)),
    emailService: ImportJsonOptionalString(z.string().max(120)),
    registered_at: ImportJsonOptionalString(z.string().max(120)),
    registeredAt: ImportJsonOptionalString(z.string().max(120)),
    status: ImportJsonOptionalString(z.string().max(80)),
    last_refresh: ImportJsonOptionalString(z.string().max(120)),
    lastRefresh: ImportJsonOptionalString(z.string().max(120)),
    expires_at: z.preprocess(preprocessImportedJsonDateValue, z.union([z.string(), z.number()]).optional()),
    expiresAt: z.preprocess(preprocessImportedJsonDateValue, z.union([z.string(), z.number()]).optional()),
    issueVirtualKey: z.boolean().optional().default(false),
    keyName: ImportJsonOptionalString(z.string().max(120)),
  })
  .superRefine((value, ctx) => {
    if (!String(value.access_token ?? value.accessToken ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "access_token is required",
        path: ["access_token"],
      })
    }
  })

const ImportRtAccountSchema = z
  .object({
    providerId: z.literal("chatgpt").optional().default("chatgpt"),
    providerName: z.string().trim().min(1).max(80).optional().default("ChatGPT"),
    methodId: z.string().trim().min(1).max(80).optional().default("refresh-token-import"),
    displayName: ImportJsonOptionalString(z.string().max(160)),
    email: ImportJsonOptionalString(z.string().email()),
    access_token: ImportJsonOptionalString(z.string().min(1)),
    accessToken: ImportJsonOptionalString(z.string().min(1)),
    refresh_token: ImportJsonOptionalString(z.string().min(1)),
    refreshToken: ImportJsonOptionalString(z.string().min(1)),
    id_token: ImportJsonOptionalString(z.string().min(1)),
    idToken: ImportJsonOptionalString(z.string().min(1)),
    account_id: ImportJsonOptionalString(z.string().max(200)),
    accountId: ImportJsonOptionalString(z.string().max(200)),
    workspace_id: ImportJsonOptionalString(z.string().max(200)),
    workspaceId: ImportJsonOptionalString(z.string().max(200)),
    organization_id: ImportJsonOptionalString(z.string().max(200)),
    organizationId: ImportJsonOptionalString(z.string().max(200)),
    project_id: ImportJsonOptionalString(z.string().max(200)),
    projectId: ImportJsonOptionalString(z.string().max(200)),
    chatgpt_plan_type: ImportJsonOptionalString(z.string().max(120)),
    chatgptPlanType: ImportJsonOptionalString(z.string().max(120)),
    chatgpt_user_id: ImportJsonOptionalString(z.string().max(200)),
    chatgptUserId: ImportJsonOptionalString(z.string().max(200)),
    completed_platform_onboarding: z.boolean().optional(),
    completedPlatformOnboarding: z.boolean().optional(),
    is_org_owner: z.boolean().optional(),
    isOrgOwner: z.boolean().optional(),
    expires_at: z.preprocess(preprocessImportedJsonDateValue, z.union([z.string(), z.number()]).optional()),
    expiresAt: z.preprocess(preprocessImportedJsonDateValue, z.union([z.string(), z.number()]).optional()),
    issueVirtualKey: z.boolean().optional().default(false),
    keyName: ImportJsonOptionalString(z.string().max(120)),
  })
  .superRefine((value, ctx) => {
    if (!String(value.refresh_token ?? value.refreshToken ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "refresh_token is required",
        path: ["refresh_token"],
      })
    }
  })
const AddApiKeyAccountSchema = z.object({
  providerId: z.literal("openai").optional().default("openai"),
  providerName: z.string().trim().min(1).max(80).optional().default("OpenAI"),
  methodId: z.literal("api-key").optional().default("api-key"),
  displayName: z.string().trim().min(1).max(160).optional(),
  apiKey: z.string().trim().min(1).max(500),
  organizationId: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
})

const UpdateSettingsSchema = z.object({
  localServiceAddress: z.string().trim().max(500).optional().default(""),
  adminToken: z.string().max(500).optional(),
  encryptionKey: z.string().max(500).optional(),
  upstreamPrivacyStrict: z.boolean().optional(),
  officialStrictPassthrough: z.boolean().optional(),
  themeId: z.string().trim().max(80).optional(),
})

const OpenExternalUrlSchema = z.object({
  url: z.string().trim().url().max(2048),
})

function isTokenExpired(account: StoredAccount) {
  if (!account.expiresAt) return false
  return account.expiresAt < Date.now()
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hasOwnKey(record: Record<string, unknown> | null | undefined, key: string) {
  return Boolean(record) && Object.prototype.hasOwnProperty.call(record, key)
}

function pickFirstDefinedValue(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
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

function normalizeNullableString(value: unknown, maxLength = 240) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    return trimmed.slice(0, 64)
  }
  const record = asRecord(value)
  if (!record) return null
  return normalizeReasoningEffort(
    pickFirstDefinedValue(record.effort, record.level, record.value, record.reasoning_effort, record.reasoningEffort),
  )
}

function readFirstValue(record: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!record) return undefined
  for (const key of keys) {
    if (hasOwnKey(record, key)) return record[key]
  }
  return undefined
}

function emptyUsageMetrics(): UsageMetrics {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    estimatedCostUsd: null,
    reasoningEffort: null,
  }
}

function normalizeUsage(payload: unknown): UsageMetrics {
  const payloadRecord = asRecord(payload)
  const usageRecord = asRecord(payloadRecord?.usage)
  const promptDetails = asRecord(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, ["input_tokens_details", "inputTokenDetails", "prompt_tokens_details", "promptTokenDetails"]),
      readFirstValue(payloadRecord, ["input_tokens_details", "inputTokenDetails", "prompt_tokens_details", "promptTokenDetails"]),
    ),
  )
  const completionDetails = asRecord(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, ["output_tokens_details", "outputTokenDetails", "completion_tokens_details", "completionTokenDetails"]),
      readFirstValue(payloadRecord, ["output_tokens_details", "outputTokenDetails", "completion_tokens_details", "completionTokenDetails"]),
    ),
  )

  const promptTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]),
      readFirstValue(payloadRecord, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]),
    ),
  )
  const completionTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]),
      readFirstValue(payloadRecord, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]),
    ),
  )
  const totalCandidate = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, ["total_tokens", "totalTokens"]),
      readFirstValue(payloadRecord, ["total_tokens", "totalTokens"]),
    ),
  )
  const totalTokens = totalCandidate > 0 ? totalCandidate : promptTokens + completionTokens
  const cachedInputTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, [
        "cached_input_tokens",
        "cachedInputTokens",
        "input_cached_tokens",
        "inputCachedTokens",
        "cached_tokens",
        "cachedTokens",
      ]),
      readFirstValue(promptDetails, ["cached_tokens", "cachedTokens", "cached_input_tokens", "cachedInputTokens"]),
      readFirstValue(payloadRecord, [
        "cached_input_tokens",
        "cachedInputTokens",
        "input_cached_tokens",
        "inputCachedTokens",
        "cached_tokens",
        "cachedTokens",
      ]),
    ),
  )
  const reasoningOutputTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, [
        "reasoning_output_tokens",
        "reasoningOutputTokens",
        "output_reasoning_tokens",
        "outputReasoningTokens",
        "reasoning_tokens",
        "reasoningTokens",
      ]),
      readFirstValue(completionDetails, [
        "reasoning_tokens",
        "reasoningTokens",
        "reasoning_output_tokens",
        "reasoningOutputTokens",
      ]),
      readFirstValue(payloadRecord, [
        "reasoning_output_tokens",
        "reasoningOutputTokens",
        "output_reasoning_tokens",
        "outputReasoningTokens",
        "reasoning_tokens",
        "reasoningTokens",
      ]),
    ),
  )
  const estimatedCostUsd = normalizeNullableNonNegativeNumber(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, [
        "estimated_cost_usd",
        "estimatedCostUsd",
        "cost_usd",
        "costUsd",
        "estimated_cost",
        "estimatedCost",
      ]),
      readFirstValue(payloadRecord, [
        "estimated_cost_usd",
        "estimatedCostUsd",
        "cost_usd",
        "costUsd",
        "estimated_cost",
        "estimatedCost",
      ]),
      readFirstValue(asRecord(payloadRecord?.cost), ["usd", "estimated_usd", "estimatedUsd"]),
    ),
  )
  const reasoningEffort = normalizeReasoningEffort(
    pickFirstDefinedValue(
      readFirstValue(usageRecord, [
        "reasoning_effort",
        "reasoningEffort",
        "model_reasoning_effort",
        "modelReasoningEffort",
        "effort",
      ]),
      readFirstValue(payloadRecord, [
        "reasoning_effort",
        "reasoningEffort",
        "model_reasoning_effort",
        "modelReasoningEffort",
        "effort",
      ]),
      payloadRecord?.reasoning,
    ),
  )

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    estimatedCostUsd,
    reasoningEffort,
  }
}

function extractUsageFromUnknown(payload: unknown) {
  const direct = normalizeUsage(payload)
  if (hasUsageDelta(direct)) return direct
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>
    const nestedResponse = normalizeUsage(record.response)
    if (hasUsageDelta(nestedResponse)) return nestedResponse
    const nestedData = normalizeUsage(record.data)
    if (hasUsageDelta(nestedData)) return nestedData
    const nestedResult = normalizeUsage(record.result)
    if (hasUsageDelta(nestedResult)) return nestedResult
  }
  return emptyUsageMetrics()
}

function tryParseJsonText(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function readCodexStream(response: Response) {
  if (!response.body) {
    throw new Error("Codex stream body is empty")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let deltaText = ""
  let doneText = ""
  let completedResponse: unknown = undefined
  let latestUsage = emptyUsageMetrics()

  const consumeSseChunk = (chunk: string) => {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s*/, ""))
      .join("\n")
      .trim()

    if (!data || data === "[DONE]") return

    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }

    const eventUsage = extractUsageFromUnknown(event)
    if (hasUsageDelta(eventUsage)) {
      latestUsage = eventUsage
    }

    const type = String(event.type ?? "")

    if (type === "response.output_text.delta") {
      const delta = event.delta
      if (typeof delta === "string") deltaText += delta
      return
    }

    if (type === "response.output_text.done") {
      const text = event.text
      if (typeof text === "string") doneText = text
      return
    }

    if (type === "response.completed") {
      completedResponse = event.response
      const completedUsage = extractUsageFromUnknown(event.response)
      if (hasUsageDelta(completedUsage)) {
        latestUsage = completedUsage
      }
      return
    }

    if (type === "response.failed" || type === "error") {
      throw new Error(data)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const chunks = buffer.split("\n\n")
    buffer = chunks.pop() ?? ""

    for (const chunk of chunks) {
      consumeSseChunk(chunk)
    }
  }

  buffer += decoder.decode()
  if (buffer.trim().length > 0) {
    consumeSseChunk(buffer)
  }

  const payload = completedResponse ?? {}
  const reply = doneText || extractResponseText(payload) || deltaText

  return { payload, reply, usage: latestUsage }
}

async function readCodexCompatibleBody(response: Response) {
  const bodyText = await response.text().catch(() => "")
  const parsedPayload = tryParseJsonText(bodyText)
  if (parsedPayload !== undefined) {
    const usage = normalizeUsage(parsedPayload)
    return {
      payload: parsedPayload,
      reply: extractResponseText(parsedPayload),
      usage: hasUsageDelta(usage) ? usage : emptyUsageMetrics(),
    }
  }

  const contentType = response.headers.get("content-type") ?? ""
  const looksLikeSse = isEventStreamContentType(contentType) || /^\s*data:/m.test(bodyText) || bodyText.includes("[DONE]")
  if (!looksLikeSse) {
    return {
      payload: {},
      reply: "",
      usage: emptyUsageMetrics(),
    }
  }

  const streamResponse = new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  return readCodexStream(streamResponse)
}

function extractResponseText(payload: unknown): string {
  const data = payload as {
    output_text?: string
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
  }
  if (typeof data.output_text === "string" && data.output_text.trim().length > 0) return data.output_text
  if (Array.isArray(data.output)) {
    const texts: string[] = []
    for (const part of data.output) {
      for (const content of part.content ?? []) {
        if (typeof content.text === "string" && content.text.length > 0) texts.push(content.text)
      }
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return ""
}

function makeStatusError(statusCode: number, message: string) {
  const error = new Error(message) as Error & { statusCode?: number }
  error.statusCode = statusCode
  return error
}

async function readRequestBodyBytesWithLimit(request: Request, options?: { maxBytes?: number }) {
  const maxBytes = Math.max(1, Math.floor(options?.maxBytes ?? PROXY_MAX_REQUEST_BODY_BYTES))
  const declaredLength = parseHeaderNumber(request.headers.get("content-length"))
  if (declaredLength > maxBytes) {
    throw makeStatusError(413, `Request body is too large (${declaredLength} bytes, limit ${maxBytes} bytes)`)
  }

  const body = request.body
  if (!body) return undefined

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // ignore cancellation errors
        }
        throw makeStatusError(413, `Request body is too large (limit ${maxBytes} bytes)`)
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore release errors
    }
  }

  if (total <= 0) return undefined
  if (chunks.length === 1) return chunks[0]
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

async function readResponsePreviewText(response: Response, maxBytes = 8192) {
  const clone = response.clone()
  const reader = clone.body?.getReader()
  if (!reader) {
    return (await clone.text().catch(() => "")).slice(0, maxBytes)
  }
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const slice = value.byteLength > maxBytes - total ? value.slice(0, maxBytes - total) : value
      text += decoder.decode(slice, { stream: total + slice.byteLength < maxBytes })
      total += slice.byteLength
      if (slice.byteLength < value.byteLength) break
    }
    if (total >= maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // ignore cancellation errors
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore release errors
    }
  }
  return text
}

function hasUsageDelta(usage: UsageMetrics) {
  return (
    usage.totalTokens > 0 ||
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.reasoningOutputTokens > 0 ||
    usage.estimatedCostUsd !== null ||
    Boolean(usage.reasoningEffort)
  )
}

function hasLegacyUsageDelta(usage: UsageMetrics) {
  return usage.totalTokens > 0 || usage.promptTokens > 0 || usage.completionTokens > 0
}

function accumulateExtendedUsageTotals(usage: UsageMetrics, now = Date.now()) {
  if (
    usage.cachedInputTokens === 0 &&
    usage.reasoningOutputTokens === 0 &&
    usage.estimatedCostUsd === null
  ) {
    return
  }
  extendedUsageTotalsState.cachedInputTokens += usage.cachedInputTokens
  extendedUsageTotalsState.reasoningOutputTokens += usage.reasoningOutputTokens
  extendedUsageTotalsState.estimatedCostUsd += usage.estimatedCostUsd ?? 0
  if (usage.totalTokens > 0 && usage.estimatedCostUsd !== null) {
    extendedUsageTotalsState.pricedTokens += usage.totalTokens
  }
  extendedUsageTotalsState.updatedAt = now
}

function getUsageTotalsSnapshot() {
  const raw = asRecord(accountStore.getUsageTotals()) ?? {}
  const hasCached =
    hasOwnKey(raw, "cachedInputTokens") ||
    hasOwnKey(raw, "cached_input_tokens") ||
    hasOwnKey(raw, "cachedTokens") ||
    hasOwnKey(raw, "cached_tokens")
  const hasReasoning =
    hasOwnKey(raw, "reasoningOutputTokens") ||
    hasOwnKey(raw, "reasoning_output_tokens") ||
    hasOwnKey(raw, "reasoningTokens") ||
    hasOwnKey(raw, "reasoning_tokens")
  const hasCost =
    hasOwnKey(raw, "estimatedCostUsd") ||
    hasOwnKey(raw, "estimated_cost_usd") ||
    hasOwnKey(raw, "costUsd") ||
    hasOwnKey(raw, "cost_usd")
  const promptTokens = normalizeNonNegativeInt(pickFirstDefinedValue(raw.promptTokens, raw.prompt_tokens))
  const completionTokens = normalizeNonNegativeInt(pickFirstDefinedValue(raw.completionTokens, raw.completion_tokens))
  const totalTokens = normalizeNonNegativeInt(pickFirstDefinedValue(raw.totalTokens, raw.total_tokens))
  const cachedInputTokens = hasCached
    ? normalizeNonNegativeInt(
        pickFirstDefinedValue(raw.cachedInputTokens, raw.cached_input_tokens, raw.cachedTokens, raw.cached_tokens),
      )
    : extendedUsageTotalsState.cachedInputTokens
  const reasoningOutputTokens = hasReasoning
    ? normalizeNonNegativeInt(
        pickFirstDefinedValue(
          raw.reasoningOutputTokens,
          raw.reasoning_output_tokens,
          raw.reasoningTokens,
          raw.reasoning_tokens,
        ),
      )
    : extendedUsageTotalsState.reasoningOutputTokens
  const estimatedCostUsd = hasCost
    ? normalizeNullableNonNegativeNumber(
        pickFirstDefinedValue(raw.estimatedCostUsd, raw.estimated_cost_usd, raw.costUsd, raw.cost_usd),
      ) ?? 0
    : extendedUsageTotalsState.estimatedCostUsd
  const costProjection = buildUsageCostProjection({
    totalTokens,
    pricedTokens: extendedUsageTotalsState.pricedTokens,
    estimatedCostUsd,
  })

  return {
    ...raw,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    estimatedCostUsd,
    pricedTokens: costProjection.pricedTokens,
    estimatedCostCoverageRatio: costProjection.estimatedCostCoverageRatio,
    estimatedCostFromTotalTokensUsd: costProjection.estimatedCostFromTotalTokensUsd,
    updatedAt: Math.max(
      normalizeNonNegativeInt(pickFirstDefinedValue(raw.updatedAt, raw.updated_at)),
      extendedUsageTotalsState.updatedAt,
    ),
  }
}

function emitServerEvent(event: string, payload: Record<string, unknown>) {
  const body = usageEventEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  for (const [id, client] of usageEventClients.entries()) {
    try {
      client.controller.enqueue(body)
    } catch {
      clearInterval(client.heartbeat)
      usageEventClients.delete(id)
    }
  }
}

function emitUsageUpdated(input: { accountId: string; keyId?: string; usage: UsageMetrics; source: string }) {
  if (!hasUsageDelta(input.usage)) return
  const usageTotals = getUsageTotalsSnapshot()
  const payload = {
    type: "usage-updated",
    at: Date.now(),
    source: input.source,
    accountId: input.accountId,
    keyId: input.keyId ?? null,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    cachedInputTokens: input.usage.cachedInputTokens,
    reasoningOutputTokens: input.usage.reasoningOutputTokens,
    estimatedCostUsd: input.usage.estimatedCostUsd,
    reasoningEffort: input.usage.reasoningEffort,
    usageTotals,
  }
  emitServerEvent("usage", payload)
}

function recordUsageMetrics(input: {
  accountId: string
  keyId?: string
  usage: UsageMetrics
  source: string
  auditId?: string
  providerId?: string | null
  virtualKeyId?: string | null
  model?: string | null
  sessionId?: string | null
  reasoningEffort?: string | null
}) {
  const usage = withEstimatedUsageCost(input.usage, input.model ?? null)
  if (!hasUsageDelta(usage)) return

  if (hasLegacyUsageDelta(usage)) {
    const shouldPersistExtendedUsageWithAccount = !input.auditId
    accountStore.addUsage({
      id: input.accountId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedInputTokens: shouldPersistExtendedUsageWithAccount ? usage.cachedInputTokens : 0,
      reasoningOutputTokens: shouldPersistExtendedUsageWithAccount ? usage.reasoningOutputTokens : 0,
      estimatedCostUsd: shouldPersistExtendedUsageWithAccount ? usage.estimatedCostUsd : null,
      reasoningEffort: input.reasoningEffort ?? usage.reasoningEffort ?? null,
    } as any)
    if (input.keyId) {
      accountStore.addVirtualKeyUsage({
        id: input.keyId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cachedInputTokens: usage.cachedInputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
        reasoningEffort: input.reasoningEffort ?? usage.reasoningEffort ?? null,
      } as any)
    }
  }

  accumulateExtendedUsageTotals(usage)

  if (input.auditId) {
    updateRequestAuditUsageCompat({
      auditId: input.auditId,
      accountId: input.accountId,
      providerId: input.providerId ?? null,
      virtualKeyId: input.virtualKeyId ?? input.keyId ?? null,
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      reasoningEffort: input.reasoningEffort ?? usage.reasoningEffort ?? null,
      usage,
    })
  }

  emitUsageUpdated({
    accountId: input.accountId,
    keyId: input.keyId,
    usage: {
      ...usage,
      reasoningEffort: input.reasoningEffort ?? usage.reasoningEffort ?? null,
    },
    source: input.source,
  })
}

function logBackgroundError(label: string, error: unknown) {
  console.error(`[oauth-multi-login] background task failed (${label})`, error)
}

function handleBackgroundPromise(label: string, promise: Promise<unknown>) {
  promise.catch((error) => logBackgroundError(label, error))
}

function emitAccountRateLimitsUpdated(input: { accountId: string; source: string; quota: AccountQuotaSnapshot }) {
  const derived = resolvePublicAccountDerivedState(input.accountId, input.quota)
  emitServerEvent("account-rate-limits-updated", {
    type: "account-rate-limits-updated",
    at: Date.now(),
    source: input.source,
    accountId: input.accountId,
    quota: input.quota,
    routing: derived.routing,
    abnormalState: derived.abnormalState,
  })
}

function toPublicAccountHealth(accountId: string) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return null
  const snapshot = getActiveAccountHealthSnapshot(accountHealthCache, normalizedAccountId, normalizeIdentity)
  if (!snapshot) return null
  return {
    ...snapshot,
    routingExcluded: true,
  }
}

function resolveAccountAbnormalStateLegacy(input: {
  health: PublicAccountHealthSnapshot | null
  routing: AccountRoutingState
  quota?: AccountQuotaSnapshot | null
}): any {
  const routingReason = String(input.routing.reason ?? "").trim()
  if (routingReason === "quota_exhausted_cooldown" || routingReason === "quota_headroom_exhausted") {
    return {
      category: "quota_exhausted",
      label: "已耗尽额度",
      reason: routingReason,
      source: "quota",
      detectedAt: input.quota?.fetchedAt ?? null,
      expiresAt: null,
      confidence: "high",
      deleteEligible: false,
    }
  }
  if (routingReason === "quota_headroom_low") {
    return {
      category: "soft_drained",
      label: "额度低",
      reason: routingReason,
      source: "quota",
      detectedAt: input.quota?.fetchedAt ?? null,
      expiresAt: null,
      confidence: "medium",
      deleteEligible: false,
    }
  }

  const health = input.health
  if (!health) return null
  const reason = String(health.reason ?? "").trim() || "unknown"
  if (reason === "account_deactivated" || reason === "workspace_deactivated") {
    return {
      category: "banned",
      label: "已封禁",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "high",
      deleteEligible: true,
    }
  }
  if (reason === "upstream_banned" || reason === "upstream_forbidden") {
    return {
      category: "access_banned",
      label: "访问被封",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "medium",
      deleteEligible: true,
    }
  }
  if (reason === "login_required" || reason === "upstream_unauthorized" || reason.startsWith("refresh_")) {
    return {
      category: "auth_invalid",
      label: "需重新登录",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "high",
      deleteEligible: false,
    }
  }
  if (reason === "upstream_transport_error" || /^upstream_http_\d+$/.test(reason)) {
    return {
      category: "transient",
      label: "暂时异常",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "medium",
      deleteEligible: false,
    }
  }
  if (reason === "upstream_certificate_verification_error") {
    return {
      category: "transient",
      label: "证书异常",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "high",
      deleteEligible: false,
    }
  }
  return {
    category: "unknown",
    label: "异常",
    reason,
    source: health.source ?? null,
    detectedAt: health.updatedAt ?? null,
    expiresAt: health.expiresAt,
    confidence: "medium",
    deleteEligible: false,
  }
}

function buildAccountAbnormalState(input: {
  classification: AccountAbnormalCategory
  label: string
  reason: string
  source: string | null
  detectedAt: number | null
  expiresAt: number | null
  confidence: "high" | "medium" | "low"
  deleteEligible: boolean
}): AccountAbnormalState {
  return {
    classification: input.classification,
    category: input.classification,
    label: input.label,
    reason: input.reason,
    source: input.source,
    detectedAt: input.detectedAt,
    expiresAt: input.expiresAt,
    confidence: input.confidence,
    deleteEligible: input.deleteEligible,
  }
}

function resolveAccountAbnormalState(input: {
  health: PublicAccountHealthSnapshot | null
  routing: AccountRoutingState
  quota?: AccountQuotaSnapshot | null
}): AccountAbnormalState | null {
  const routingReason = String(input.routing.reason ?? "").trim()
  const quota = input.quota ?? null
  const quotaError = String(quota?.error ?? "").trim()
  if (routingReason === "quota_exhausted_cooldown" || routingReason === "quota_headroom_exhausted") {
    return buildAccountAbnormalState({
      classification: "quota_exhausted",
      label: "已耗尽额度",
      reason: routingReason,
      source: "quota",
      detectedAt: input.quota?.fetchedAt ?? null,
      expiresAt: null,
      confidence: "high",
      deleteEligible: false,
    })
  }
  if (routingReason === "quota_headroom_low") {
    return buildAccountAbnormalState({
      classification: "soft_drained",
      label: "额度低",
      reason: routingReason,
      source: "quota",
      detectedAt: input.quota?.fetchedAt ?? null,
      expiresAt: null,
      confidence: "medium",
      deleteEligible: false,
    })
  }
  if (routingReason === "pool_consistency_excluded") {
    return buildAccountAbnormalState({
      classification: "unknown",
      label: "暂不参与路由",
      reason: routingReason,
      source: "routing",
      detectedAt: null,
      expiresAt: null,
      confidence: "low",
      deleteEligible: false,
    })
  }
  if (routingReason === "routing_excluded") {
    return buildAccountAbnormalState({
      classification: "unknown",
      label: "当前不可用",
      reason: routingReason,
      source: "routing",
      detectedAt: null,
      expiresAt: null,
      confidence: "low",
      deleteEligible: false,
    })
  }

  const health = input.health
  if (!health) {
    if (quota?.status === "error") {
      return buildAccountAbnormalState({
        classification: "unknown",
        label: "额度获取失败",
        reason: quotaError || "quota_fetch_failed",
        source: "quota",
        detectedAt: quota?.fetchedAt ?? null,
        expiresAt: null,
        confidence: "medium",
        deleteEligible: false,
      })
    }
    return null
  }

  const reason = String(health.reason ?? "").trim() || "unknown"
  if (reason === "account_deactivated" || reason === "workspace_deactivated") {
    return buildAccountAbnormalState({
      classification: "banned",
      label: "已封禁",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "high",
      deleteEligible: true,
    })
  }
  if (reason === "upstream_banned" || reason === "upstream_forbidden") {
    return buildAccountAbnormalState({
      classification: "access_banned",
      label: "访问被封",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "high",
      deleteEligible: true,
    })
  }
  if (
    reason === "login_required" ||
    reason === "upstream_unauthorized" ||
    reason === "upstream_auth_error" ||
    reason.startsWith("refresh_")
  ) {
    return buildAccountAbnormalState({
      classification: "auth_invalid",
      label: "需重新登录",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "high",
      deleteEligible: false,
    })
  }
  if ((reason === "account_unhealthy" || reason === "unknown") && quota?.status === "error") {
    return buildAccountAbnormalState({
      classification: "unknown",
      label: "额度获取失败",
      reason: quotaError || reason,
      source: "quota",
      detectedAt: health.updatedAt ?? quota?.fetchedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "medium",
      deleteEligible: false,
    })
  }
  if (reason === "account_unhealthy") {
    return buildAccountAbnormalState({
      classification: "transient",
      label: "账号异常",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "medium",
      deleteEligible: false,
    })
  }
  if (reason === "upstream_certificate_verification_error") {
    return buildAccountAbnormalState({
      classification: "transient",
      label: "证书异常",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "high",
      deleteEligible: false,
    })
  }
  if (reason === "upstream_transport_error" || /^upstream_http_\d+$/.test(reason)) {
    return buildAccountAbnormalState({
      classification: "transient",
      label: "暂时异常",
      reason,
      source: health.source ?? null,
      detectedAt: health.updatedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "medium",
      deleteEligible: false,
    })
  }
  if (quota?.status === "error") {
    return buildAccountAbnormalState({
      classification: "unknown",
      label: "额度获取失败",
      reason: quotaError || reason,
      source: "quota",
      detectedAt: health.updatedAt ?? quota?.fetchedAt ?? null,
      expiresAt: health.expiresAt,
      confidence: "medium",
      deleteEligible: false,
    })
  }

  return buildAccountAbnormalState({
    classification: "unknown",
    label: "异常",
    reason,
    source: health.source ?? null,
    detectedAt: health.updatedAt ?? null,
    expiresAt: health.expiresAt,
    confidence: "low",
    deleteEligible: false,
  })
}

function resolvePublicAccountDerivedState(accountId: string, quota?: AccountQuotaSnapshot | null) {
  const health = toPublicAccountHealth(accountId)
  const routing = resolveAccountRoutingState(accountId, quota)
  const abnormalState = resolveAccountAbnormalState({
    health,
    routing,
    quota: quota ?? null,
  })
  return {
    health,
    routing,
    abnormalState,
  }
}

const { resolveAutomaticAccountAvailability, ensureAutomaticAccountAvailable } =
  createAutomaticAccountAvailabilityResolver({
    getQuotaSnapshot: (account) => accountQuotaCache.get(account.id) ?? null,
    resolveDerivedState: (accountId, quota) => resolvePublicAccountDerivedState(accountId, quota),
    makeStatusError,
  })

function emitAccountHealthUpdated(input: { accountId: string; source: string }) {
  const normalizedAccountId = normalizeIdentity(input.accountId)
  if (!normalizedAccountId) return
  const derived = resolvePublicAccountDerivedState(normalizedAccountId, accountQuotaCache.get(normalizedAccountId) ?? null)
  emitServerEvent("account-health-updated", {
    type: "account-health-updated",
    at: Date.now(),
    source: input.source,
    accountId: normalizedAccountId,
    health: derived.health,
    routing: derived.routing,
    abnormalState: derived.abnormalState,
  })
}

function markAccountUnhealthy(accountId: string, reason: string, source: string) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return
  const normalizedReason = normalizeAccountHealthReason(reason)
  const now = Date.now()
  const expiresAt = resolveAccountHealthExpiry(normalizedReason, ACCOUNT_TRANSIENT_HEALTH_COOLDOWN_MS, now)
  const current = getActiveAccountHealthSnapshot(accountHealthCache, normalizedAccountId, normalizeIdentity, now)
  if (
    current &&
    current.reason === normalizedReason &&
    current.source === source &&
    current.expiresAt === null &&
    expiresAt === null
  ) {
    return
  }
  accountHealthCache.set(normalizedAccountId, {
    status: "error",
    reason: normalizedReason,
    source,
    updatedAt: now,
    expiresAt,
  })
  const account = accountStore.get(normalizedAccountId)
  if (account) invalidatePoolConsistency(account.providerId, { account })
  emitAccountHealthUpdated({
    accountId: normalizedAccountId,
    source,
  })
}

function markAccountHealthy(accountId: string, source: string) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return
  const current = getActiveAccountHealthSnapshot(accountHealthCache, normalizedAccountId, normalizeIdentity)
  if (!current) return
  if (isStickyAccountHealthSnapshot(current) && !canClearStickyAccountHealth(current, source)) {
    return
  }
  const deleted = accountHealthCache.delete(normalizedAccountId)
  if (!deleted) return
  const account = accountStore.get(normalizedAccountId)
  if (account) invalidatePoolConsistency(account.providerId, { account })
  emitAccountHealthUpdated({
    accountId: normalizedAccountId,
    source,
  })
}

async function refreshAndEmitAccountQuota(accountID: string, source: string) {
  const normalizedAccountID = String(accountID ?? "").trim()
  if (!normalizedAccountID) return
  if (accountQuotaRefreshInFlight.has(normalizedAccountID)) return

  accountQuotaRefreshInFlight.add(normalizedAccountID)
  try {
    const account = accountStore.get(normalizedAccountID)
    if (!account) return
    await refreshAccountQuotaCache([account], {
      force: true,
      targetAccountID: normalizedAccountID,
    })
    const quota = accountQuotaCache.get(normalizedAccountID)
    if (quota) {
      emitAccountRateLimitsUpdated({
        accountId: normalizedAccountID,
        source,
        quota,
      })
    }
  } catch (error) {
    logBackgroundError(`refreshAndEmitAccountQuota:${source}:${normalizedAccountID}`, error)
  } finally {
    accountQuotaRefreshInFlight.delete(normalizedAccountID)
  }
}

async function pollAndEmitAccountQuota(source: string) {
  if (accountQuotaPollInFlight) return
  const accounts = accountStore
    .list()
    .filter((account) => account.providerId === "chatgpt")
    .sort((left, right) => {
      const cohortPriorityDelta =
        resolvePlanCohortPriority(resolveAccountPlanCohort(left)) -
        resolvePlanCohortPriority(resolveAccountPlanCohort(right))
      if (cohortPriorityDelta !== 0) return cohortPriorityDelta
      const leftFetchedAt = Number(accountQuotaCache.get(left.id)?.fetchedAt || 0)
      const rightFetchedAt = Number(accountQuotaCache.get(right.id)?.fetchedAt || 0)
      if (leftFetchedAt !== rightFetchedAt) return leftFetchedAt - rightFetchedAt
      return left.id.localeCompare(right.id)
    })
  if (accounts.length === 0) return
  const batchSize = Math.max(1, Math.min(ACCOUNT_QUOTA_POLL_BATCH_SIZE, accounts.length))
  const startIndex = accountQuotaPollCursor % accounts.length
  const polledAccounts =
    batchSize >= accounts.length
      ? accounts
      : [...accounts.slice(startIndex, startIndex + batchSize), ...accounts.slice(0, Math.max(0, startIndex + batchSize - accounts.length))]
  accountQuotaPollCursor = (startIndex + batchSize) % accounts.length

  accountQuotaPollInFlight = true
  try {
    await refreshAccountQuotaCache(polledAccounts, { force: true })
    for (const account of polledAccounts) {
      const quota = accountQuotaCache.get(account.id)
      if (!quota) continue
      emitAccountRateLimitsUpdated({
        accountId: account.id,
        source,
        quota,
      })
    }
  } catch (error) {
    logBackgroundError(`pollAndEmitAccountQuota:${source}`, error)
  } finally {
    accountQuotaPollInFlight = false
  }
}

function getBootstrapLogState() {
  try {
    if (!existsSync(AppConfig.bootstrapLogFile)) return "missing"
    const stat = statSync(AppConfig.bootstrapLogFile)
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`
  } catch {
    return "unavailable"
  }
}

function notifyHealth() {
  emitServerEvent("health", {
    type: "health",
    at: Date.now(),
    ok: true,
    name: AppConfig.name,
  })
}

function startServerEventHooks() {
  loginSessions.subscribe((session) => {
    emitServerEvent("login-session", {
      type: "login-session",
      at: Date.now(),
      session,
    })
    if (session.status === "completed" && session.accountId) {
      const account = accountStore.get(session.accountId)
      if (account) {
        invalidatePoolConsistency(account.providerId, { account })
      }
      handleBackgroundPromise(
        "refreshAndEmitAccountQuota:login-session",
        refreshAndEmitAccountQuota(session.accountId, "login-session"),
      )
    }
  })

  bootstrapLogState = getBootstrapLogState()
  const bootstrapTimer = setInterval(() => {
    const nextState = getBootstrapLogState()
    if (nextState === bootstrapLogState) return
    bootstrapLogState = nextState
    emitServerEvent("bootstrap-updated", {
      type: "bootstrap-updated",
      at: Date.now(),
    })
  }, 1500)
  bootstrapTimer.unref?.()

  const healthTimer = setInterval(() => {
    notifyHealth()
  }, 5000)
  healthTimer.unref?.()

  const quotaTimer = setInterval(() => {
    handleBackgroundPromise("pollAndEmitAccountQuota:quota-poll", pollAndEmitAccountQuota("quota-poll"))
  }, ACCOUNT_QUOTA_POLL_INTERVAL_MS)
  quotaTimer.unref?.()
}

function normalizeIdentity(value?: string | null) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : undefined
}

type JwtAuthClaims = {
  chatgpt_account_id?: string
  chatgpt_plan_type?: string
  chatgpt_user_id?: string
  user_id?: string
  organization_id?: string
  project_id?: string
  completed_platform_onboarding?: boolean
  is_org_owner?: boolean
}

function parseJwtPayload(token?: string | null) {
  const value = String(token ?? "").trim()
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 3) return null

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function parseJwtAuthClaims(token?: string | null): JwtAuthClaims | null {
  const payload = parseJwtPayload(token)
  if (!payload) return null

  try {
    const auth = payload["https://api.openai.com/auth"]
    if (!auth || typeof auth !== "object") return null
    return auth as JwtAuthClaims
  } catch {
    return null
  }
}

function asObjectRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const OAUTH_BRIDGE_VIRTUAL_KEY_ID_PREFIX = "codex-oauth-bridge:"

function normalizeLowerIdentity(value?: string | null) {
  return normalizeIdentity(value)?.toLowerCase()
}

function resolveChatgptBearerIdentity(token: string) {
  const payload = parseJwtPayload(token)
  const auth = asObjectRecord(payload?.["https://api.openai.com/auth"])
  const profile = asObjectRecord(payload?.["https://api.openai.com/profile"])
  return {
    accountId:
      normalizeIdentity(String(auth?.chatgpt_account_id ?? "")) ||
      normalizeIdentity(String(auth?.account_id ?? "")) ||
      normalizeIdentity(String(auth?.organization_id ?? "")),
    userId:
      normalizeIdentity(String(auth?.chatgpt_user_id ?? "")) ||
      normalizeIdentity(String(auth?.user_id ?? "")) ||
      normalizeIdentity(String(payload?.sub ?? "")),
    email:
      normalizeLowerIdentity(String(profile?.email ?? "")) ||
      normalizeLowerIdentity(String(payload?.email ?? "")),
  }
}

function accountMetadataRecord(account: StoredAccount) {
  return account.metadata && typeof account.metadata === "object" ? (account.metadata as Record<string, unknown>) : {}
}

function storedAccountMatchesChatgptBearer(input: {
  account: StoredAccount
  token: string
  accountId?: string
  userId?: string
  email?: string
  requestedModel?: string | null
}) {
  const { account, token, accountId, userId, email, requestedModel } = input
  if (!account.accessToken) return null
  if (!accountCanUseRequestedModel(account, requestedModel)) return null

  const metadata = accountMetadataRecord(account)
  let score = 0
  if (normalizeIdentity(account.accessToken) === token) score += 10000
  if (normalizeIdentity(account.idToken) === token) score += 9000

  const accountIds = [
    account.accountId,
    metadata.chatgptAccountId,
    metadata.chatgpt_account_id,
    metadata.organizationId,
    metadata.organization_id,
  ]
    .map((value) => normalizeIdentity(String(value ?? "")))
    .filter(Boolean)
  if (accountId && accountIds.includes(accountId)) score += 1000

  const userIds = [metadata.chatgptUserId, metadata.chatgpt_user_id, metadata.userId, metadata.user_id]
    .map((value) => normalizeIdentity(String(value ?? "")))
    .filter(Boolean)
  if (userId && userIds.includes(userId)) score += 500

  const emails = [account.email, metadata.email]
    .map((value) => normalizeLowerIdentity(String(value ?? "")))
    .filter(Boolean)
  if (email && emails.includes(email)) score += 250

  if (score <= 0) return null
  if (resolveAccountPlanCohort(account) === "paid") score += 50
  if (account.isActive !== false) score += 10
  return score
}

function resolveStoredAccountFromChatgptBearer(token: string, requestedModel?: string | null) {
  const normalizedToken = normalizeIdentity(token)
  if (!normalizedToken || normalizedToken.startsWith("ocsk_")) return null

  const identity = resolveChatgptBearerIdentity(normalizedToken)
  const candidates = accountStore
    .list()
    .map((account) => {
      const score = storedAccountMatchesChatgptBearer({
        account,
        token: normalizedToken,
        accountId: identity.accountId,
        userId: identity.userId,
        email: identity.email,
        requestedModel,
      })
      return score === null ? null : { account, score }
    })
    .filter(Boolean) as Array<{ account: StoredAccount; score: number }>

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return Number(right.account.updatedAt ?? 0) - Number(left.account.updatedAt ?? 0)
  })
  return candidates[0]?.account ?? null
}

function resolveVirtualApiKeyFromCodexOAuthBridge(
  token: string,
  sessionId?: string | null,
  requestedModel?: string | null,
) {
  const normalizedToken = normalizeIdentity(token)
  if (!normalizedToken || normalizedToken.startsWith("ocsk_")) return null
  const keys = buildCodexOAuthBridgeBindingKeys({ accessToken: normalizedToken })
  for (const key of keys) {
    const binding = runtimeSettings.codexOAuthBridgeBindings?.[key]
    if (!binding?.virtualKeyId) continue
    const resolved = accountStore.resolveVirtualApiKeyByID(binding.virtualKeyId, {
      sessionId,
      routeOptionsFactory: (virtualKey) =>
        virtualKey.routingMode === "pool"
          ? buildProviderRoutingHintsForVirtualKey(virtualKey, requestedModel)
          : undefined,
    })
    if (resolved) return resolved
    const relaxed = accountStore.resolveVirtualApiKeyByID(binding.virtualKeyId, {
      sessionId,
      routeOptionsFactory: (virtualKey) =>
        virtualKey.routingMode === "pool"
          ? buildRelaxedProviderRoutingHintsForVirtualKey(virtualKey, requestedModel)
          : undefined,
    })
    if (relaxed) return relaxed
    if (resolveRequestedModelPlanCohort(requestedModel)) {
      const fallback = accountStore.resolveVirtualApiKeyByID(binding.virtualKeyId, {
        sessionId,
        routeOptionsFactory: (virtualKey) =>
          virtualKey.routingMode === "pool" ? buildRelaxedProviderRoutingHintsForVirtualKey(virtualKey, requestedModel) : undefined,
      })
      if (fallback) return fallback
    }
  }
  return null
}

function buildOAuthBridgeVirtualKey(account: StoredAccount): VirtualApiKeyRecord {
  const now = Date.now()
  return {
    id: `${OAUTH_BRIDGE_VIRTUAL_KEY_ID_PREFIX}${account.id}`,
    accountId: account.id,
    providerId: account.providerId,
    routingMode: "single",
    accountScope: "all",
    clientMode: "codex",
    wireApi: "responses",
    name: "Codex OAuth Bridge",
    fixedModel: null,
    fixedReasoningEffort: null,
    keyPrefix: "oauth",
    isRevoked: false,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    expiresAt: null,
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

function resolveDefaultOrganizationIdFromAuthRecord(value: unknown) {
  const auth = asObjectRecord(value)
  if (!auth) return undefined
  const direct = normalizeIdentity(String(auth.organization_id ?? ""))
  if (direct) return direct
  const organizations = Array.isArray(auth.organizations) ? auth.organizations : []
  for (const item of organizations) {
    const record = asObjectRecord(item)
    if (!record) continue
    if (record.is_default === true) {
      const id = normalizeIdentity(String(record.id ?? ""))
      if (id) return id
    }
  }
  for (const item of organizations) {
    const record = asObjectRecord(item)
    if (!record) continue
    const id = normalizeIdentity(String(record.id ?? ""))
    if (id) return id
  }
  return undefined
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

function parseImportedJsonExpiresAt(value: unknown) {
  const numeric = asFiniteNumber(value)
  if (numeric !== null) return toEpochMs(numeric) ?? undefined
  const normalized = normalizeImportedJsonString(value)
  if (!normalized) return undefined
  const parsedNumeric = asFiniteNumber(normalized)
  if (parsedNumeric !== null) return toEpochMs(parsedNumeric) ?? undefined
  const parsedDate = Date.parse(normalized)
  return Number.isFinite(parsedDate) ? Math.floor(parsedDate) : undefined
}

function buildProviderQuotaRoutingHints(providerId: string, now = Date.now()) {
  const normalizedProviderId = normalizeIdentity(providerId)?.toLowerCase()
  const headroomByAccountId = new Map<string, number>()
  const excludeAccountIds: string[] = []
  const deprioritizedAccountIds: string[] = []
  if (!normalizedProviderId) {
    return {
      excludeAccountIds,
      deprioritizedAccountIds,
      headroomByAccountId,
    }
  }

  for (const account of accountStore.list()) {
    if (account.providerId.toLowerCase() !== normalizedProviderId) continue
    const headroom = resolveQuotaSnapshotHeadroomPercent(accountQuotaCache.get(account.id), now)
    if (!Number.isFinite(headroom)) continue
    headroomByAccountId.set(account.id, Number(headroom))
    if (Number(headroom) <= 0) {
      excludeAccountIds.push(account.id)
      continue
    }
    if (Number(headroom) <= ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD) {
      deprioritizedAccountIds.push(account.id)
    }
  }

  return {
    excludeAccountIds,
    deprioritizedAccountIds,
    headroomByAccountId,
  }
}

function buildProviderPressureRoutingHints(providerId: string, now = Date.now()) {
  const normalizedProviderId = normalizeIdentity(providerId)?.toLowerCase()
  const pressureScoreByAccountId = new Map<string, number>()
  if (!normalizedProviderId) {
    return {
      pressureScoreByAccountId,
    }
  }

  const cached = providerPressureHintsCache.get(normalizedProviderId)
  if (cached && now - cached.generatedAt <= PROVIDER_PRESSURE_HINTS_TTL_MS) {
    return {
      pressureScoreByAccountId: new Map(cached.pressureScoreByAccountId),
    }
  }

  for (const account of accountStore.list()) {
    if (account.providerId.toLowerCase() !== normalizedProviderId) continue
    const pressure = behaviorController.inspect({
      accountId: account.id,
      now,
    })
    pressureScoreByAccountId.set(account.id, pressure.pressureScore)
  }

  providerPressureHintsCache.set(normalizedProviderId, {
    generatedAt: now,
    pressureScoreByAccountId: new Map(pressureScoreByAccountId),
  })

  return {
    pressureScoreByAccountId,
  }
}

function buildProviderRoutingHints(
  providerId: string,
  now = Date.now(),
  options?: ProviderRoutingHintsOptions,
): ProviderRoutingHints {
  const quotaHints = buildProviderQuotaRoutingHints(providerId, now)
  const pressureHints = buildProviderPressureRoutingHints(providerId, now)
  const cooldownExcludedAccountIds = collectProviderQuotaExhaustedExclusions(providerId, now)
  const baseInput = {
    providerId,
    accounts: accountStore.list(),
    headroomByAccountId: quotaHints.headroomByAccountId,
    pressureScoreByAccountId: pressureHints.pressureScoreByAccountId,
    quotaExcludedAccountIds: [...quotaHints.excludeAccountIds, ...cooldownExcludedAccountIds],
    unhealthyExcludedAccountIds: collectProviderUnhealthyExclusions(providerId, {
      includeTransient: options?.allowTransientUnhealthy !== true,
    }),
    deprioritizedAccountIds: quotaHints.deprioritizedAccountIds,
    preferredPlanCohort: options?.preferredPlanCohort ?? null,
    allowedPlanCohorts: options?.allowedPlanCohorts ?? null,
    cohortMode: options?.cohortMode ?? "prefer",
  }
  const baseHints = buildProviderRoutingHintsFromState(baseInput)
  const consistencyExcludedAccountIds = collectProviderConsistencyExclusions(providerId, now, {
    preferredPlanCohort: options?.cohortMode === "off" ? null : baseHints.preferredPlanCohort,
  })
  return buildProviderRoutingHintsFromState({
    ...baseInput,
    preferredPlanCohort: baseHints.preferredPlanCohort,
    consistencyExcludedAccountIds,
  })
}

function buildRelaxedProviderRoutingHints(
  providerId: string,
  now = Date.now(),
  options?: ProviderRoutingHintsOptions,
) {
  const quotaHints = buildProviderQuotaRoutingHints(providerId, now)
  const pressureHints = buildProviderPressureRoutingHints(providerId, now)
  const cooldownExcludedAccountIds = collectProviderQuotaExhaustedExclusions(providerId, now)
  return buildRelaxedProviderRoutingHintsFromState({
    providerId,
    accounts: accountStore.list(),
    headroomByAccountId: quotaHints.headroomByAccountId,
    pressureScoreByAccountId: pressureHints.pressureScoreByAccountId,
    quotaExcludedAccountIds: [...quotaHints.excludeAccountIds, ...cooldownExcludedAccountIds],
    unhealthyExcludedAccountIds: collectProviderUnhealthyExclusions(providerId, {
      includeTransient: options?.allowTransientUnhealthy !== true,
    }),
    consistencyExcludedAccountIds: collectProviderConsistencyExclusions(providerId, now, {
      preferredPlanCohort: null,
    }),
    deprioritizedAccountIds: quotaHints.deprioritizedAccountIds,
    preferredPlanCohort: options?.preferredPlanCohort ?? null,
    allowedPlanCohorts: options?.allowedPlanCohorts ?? null,
  })
}

function modelPrefersBusinessChatgptAccount(model?: string | null) {
  const normalized = extractModelID(model)?.toLowerCase()
  return Boolean(normalized && (normalized === "gpt-5.5" || normalized.startsWith("gpt-5.5-")))
}

function resolveRequestedModelPlanCohort(model?: string | null): AccountPlanCohort | null {
  return modelPrefersBusinessChatgptAccount(model) ? "business" : null
}

function normalizeAllowedPlanCohorts(value?: Iterable<AccountPlanCohort> | null): AccountPlanCohort[] | null {
  if (!value) return null
  const cohorts = [...new Set([...value].filter(Boolean))]
  return cohorts.length > 0 ? cohorts : null
}

function allowedPlanCohortsInclude(cohorts: AccountPlanCohort[] | null | undefined, cohort?: AccountPlanCohort | null) {
  return !cohorts || !cohort || cohorts.includes(cohort)
}

function resolveVirtualKeyAllowedPlanCohorts(key?: { accountScope?: VirtualApiKeyRecord["accountScope"] | null } | null): AccountPlanCohort[] | null {
  const scope = key?.accountScope ?? "all"
  if (scope === "free") return ["free"]
  if (scope === "member") return ["business", "paid"]
  return null
}

function resolvePreferredPlanCohortForVirtualKey(input: {
  key?: { accountScope?: VirtualApiKeyRecord["accountScope"] | null } | null
  requestedModel?: string | null
  account?: StoredAccount | null
  routingHints?: ProviderRoutingHints | null
}) {
  const allowedPlanCohorts = resolveVirtualKeyAllowedPlanCohorts(input.key)
  const modelPreferredPlanCohort = resolveRequestedModelPlanCohort(input.requestedModel)
  if (allowedPlanCohortsInclude(allowedPlanCohorts, modelPreferredPlanCohort)) return modelPreferredPlanCohort
  if (allowedPlanCohortsInclude(allowedPlanCohorts, input.routingHints?.preferredPlanCohort)) {
    return input.routingHints?.preferredPlanCohort ?? null
  }
  const accountPlanCohort = input.account ? resolveAccountPlanCohort(input.account) : null
  if (allowedPlanCohortsInclude(allowedPlanCohorts, accountPlanCohort)) return accountPlanCohort
  return allowedPlanCohorts?.[0] ?? null
}

function accountCanUseRequestedModel(account: StoredAccount, model?: string | null) {
  return true
}

function buildProviderRoutingHintsForRequestedModel(
  providerId: string,
  model?: string | null,
  now = Date.now(),
  options?: ProviderRoutingHintsOptions,
) {
  const allowedPlanCohorts = normalizeAllowedPlanCohorts(options?.allowedPlanCohorts)
  const modelPreferredPlanCohort = resolveRequestedModelPlanCohort(model)
  const preferredPlanCohort = allowedPlanCohortsInclude(allowedPlanCohorts, modelPreferredPlanCohort)
    ? modelPreferredPlanCohort
    : null
  const fallbackPreferredPlanCohort = allowedPlanCohortsInclude(allowedPlanCohorts, options?.preferredPlanCohort)
    ? options?.preferredPlanCohort
    : null
  return buildProviderRoutingHints(providerId, now, {
    ...options,
    allowedPlanCohorts,
    preferredPlanCohort: preferredPlanCohort ?? fallbackPreferredPlanCohort ?? null,
    cohortMode: preferredPlanCohort ? "prefer" : options?.cohortMode,
  })
}

function buildRelaxedProviderRoutingHintsForRequestedModel(
  providerId: string,
  model?: string | null,
  now = Date.now(),
  options?: ProviderRoutingHintsOptions,
) {
  return buildRelaxedProviderRoutingHints(providerId, now, options)
}

function buildProviderRoutingHintsForVirtualKey(
  key: Pick<VirtualApiKeyRecord, "providerId"> & { accountScope?: VirtualApiKeyRecord["accountScope"] | null },
  model?: string | null,
  now = Date.now(),
  options?: ProviderRoutingHintsOptions,
) {
  const allowedPlanCohorts = resolveVirtualKeyAllowedPlanCohorts(key)
  return buildProviderRoutingHintsForRequestedModel(key.providerId, model, now, {
    ...options,
    allowedPlanCohorts: allowedPlanCohorts ?? options?.allowedPlanCohorts ?? null,
  })
}

function buildRelaxedProviderRoutingHintsForVirtualKey(
  key: Pick<VirtualApiKeyRecord, "providerId"> & { accountScope?: VirtualApiKeyRecord["accountScope"] | null },
  model?: string | null,
  now = Date.now(),
  options?: ProviderRoutingHintsOptions,
) {
  const allowedPlanCohorts = resolveVirtualKeyAllowedPlanCohorts(key)
  return buildRelaxedProviderRoutingHintsForRequestedModel(key.providerId, model, now, {
    ...options,
    allowedPlanCohorts: allowedPlanCohorts ?? options?.allowedPlanCohorts ?? null,
  })
}

function resolveAccountRoutingState(accountId: string, quota?: AccountQuotaSnapshot | null, now = Date.now()): AccountRoutingState {
  const normalizedAccountId = normalizeIdentity(accountId)
  const headroomPercent = resolveQuotaSnapshotHeadroomPercent(quota ?? (normalizedAccountId ? accountQuotaCache.get(normalizedAccountId) : null), now)
  if (!normalizedAccountId) {
    return {
      state: "eligible",
      reason: null,
      headroomPercent,
      softDrainThresholdPercent: ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD,
    }
  }

  cleanupQuotaExhaustedCooldown(now)
  const unhealthy = getActiveAccountHealthSnapshot(accountHealthCache, normalizedAccountId, normalizeIdentity, now)
  if (unhealthy) {
    return {
      state: "excluded",
      reason: unhealthy.reason || "account_unhealthy",
      headroomPercent,
      softDrainThresholdPercent: ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD,
    }
  }
  if (quotaExhaustedAccountCooldown.has(normalizedAccountId)) {
    return {
      state: "excluded",
      reason: "quota_exhausted_cooldown",
      headroomPercent,
      softDrainThresholdPercent: ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD,
    }
  }
  if (Number.isFinite(headroomPercent) && Number(headroomPercent) <= 0) {
    return {
      state: "excluded",
      reason: "quota_headroom_exhausted",
      headroomPercent: Number(headroomPercent),
      softDrainThresholdPercent: ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD,
    }
  }
  if (
    Number.isFinite(headroomPercent) &&
    Number(headroomPercent) <= ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD
  ) {
    return {
      state: "soft_drained",
      reason: "quota_headroom_low",
      headroomPercent: Number(headroomPercent),
      softDrainThresholdPercent: ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD,
    }
  }
  return {
    state: "eligible",
    reason: null,
    headroomPercent,
    softDrainThresholdPercent: ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD,
  }
}

async function fetchAccountQuotaSnapshot(account: StoredAccount): Promise<AccountQuotaSnapshot> {
  if (account.providerId !== "chatgpt") {
    return makeUnavailableQuota("quota not available for non-chatgpt account")
  }
  if (!account.accessToken && !account.refreshToken) {
    return makeUnavailableQuota("account token unavailable")
  }

  try {
    const auth = await ensureChatgptAccountAccess(account)
    const headers = buildUpstreamForwardHeaders({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      boundAccountId: account.id,
      providerMode: "chatgpt",
      defaultAccept: "application/json",
    })
    const routeTag = "/api/accounts/quota"
    const runRequest = async () =>
      (
        await requestUpstreamWithPolicy({
          url: CODEX_RATE_LIMITS_ENDPOINT,
          method: "GET",
          headers,
          accountId: account.id,
          routeTag,
        })
      ).response

    let upstream = await runRequest()
    if (upstream.status === 401) {
      const latest = accountStore.get(account.id) ?? account
      const refreshed = await refreshChatgptAccountAccess(latest)
      headers.set("authorization", `Bearer ${refreshed.accessToken}`)
      if (refreshed.accountId) {
        headers.set("ChatGPT-Account-ID", refreshed.accountId)
      } else {
        headers.delete("ChatGPT-Account-ID")
      }
      upstream = await runRequest()
    }

    const bodyText = await upstream.text().catch(() => "")
    if (!upstream.ok) {
      const blocked = detectRoutingBlockedAccount({
        statusCode: upstream.status,
        text: bodyText,
      })
      if (blocked.matched) {
        markAccountUnhealthy(account.id, blocked.reason, "quota")
      }
      return {
        status: "error",
        fetchedAt: Date.now(),
        planType: null,
        primary: null,
        additional: [],
        error: `quota request failed (${upstream.status})${bodyText ? `: ${bodyText}` : ""}`,
      }
    }

    let payload: unknown = {}
    if (bodyText.trim()) {
      try {
        payload = JSON.parse(bodyText) as unknown
      } catch {
        return {
          status: "error",
          fetchedAt: Date.now(),
          planType: null,
          primary: null,
          additional: [],
          error: "quota payload is not valid json",
        }
      }
    }

    const normalized = normalizeRateLimitUsagePayload(payload)
    markAccountHealthy(account.id, "quota")
    return {
      status: "ok",
      fetchedAt: Date.now(),
      planType: normalized.planType,
      primary: normalized.primary,
      additional: normalized.additional,
      error: null,
    }
  } catch (error) {
    const blocked = detectRoutingBlockedAccount({
      error,
    })
    if (blocked.matched) {
      markAccountUnhealthy(account.id, blocked.reason, "quota")
    } else {
      const transient = detectTransientUpstreamError(error)
      if (transient.matched) {
        markAccountUnhealthy(account.id, transient.reason ?? "upstream_transport_error", "quota")
      }
    }
    return makeQuotaError(error)
  }
}

async function refreshAccountQuotaCache(accounts: StoredAccount[], input?: { force?: boolean; targetAccountID?: string | null }) {
  const now = Date.now()
  const targetAccountID = String(input?.targetAccountID ?? "").trim()
  if (!targetAccountID) {
    const accountIDs = new Set(accounts.map((item) => item.id))
    for (const key of accountQuotaCache.keys()) {
      if (!accountIDs.has(key)) accountQuotaCache.delete(key)
    }
  }

  for (const account of accounts) {
    if (targetAccountID && account.id !== targetAccountID) continue
    const force = Boolean(input?.force)
    if (!force && isQuotaCacheFresh(accountQuotaCache.get(account.id), now)) continue
    const snapshot = await fetchAccountQuotaSnapshot(account)
    accountQuotaCache.set(account.id, snapshot)
  }
}

function toPublicAccount(account: StoredAccount, quota?: AccountQuotaSnapshot | null) {
  const metadata = account.metadata ?? {}
  const derived = resolvePublicAccountDerivedState(account.id, quota)
  return {
    ...account,
    organizationId: normalizeIdentity(String((metadata as Record<string, unknown>).organizationId ?? "")),
    projectId: normalizeIdentity(String((metadata as Record<string, unknown>).projectId ?? "")),
    chatgptPlanType: normalizeIdentity(String((metadata as Record<string, unknown>).chatgptPlanType ?? "")),
    chatgptUserId: normalizeIdentity(String((metadata as Record<string, unknown>).chatgptUserId ?? "")),
    accessToken: account.accessToken ? "***" : "",
    refreshToken: null,
    idToken: null,
    hasAccessToken: Boolean(account.accessToken),
    hasRefreshToken: Boolean(account.refreshToken),
    hasIdToken: Boolean(account.idToken),
    health: derived.health,
    routing: derived.routing,
    abnormalState: derived.abnormalState,
    quota: quota ?? null,
  }
}

function deleteAccountsWithSingleRouteKeys(accounts: StoredAccount[]) {
  const normalizedAccounts = accounts.filter(Boolean)
  const accountIds = new Set(normalizedAccounts.map((item) => item.id))
  const singleRouteKeys = accountStore
    .listVirtualApiKeys()
    .filter((item) => item.routingMode === "single" && item.accountId && accountIds.has(item.accountId))

  for (const key of singleRouteKeys) {
    accountStore.deleteVirtualApiKey(key.id)
  }

  const providerIds = new Set<string>()
  for (const account of normalizedAccounts) {
    providerIds.add(account.providerId)
    accountStore.delete(account.id)
    accountQuotaCache.delete(account.id)
    accountHealthCache.delete(account.id)
    evictAccountModelsCache(account.id)
  }

  for (const providerId of providerIds) {
    invalidatePoolConsistency(providerId)
  }

  return {
    deletedVirtualKeyCount: singleRouteKeys.length,
  }
}

function buildOAuthIdentity(input: { email?: string; accountId?: string }) {
  const email = normalizeIdentity(input.email)?.toLowerCase()
  const accountId = normalizeIdentity(input.accountId)
  if (email && accountId) return `${email}::${accountId}`
  return email || accountId || crypto.randomUUID()
}

function resolvePortableOAuthTokenProfile(input: {
  accessToken?: string | null
  idToken?: string | null
  email?: string | null
  accountId?: string | null
  fallbackAccountIds?: Array<string | null | undefined>
  organizationId?: string | null
  projectId?: string | null
  chatgptPlanType?: string | null
  chatgptUserId?: string | null
  completedPlatformOnboarding?: boolean
  isOrgOwner?: boolean
}) {
  const accessToken = normalizeIdentity(input.accessToken)
  const idToken = normalizeIdentity(input.idToken)
  const accessPayload = parseJwtPayload(accessToken)
  const idPayload = parseJwtPayload(idToken)
  const accessAuth = parseJwtAuthClaims(accessToken)
  const idAuth = parseJwtAuthClaims(idToken)
  const accessProfile = asObjectRecord(accessPayload?.["https://api.openai.com/profile"])
  const idProfile = asObjectRecord(idPayload?.["https://api.openai.com/profile"])
  const fallbackAccountId =
    (input.fallbackAccountIds ?? [])
      .map((value) => normalizeIdentity(value))
      .find((value) => Boolean(value)) ?? undefined

  const resolvedEmail =
    normalizeIdentity(String(accessProfile?.email ?? "")) ||
    normalizeIdentity(String(idPayload?.email ?? "")) ||
    normalizeIdentity(String(idProfile?.email ?? "")) ||
    normalizeIdentity(input.email)
  const resolvedAccountId =
    normalizeIdentity(input.accountId) ||
    normalizeIdentity(accessAuth?.chatgpt_account_id) ||
    normalizeIdentity(idAuth?.chatgpt_account_id) ||
    fallbackAccountId
  const resolvedChatgptPlanType =
    normalizeIdentity(accessAuth?.chatgpt_plan_type) ||
    normalizeIdentity(idAuth?.chatgpt_plan_type) ||
    normalizeIdentity(input.chatgptPlanType)
  const resolvedChatgptUserId =
    normalizeIdentity(accessAuth?.chatgpt_user_id) ||
    normalizeIdentity(accessAuth?.user_id) ||
    normalizeIdentity(idAuth?.chatgpt_user_id) ||
    normalizeIdentity(idAuth?.user_id) ||
    normalizeIdentity(input.chatgptUserId)
  const resolvedOrganizationId =
    normalizeIdentity(accessAuth?.organization_id) ||
    normalizeIdentity(idAuth?.organization_id) ||
    resolveDefaultOrganizationIdFromAuthRecord(idPayload?.["https://api.openai.com/auth"]) ||
    resolveDefaultOrganizationIdFromAuthRecord(accessPayload?.["https://api.openai.com/auth"]) ||
    normalizeIdentity(input.organizationId)
  const resolvedProjectId =
    normalizeIdentity(accessAuth?.project_id) ||
    normalizeIdentity(idAuth?.project_id) ||
    normalizeIdentity(input.projectId)
  const resolvedCompletedPlatformOnboarding =
    typeof accessAuth?.completed_platform_onboarding === "boolean"
      ? accessAuth.completed_platform_onboarding
      : typeof idAuth?.completed_platform_onboarding === "boolean"
        ? idAuth.completed_platform_onboarding
        : typeof input.completedPlatformOnboarding === "boolean"
          ? input.completedPlatformOnboarding
          : undefined
  const resolvedIsOrgOwner =
    typeof accessAuth?.is_org_owner === "boolean"
      ? accessAuth.is_org_owner
      : typeof idAuth?.is_org_owner === "boolean"
        ? idAuth.is_org_owner
        : typeof input.isOrgOwner === "boolean"
          ? input.isOrgOwner
          : undefined
  const expiresAt = toEpochMs(asFiniteNumber(accessPayload?.exp)) ?? toEpochMs(asFiniteNumber(idPayload?.exp))

  return {
    accessToken,
    idToken,
    email: resolvedEmail,
    accountId: resolvedAccountId,
    organizationId: resolvedOrganizationId,
    projectId: resolvedProjectId,
    chatgptPlanType: resolvedChatgptPlanType,
    chatgptUserId: resolvedChatgptUserId,
    completedPlatformOnboarding: resolvedCompletedPlatformOnboarding,
    isOrgOwner: resolvedIsOrgOwner,
    expiresAt: expiresAt ?? undefined,
  }
}

function exportStoredOAuthAccount(account: StoredAccount) {
  const metadata = asObjectRecord(account.metadata) ?? {}
  const completedPlatformOnboarding = metadata.completedPlatformOnboarding
  const isOrgOwner = metadata.isOrgOwner
  return {
    type: "oauth",
    provider_id: account.providerId,
    provider_name: account.providerName,
    method_id: account.methodId,
    display_name: account.displayName,
    email: account.email ?? undefined,
    account_id: account.accountId ?? undefined,
    access_token: account.accessToken || undefined,
    refresh_token: account.refreshToken ?? undefined,
    id_token: account.idToken ?? undefined,
    expires_at: account.expiresAt ?? undefined,
    organization_id: normalizeIdentity(String(metadata.organizationId ?? "")) || undefined,
    project_id: normalizeIdentity(String(metadata.projectId ?? "")) || undefined,
    chatgpt_plan_type: normalizeIdentity(String(metadata.chatgptPlanType ?? "")) || undefined,
    chatgpt_user_id: normalizeIdentity(String(metadata.chatgptUserId ?? "")) || undefined,
    completed_platform_onboarding:
      typeof completedPlatformOnboarding === "boolean" ? completedPlatformOnboarding : undefined,
    is_org_owner: typeof isOrgOwner === "boolean" ? isOrgOwner : undefined,
    exported_at: new Date().toISOString(),
    source: "codex-gateway-export",
  }
}

function resolveImportedJsonOAuthAccount(input: z.infer<typeof ImportJsonAccountSchema>) {
  const accessToken = String(input.access_token ?? input.accessToken ?? "").trim()
  const refreshToken = normalizeIdentity(String(input.refresh_token ?? input.refreshToken ?? ""))
  const idToken = normalizeIdentity(String(input.id_token ?? input.idToken ?? ""))
  const importedType = normalizeIdentity(input.type)
  const lastRefresh = normalizeIdentity(String(input.last_refresh ?? input.lastRefresh ?? ""))
  const importedAccountId = normalizeImportedJsonString(input.account_id ?? input.accountId)
  const importedWorkspaceId = normalizeImportedJsonString(input.workspace_id ?? input.workspaceId)
  const importedClientId = normalizeImportedJsonString(input.client_id ?? input.clientId)
  const importedSessionToken = normalizeImportedJsonString(input.session_token ?? input.sessionToken)
  const importedEmailService = normalizeImportedJsonString(input.email_service ?? input.emailService)
  const importedRegisteredAt = normalizeImportedJsonString(input.registered_at ?? input.registeredAt)
  const importedStatus = normalizeImportedJsonString(input.status)
  const importedExpiresAt = parseImportedJsonExpiresAt(input.expires_at ?? input.expiresAt)

  const resolvedTokens = resolvePortableOAuthTokenProfile({
    accessToken,
    idToken,
    email: input.email,
    fallbackAccountIds: [importedAccountId, importedWorkspaceId],
  })
  const expiresAt = resolvedTokens.expiresAt ?? importedExpiresAt

  if (!resolvedTokens.email && !resolvedTokens.accountId) {
    throw new Error("Imported JSON does not contain a usable email or chatgpt_account_id")
  }

  return {
    importedType,
    lastRefresh,
    accessToken,
    refreshToken: refreshToken ?? undefined,
    idToken: resolvedTokens.idToken,
    email: resolvedTokens.email,
    accountId: resolvedTokens.accountId,
    expiresAt: expiresAt ?? undefined,
    metadata: {
      source: "codex-json-import",
      importedType,
      lastRefresh,
      importedAccountId,
      importedWorkspaceId,
      importedClientId,
      importedEmailService,
      importedRegisteredAt,
      importedStatus,
      importedSessionTokenPresent: Boolean(importedSessionToken),
      organizationId: resolvedTokens.organizationId,
      projectId: resolvedTokens.projectId,
      chatgptPlanType: resolvedTokens.chatgptPlanType,
      chatgptUserId: resolvedTokens.chatgptUserId,
      completedPlatformOnboarding: resolvedTokens.completedPlatformOnboarding,
      isOrgOwner: resolvedTokens.isOrgOwner,
    },
  }
}

function importJsonOAuthAccount(input: z.infer<typeof ImportJsonAccountSchema>) {
  const resolved = resolveImportedJsonOAuthAccount(input)
  ensureForcedWorkspaceAllowed(resolved.accountId)
  const identity = buildOAuthIdentity({
    email: resolved.email,
    accountId: resolved.accountId,
  })
  const displayName = resolved.email || resolved.accountId || "Codex OAuth Account"
  const accountID = accountStore.saveBridgeOAuth({
    providerId: "chatgpt",
    providerName: "ChatGPT",
    methodId: "codex-json",
    displayName,
    accountKey: identity,
    email: resolved.email,
    accountId: resolved.accountId,
    accessToken: resolved.accessToken,
    refreshToken: resolved.refreshToken,
    idToken: resolved.idToken,
    expiresAt: resolved.expiresAt,
    metadata: resolved.metadata,
  })
  markAccountHealthy(accountID, "codex-json-import")
  const importedAccount = accountStore.get(accountID)
  invalidatePoolConsistency("chatgpt", importedAccount ? { account: importedAccount } : undefined)
  handleBackgroundPromise(
    "refreshAndEmitAccountQuota:codex-json-import",
    refreshAndEmitAccountQuota(accountID, "codex-json-import"),
  )
  const account = accountStore.get(accountID)
  let virtualKey: { key: string; record: unknown } | undefined
  if (input.issueVirtualKey) {
    const issued = accountStore.createVirtualApiKey({
      accountId: accountID,
      providerId: "chatgpt",
      routingMode: "single",
      name: input.keyName || "Imported Codex Key",
    })
    virtualKey = {
      key: issued.key,
      record: issued.record,
    }
  }

  return {
    accountId: accountID,
    account: account ? toPublicAccount(account, accountQuotaCache.get(accountID) ?? null) : null,
    virtualKey,
  }
}

async function importRefreshTokenOAuthAccount(input: z.infer<typeof ImportRtAccountSchema>) {
  const refreshToken = normalizeIdentity(String(input.refresh_token ?? input.refreshToken ?? ""))
  if (!refreshToken) {
    throw new Error("refresh_token is required")
  }

  const importedAccountId = normalizeImportedJsonString(input.account_id ?? input.accountId)
  const importedWorkspaceId = normalizeImportedJsonString(input.workspace_id ?? input.workspaceId)
  const accessTokenCandidate = normalizeIdentity(String(input.access_token ?? input.accessToken ?? ""))
  const idToken = normalizeIdentity(String(input.id_token ?? input.idToken ?? ""))
  const providedExpiresAt = parseImportedJsonExpiresAt(input.expires_at ?? input.expiresAt)
  const completedPlatformOnboarding =
    typeof input.completedPlatformOnboarding === "boolean"
      ? input.completedPlatformOnboarding
      : typeof input.completed_platform_onboarding === "boolean"
        ? input.completed_platform_onboarding
        : undefined
  const isOrgOwner =
    typeof input.isOrgOwner === "boolean"
      ? input.isOrgOwner
      : typeof input.is_org_owner === "boolean"
        ? input.is_org_owner
        : undefined

  const initialResolved = resolvePortableOAuthTokenProfile({
    accessToken: accessTokenCandidate,
    idToken,
    email: input.email,
    accountId: importedAccountId,
    fallbackAccountIds: [importedWorkspaceId],
    organizationId: normalizeImportedJsonString(input.organization_id ?? input.organizationId),
    projectId: normalizeImportedJsonString(input.project_id ?? input.projectId),
    chatgptPlanType: normalizeImportedJsonString(input.chatgpt_plan_type ?? input.chatgptPlanType),
    chatgptUserId: normalizeImportedJsonString(input.chatgpt_user_id ?? input.chatgptUserId),
    completedPlatformOnboarding,
    isOrgOwner,
  })

  let accessToken = initialResolved.accessToken
  let finalRefreshToken = refreshToken
  let finalIdToken = initialResolved.idToken
  let finalExpiresAt = initialResolved.expiresAt ?? providedExpiresAt ?? undefined
  let finalResolved = initialResolved
  let refreshed = false

  if (!accessToken) {
    const provider = providers.getProvider(input.providerId)
    if (!provider?.refresh) {
      throw new Error(`Provider ${input.providerId} does not support refresh-token import`)
    }

    const refreshStub: StoredAccount = {
      id: crypto.randomUUID(),
      providerId: input.providerId,
      providerName: input.providerName,
      methodId: input.methodId,
      displayName: normalizeIdentity(input.displayName) || initialResolved.email || initialResolved.accountId || "RT Import",
      accountKey: buildOAuthIdentity({
        email: initialResolved.email,
        accountId: initialResolved.accountId,
      }),
      email: initialResolved.email ?? null,
      accountId: initialResolved.accountId ?? null,
      enterpriseUrl: null,
      accessToken: "",
      refreshToken,
      idToken: finalIdToken ?? null,
      expiresAt: finalExpiresAt ?? null,
      isActive: false,
      metadata: {},
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const refreshResult = await provider.refresh(refreshStub)
    if (!refreshResult?.accessToken) {
      throw new Error("Refresh token import failed: provider did not return an access token")
    }
    refreshed = true
    accessToken = refreshResult.accessToken
    finalRefreshToken = refreshResult.refreshToken ?? refreshToken
    finalIdToken = refreshResult.idToken ?? finalIdToken
    finalExpiresAt = refreshResult.expiresAt ?? finalExpiresAt
    finalResolved = resolvePortableOAuthTokenProfile({
      accessToken,
      idToken: finalIdToken,
      email: initialResolved.email ?? input.email,
      accountId: refreshResult.accountId ?? initialResolved.accountId ?? importedAccountId,
      fallbackAccountIds: [importedWorkspaceId],
      organizationId: initialResolved.organizationId,
      projectId: initialResolved.projectId,
      chatgptPlanType: initialResolved.chatgptPlanType,
      chatgptUserId: initialResolved.chatgptUserId,
      completedPlatformOnboarding: initialResolved.completedPlatformOnboarding,
      isOrgOwner: initialResolved.isOrgOwner,
    })
  }

  if (!accessToken) {
    throw new Error("Refresh token import requires a usable access token")
  }
  if (!finalResolved.email && !finalResolved.accountId) {
    throw new Error("Imported refresh token does not contain a usable email or chatgpt_account_id")
  }

  ensureForcedWorkspaceAllowed(finalResolved.accountId)
  const identity = buildOAuthIdentity({
    email: finalResolved.email,
    accountId: finalResolved.accountId,
  })
  const displayName =
    normalizeIdentity(input.displayName) || finalResolved.email || finalResolved.accountId || "Imported Refresh Token Account"
  const accountID = accountStore.saveBridgeOAuth({
    providerId: input.providerId,
    providerName: input.providerName,
    methodId: input.methodId,
    displayName,
    accountKey: identity,
    email: finalResolved.email,
    accountId: finalResolved.accountId,
    accessToken,
    refreshToken: finalRefreshToken,
    idToken: finalIdToken,
    expiresAt: finalExpiresAt,
    metadata: {
      source: "codex-refresh-token-import",
      importMode: accessTokenCandidate ? "refresh-token-with-access-token" : "refresh-token-refresh-first",
      importedAccountId,
      importedWorkspaceId,
      idTokenPresent: Boolean(finalIdToken),
      organizationId: finalResolved.organizationId,
      projectId: finalResolved.projectId,
      chatgptPlanType: finalResolved.chatgptPlanType,
      chatgptUserId: finalResolved.chatgptUserId,
      completedPlatformOnboarding: finalResolved.completedPlatformOnboarding,
      isOrgOwner: finalResolved.isOrgOwner,
    },
  })
  markAccountHealthy(accountID, refreshed ? "refresh-token-import-refresh" : "refresh-token-import")
  const importedAccount = accountStore.get(accountID)
  invalidatePoolConsistency(input.providerId, importedAccount ? { account: importedAccount } : undefined)
  handleBackgroundPromise(
    "refreshAndEmitAccountQuota:refresh-token-import",
    refreshAndEmitAccountQuota(accountID, "refresh-token-import"),
  )
  const account = accountStore.get(accountID)
  let virtualKey: { key: string; record: unknown } | undefined
  if (input.issueVirtualKey) {
    const issued = accountStore.createVirtualApiKey({
      accountId: accountID,
      providerId: input.providerId,
      routingMode: "single",
      name: input.keyName || "Imported RT Key",
    })
    virtualKey = {
      key: issued.key,
      record: issued.record,
    }
  }

  return {
    accountId: accountID,
    account: account ? toPublicAccount(account, accountQuotaCache.get(accountID) ?? null) : null,
    virtualKey,
    refreshed,
  }
}

function buildApiKeyIdentity(apiKey: string) {
  const normalized = String(apiKey ?? "").trim()
  const digest = createHash("sha256").update(normalized).digest("hex")
  return `apikey:${digest.slice(0, 32)}`
}

function ensureForcedWorkspaceAllowed(accountId?: string | null) {
  if (!FORCED_WORKSPACE_ID) return
  const normalized = normalizeIdentity(accountId)
  if (!normalized) {
    throw new Error(
      `Login is restricted to workspace id ${FORCED_WORKSPACE_ID}, but token is missing chatgpt_account_id.`,
    )
  }
  if (normalized !== FORCED_WORKSPACE_ID) {
    throw new Error(`Login is restricted to workspace id ${FORCED_WORKSPACE_ID}.`)
  }
}

function runOpenCommand(command: string, args: string[], timeoutMs = 5000) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    stdio: "pipe",
    encoding: "utf8",
    timeout: timeoutMs,
  })
  return {
    command,
    args,
    status: result.status ?? null,
    error: result.error ? String(result.error.message || result.error) : "",
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  }
}

function quotePowerShellLiteral(value: string) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`
}

function getWindowsChromeCommandCandidates() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe")
      : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    "chrome.exe",
  ]
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const value = String(candidate ?? "").trim()
    if (!value) return false
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    if (value.toLowerCase() !== "chrome.exe" && !existsSync(value)) return false
    seen.add(key)
    return true
  })
}

function runDetachedOpenCommand(command: string, args: string[]) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    })
    child.unref()
    return {
      command,
      args,
      status: 0,
      error: "",
      stdout: "",
      stderr: "",
      detached: true,
    }
  } catch (error) {
    return {
      command,
      args,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      stdout: "",
      stderr: "",
      detached: true,
    }
  }
}

function openExternalUrl(url: string) {
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are allowed")
  }

  const attempts: ReturnType<typeof runOpenCommand>[] = []
  const strategies: Array<{ command: string; args: string[] }> = []

  if (process.platform === "win32") {
    for (const chrome of getWindowsChromeCommandCandidates()) {
      const attempt = runDetachedOpenCommand(chrome, ["--incognito", url])
      attempts.push(attempt)
      if (attempt.status === 0 && !attempt.error) {
        console.log(`[oauth-multi-login] open-url success via chrome incognito: ${chrome}`)
        return {
          strategy: chrome,
          detail: `${chrome} --incognito detached`,
        }
      }
    }
    strategies.push({ command: "cmd", args: ["/c", "start", "", "chrome.exe", "--incognito", url] })
    strategies.push({
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process -FilePath ${quotePowerShellLiteral(url)}`,
      ],
    })
    strategies.push({ command: "explorer", args: [url] })
    strategies.push({ command: "cmd", args: ["/c", "start", "", url] })
    strategies.push({ command: "rundll32", args: ["url.dll,FileProtocolHandler", url] })
  } else if (process.platform === "darwin") {
    strategies.push({ command: "open", args: [url] })
  } else {
    strategies.push({ command: "xdg-open", args: [url] })
  }

  for (const strategy of strategies) {
    const attempt = runOpenCommand(strategy.command, strategy.args)
    attempts.push(attempt)
    const ok = attempt.status === 0 && !attempt.error
    if (ok) {
      console.log(`[oauth-multi-login] open-url success via ${attempt.command}`)
      return {
        strategy: attempt.command,
        detail: `${attempt.command} status=${attempt.status}${attempt.stdout ? ` stdout=${attempt.stdout}` : ""}`,
      }
    }
  }

  const detail = attempts
    .map((item) => {
      const stderr = item.stderr ? ` stderr=${item.stderr}` : ""
      const stdout = item.stdout ? ` stdout=${item.stdout}` : ""
      const error = item.error ? ` error=${item.error}` : ""
      return `${item.command} status=${item.status}${error}${stderr}${stdout}`
    })
    .join(" | ")

  console.error(`[oauth-multi-login] open-url failed: ${detail}`)
  throw new Error(`Failed to launch browser. ${detail}`)
}

function extractBearerToken(headerValue?: string | null) {
  if (!headerValue) return null
  const match = headerValue.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  return match[1]?.trim() || null
}

function normalizeSessionRouteID(value?: string | null) {
  const normalized = String(value ?? "").trim()
  if (!normalized) return undefined
  return normalized.slice(0, 240)
}

function extractSessionRouteIDFromHeaders(headers?: Headers) {
  if (!headers) return undefined
  const candidates = [
    headers.get("session_id"),
    headers.get("session-id"),
    headers.get("x-session-id"),
    headers.get("sessionid"),
    headers.get("prompt_cache_key"),
    headers.get("prompt-cache-key"),
    headers.get("x-prompt-cache-key"),
    headers.get("thread_id"),
    headers.get("thread-id"),
    headers.get("conversation"),
    headers.get("conversation_id"),
    headers.get("conversation-id"),
    headers.get("previous_response_id"),
    headers.get("previous-response-id"),
    headers.get("previousresponseid"),
  ]
  for (const candidate of candidates) {
    const normalized = normalizeSessionRouteID(candidate)
    if (normalized) return normalized
  }
  return undefined
}

function extractSessionRouteIDFromRequestUrl(requestUrl?: string | null) {
  const raw = String(requestUrl ?? "").trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    const candidates = [
      "session_id",
      "sessionId",
      "prompt_cache_key",
      "promptCacheKey",
      "thread_id",
      "threadId",
      "conversation",
      "conversation_id",
      "conversationId",
      "previous_response_id",
      "previousResponseId",
    ]
    for (const key of candidates) {
      const normalized = normalizeSessionRouteID(url.searchParams.get(key))
      if (normalized) return normalized
    }
  } catch {
    // ignore malformed URL and continue
  }
  return undefined
}

function extractSessionRouteShardFromHeaders(headers?: Headers) {
  if (!headers) return undefined
  const candidates = [
    headers.get("x-openai-subagent"),
    headers.get("x-codex-parent-thread-id"),
    headers.get("x-codex-window-id"),
  ]
  const parts = candidates
    .map((candidate) => normalizeNullableString(candidate, 240))
    .filter((candidate): candidate is string => Boolean(candidate))
  if (parts.length === 0) return undefined
  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 16)
}

function resolveSessionRouteID(input: { headers?: Headers; requestUrl?: string | null; bodySessionId?: string | null }) {
  const baseSessionId =
    normalizeSessionRouteID(input.bodySessionId) ??
    extractSessionRouteIDFromHeaders(input.headers) ??
    extractSessionRouteIDFromRequestUrl(input.requestUrl)
  if (!baseSessionId) return undefined
  const shard = extractSessionRouteShardFromHeaders(input.headers)
  return shard ? normalizeSessionRouteID(`${baseSessionId}:shard:${shard}`) : baseSessionId
}

function resolveVirtualKeyContext(
  c: any,
  options?: {
    expectedClientMode?: "codex" | "cursor"
    expectedWireApi?: "responses" | "chat_completions"
    bodySessionId?: string | null
    requestedModel?: string | null
  },
) {
  const bearer = extractBearerToken(c.req.header("authorization"))
  if (!bearer) return { error: "Missing Authorization Bearer token" as const, status: 401 as const }

  const sessionId = resolveSessionRouteID({
    headers: c.req.raw.headers,
    requestUrl: c.req.url,
    bodySessionId: options?.bodySessionId,
  })
  const resolved = resolveVirtualApiKeyWithPoolFallback(bearer, sessionId, {
    requestedModel: options?.requestedModel ?? null,
  })
  if (!resolved) return { error: "Invalid, revoked, or expired virtual API key" as const, status: 401 as const }

  const expectedClientMode = options?.expectedClientMode
  const expectedWireApi = options?.expectedWireApi
  if (expectedClientMode || expectedWireApi) {
    const modeError = buildVirtualKeyModeError({
      key: resolved.key,
      expectedClientMode: expectedClientMode ?? "codex",
      expectedWireApi,
    })
    if (modeError) return modeError
  }

  const routed = ensureResolvedPoolAccountEligible({
    resolved,
    sessionId,
    requestedModel: options?.requestedModel ?? null,
  })
  if (!routed) {
    const unavailable = resolveAutomaticAccountAvailability({ account: resolved.account })
    return {
      error:
        resolved.key.routingMode === "pool"
          ? ("No healthy accounts available for pool routing" as const)
          : (unavailable.ok ? "Upstream account is unavailable" : unavailable.message),
      status: 503 as const,
    }
  }

  return { resolved: routed, sessionId }
}

function resolveVirtualApiKeyWithPoolFallback(
  secret: string,
  sessionId?: string | null,
  options?: { requestedModel?: string | null },
) {
  const requestedModel = options?.requestedModel ?? null
  const primary = accountStore.resolveVirtualApiKey(secret, {
    sessionId,
    routeOptionsFactory: (key) =>
      key.routingMode === "pool" ? buildProviderRoutingHintsForVirtualKey(key, requestedModel) : undefined,
  })
  if (primary) return primary
  const relaxed = accountStore.resolveVirtualApiKey(secret, {
    sessionId,
    routeOptionsFactory: (key) =>
      key.routingMode === "pool"
        ? buildRelaxedProviderRoutingHintsForVirtualKey(key, requestedModel)
        : undefined,
  })
  if (relaxed) return relaxed
  if (resolveRequestedModelPlanCohort(requestedModel)) {
    const fallback = accountStore.resolveVirtualApiKey(secret, {
      sessionId,
      routeOptionsFactory: (key) =>
        key.routingMode === "pool" ? buildRelaxedProviderRoutingHintsForVirtualKey(key, requestedModel) : undefined,
    })
    if (fallback) return fallback
  }
  const bridgeVirtualKey = resolveVirtualApiKeyFromCodexOAuthBridge(secret, sessionId, requestedModel)
  if (bridgeVirtualKey) return bridgeVirtualKey
  const oauthBridgeAccount = resolveStoredAccountFromChatgptBearer(secret, requestedModel)
  if (oauthBridgeAccount) {
    return {
      key: buildOAuthBridgeVirtualKey(oauthBridgeAccount),
      account: oauthBridgeAccount,
    }
  }
  return null
}

function rerouteResolvedPoolAccount(input: {
  resolved: {
    key: {
      id: string
      providerId: string
      routingMode: string
      accountScope?: VirtualApiKeyRecord["accountScope"] | null
    }
    account: StoredAccount
  }
  sessionId?: string | null
  routingHints: ProviderRoutingHints
}) {
  const failedAccountId = input.resolved.account.id
  return input.sessionId
      ? accountStore.reassignVirtualKeySessionRoute({
          keyId: input.resolved.key.id,
          providerId: input.resolved.key.providerId,
          sessionId: input.sessionId,
          failedAccountId,
          accountScope: input.resolved.key.accountScope ?? "all",
          excludeAccountIds: input.routingHints.excludeAccountIds,
          deprioritizedAccountIds: input.routingHints.deprioritizedAccountIds,
          headroomByAccountId: input.routingHints.headroomByAccountId,
          pressureScoreByAccountId: input.routingHints.pressureScoreByAccountId,
        })
      : accountStore.reassignVirtualKeyRoute({
          keyId: input.resolved.key.id,
          providerId: input.resolved.key.providerId,
          failedAccountId,
          accountScope: input.resolved.key.accountScope ?? "all",
          excludeAccountIds: input.routingHints.excludeAccountIds,
          deprioritizedAccountIds: input.routingHints.deprioritizedAccountIds,
          headroomByAccountId: input.routingHints.headroomByAccountId,
          pressureScoreByAccountId: input.routingHints.pressureScoreByAccountId,
        })
}

function ensureResolvedPoolAccountEligible(input: {
  resolved: {
    key: {
      id: string
      providerId: string
      routingMode: string
      accountScope?: VirtualApiKeyRecord["accountScope"] | null
    }
    account: StoredAccount
  }
  sessionId?: string | null
  routingHints?: ProviderRoutingHints
  requestedModel?: string | null
}) {
  const availability = resolveAutomaticAccountAvailability({ account: input.resolved.account })
  const modelEligible = accountCanUseRequestedModel(input.resolved.account, input.requestedModel)
  if (input.resolved.key.routingMode !== "pool") {
    return availability.ok && modelEligible ? input.resolved : null
  }

  const preferredPlanCohort = resolvePreferredPlanCohortForVirtualKey({
    key: input.resolved.key,
    requestedModel: input.requestedModel,
    account: input.resolved.account,
    routingHints: input.routingHints ?? null,
  })
  const routingHints =
    input.routingHints ??
    buildProviderRoutingHintsForVirtualKey(input.resolved.key, input.requestedModel, Date.now(), {
      preferredPlanCohort,
    })
  const excluded = new Set<string>(routingHints.excludeAccountIds)
  const currentAccountIsDeprioritized = routingHints.deprioritizedAccountIds.includes(input.resolved.account.id)
  if (!availability.ok || !modelEligible || currentAccountIsDeprioritized) {
    excluded.add(input.resolved.account.id)
  }
  if (!excluded.has(input.resolved.account.id)) {
    return input.resolved
  }

  const failedAccountId = input.resolved.account.id
  let reroutedAccount = rerouteResolvedPoolAccount({
    resolved: input.resolved,
    sessionId: input.sessionId,
    routingHints: {
      excludeAccountIds: [...excluded],
      deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
      headroomByAccountId: routingHints.headroomByAccountId,
      pressureScoreByAccountId: routingHints.pressureScoreByAccountId,
      preferredPlanCohort,
      allowedPlanCohorts: routingHints.allowedPlanCohorts,
    },
  })
  if (!reroutedAccount) {
    const relaxedHints = buildRelaxedProviderRoutingHintsForVirtualKey(input.resolved.key, input.requestedModel, Date.now(), {
      preferredPlanCohort,
    })
    const relaxedExcluded = new Set(relaxedHints.excludeAccountIds)
    const currentAccountIsRelaxedDeprioritized = relaxedHints.deprioritizedAccountIds.includes(input.resolved.account.id)
    if (!availability.ok || !modelEligible || currentAccountIsRelaxedDeprioritized) {
      relaxedExcluded.add(input.resolved.account.id)
    }
    if (!relaxedExcluded.has(input.resolved.account.id)) {
      return input.resolved
    }
    reroutedAccount = rerouteResolvedPoolAccount({
      resolved: input.resolved,
      sessionId: input.sessionId,
      routingHints: relaxedHints,
    })
  }

  if (!reroutedAccount) return null
  emitServerEvent("virtual-key-failover", {
    type: "virtual-key-failover",
    at: Date.now(),
    keyId: input.resolved.key.id,
    sessionId: input.sessionId ?? null,
    fromAccountId: failedAccountId,
    toAccountId: reroutedAccount.id,
    reason: resolveAccountRoutingExclusionReason(failedAccountId),
  })
  return {
    key: input.resolved.key,
    account: reroutedAccount,
  }
}

async function ensureResolvedPoolAccountConsistent(input: {
  resolved: {
    key: {
      id: string
      providerId: string
      routingMode: string
      accountScope?: VirtualApiKeyRecord["accountScope"] | null
    }
    account: StoredAccount
  }
  sessionId?: string | null
  requestedModel?: string | null
}) {
  if (input.resolved.key.routingMode !== "pool") {
    return accountCanUseRequestedModel(input.resolved.account, input.requestedModel)
      ? { ok: true as const, resolved: input.resolved }
      : { ok: false as const, type: "noHealthy" as const }
  }
  const stickySessionId = normalizeSessionRouteID(input.sessionId)
  const currentRoutingHints = buildProviderRoutingHintsForVirtualKey(
    input.resolved.key,
    input.requestedModel,
    Date.now(),
  )
  const resolvedPlanCohort = resolveAccountPlanCohort(input.resolved.account)
  const preferredPlanCohort = resolvePreferredPlanCohortForVirtualKey({
    key: input.resolved.key,
    requestedModel: input.requestedModel,
    account: input.resolved.account,
    routingHints: currentRoutingHints,
  })
  if (
    stickySessionId &&
    accountStore.hasEstablishedVirtualKeySessionRoute({
      keyId: input.resolved.key.id,
      sessionId: stickySessionId,
      accountId: input.resolved.account.id,
    })
  ) {
    if (!preferredPlanCohort || resolvedPlanCohort === preferredPlanCohort) {
      return { ok: true as const, resolved: input.resolved }
    }
  }
  const cachedPoolConsistency = getCachedPoolConsistencyResult(input.resolved.key.providerId, Date.now(), {
    preferredPlanCohort,
  })
  if (!cachedPoolConsistency) {
    refreshProviderPoolConsistencyInBackground(input.resolved.key.providerId, preferredPlanCohort)
    const rerouted = ensureResolvedPoolAccountEligible({
      resolved: input.resolved,
      sessionId: input.sessionId,
      requestedModel: input.requestedModel,
      routingHints: currentRoutingHints.preferredPlanCohort === preferredPlanCohort
        ? currentRoutingHints
        : buildProviderRoutingHintsForVirtualKey(input.resolved.key, input.requestedModel, Date.now(), {
            preferredPlanCohort,
          }),
    })
    return { ok: true as const, resolved: rerouted ?? input.resolved }
  }
  if (!cachedPoolConsistency.ok) {
    refreshProviderPoolConsistencyInBackground(input.resolved.key.providerId, preferredPlanCohort)
    return { ok: true as const, resolved: input.resolved }
  }
  const rerouted = ensureResolvedPoolAccountEligible({
    resolved: input.resolved,
    sessionId: input.sessionId,
    requestedModel: input.requestedModel,
    routingHints: currentRoutingHints.preferredPlanCohort === preferredPlanCohort
      ? currentRoutingHints
      : buildProviderRoutingHintsForVirtualKey(input.resolved.key, input.requestedModel, Date.now(), {
          preferredPlanCohort,
        }),
  })
  if (!rerouted) {
    return { ok: false as const, type: "noHealthy" as const }
  }
  return { ok: true as const, resolved: rerouted }
}

type JsonRequestBodyAnalysis = {
  parsedRoot: Record<string, unknown> | null
  model: string | null
  sessionId: string | null
  reasoningEffort: string | null
  decodedBody: Uint8Array | null
  contentEncoding: string | null
  decodeError: string | null
}

function normalizeContentEncodings(value?: string | null) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0 && item !== "identity")
}

function toUint8Array(value: Uint8Array) {
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
}

function decodeRequestBodyByContentEncoding(body: Uint8Array, contentEncoding?: string | null) {
  const encodings = normalizeContentEncodings(contentEncoding)
  if (encodings.length === 0) {
    return {
      body,
      contentEncoding: null,
      error: null,
    }
  }

  try {
    let current = body
    for (const encoding of [...encodings].reverse()) {
      if (encoding === "gzip" || encoding === "x-gzip") {
        current = toUint8Array(zlib.gunzipSync(current))
        continue
      }
      if (encoding === "deflate") {
        current = toUint8Array(zlib.inflateSync(current))
        continue
      }
      if (encoding === "br") {
        current = toUint8Array(zlib.brotliDecompressSync(current))
        continue
      }
      if (encoding === "zstd") {
        const zstdDecompressSync = (zlib as typeof zlib & { zstdDecompressSync?: (input: Uint8Array) => Uint8Array })
          .zstdDecompressSync
        if (!zstdDecompressSync) {
          return {
            body,
            contentEncoding: encodings.join(","),
            error: "unsupported_content_encoding_zstd",
          }
        }
        current = toUint8Array(zstdDecompressSync(current))
        continue
      }
      return {
        body,
        contentEncoding: encodings.join(","),
        error: `unsupported_content_encoding_${encoding}`,
      }
    }
    return {
      body: current,
      contentEncoding: encodings.join(","),
      error: null,
    }
  } catch (error) {
    return {
      body,
      contentEncoding: encodings.join(","),
      error: `content_encoding_decode_failed:${errorMessage(error)}`,
    }
  }
}

function tryParseJsonObjectBody(input: { body?: Uint8Array; contentEncoding?: string | null }) {
  if (!input.body || input.body.byteLength === 0) {
    return {
      parsedRoot: null,
      decodedBody: null,
      contentEncoding: null,
      decodeError: null,
    }
  }

  const decoded = decodeRequestBodyByContentEncoding(input.body, input.contentEncoding)

  try {
    const text = new TextDecoder().decode(decoded.body)
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        parsedRoot: null,
        decodedBody: decoded.body,
        contentEncoding: decoded.contentEncoding,
        decodeError: decoded.error,
      }
    }
    return {
      parsedRoot: parsed as Record<string, unknown>,
      decodedBody: decoded.body,
      contentEncoding: decoded.contentEncoding,
      decodeError: decoded.error,
    }
  } catch {
    return {
      parsedRoot: null,
      decodedBody: decoded.body,
      contentEncoding: decoded.contentEncoding,
      decodeError: decoded.error,
    }
  }
}

function extractRequestModelFromRoot(root: Record<string, unknown>) {
  const configRecord = asRecord(root.config)
  const modelConfigRecord = asRecord(root.model_config ?? root.modelConfig)
  return (
    extractModelID(
      pickFirstDefinedValue(
        root.model,
        root.model_slug,
        root.modelSlug,
        root.model_id,
        root.modelId,
        readFirstValue(configRecord, ["model", "model_slug", "modelSlug", "model_id", "modelId"]),
        readFirstValue(modelConfigRecord, ["model", "model_slug", "modelSlug", "model_id", "modelId"]),
      ),
    ) ?? null
  )
}

function analyzeJsonRequestBody(input: {
  body?: Uint8Array
  contentType?: string | null
  contentEncoding?: string | null
}): JsonRequestBodyAnalysis {
  const parsed = tryParseJsonObjectBody({
    body: input.body,
    contentEncoding: input.contentEncoding,
  })
  const parsedRoot = parsed.parsedRoot
  if (!parsedRoot) {
    return {
      parsedRoot: null,
      model: null,
      sessionId: null,
      reasoningEffort: null,
      decodedBody: parsed.decodedBody,
      contentEncoding: parsed.contentEncoding,
      decodeError: parsed.decodeError,
    }
  }

  const root = parsedRoot
  const model = extractRequestModelFromRoot(root)
  const sessionCandidates = [
    root.session_id,
    root.sessionId,
    root.prompt_cache_key,
    root.promptCacheKey,
    root.thread_id,
    root.threadId,
    root.conversation,
    root.conversation_id,
    root.conversationId,
    root.previous_response_id,
    root.previousResponseId,
  ]
  const sessionId =
    sessionCandidates.find((value) => typeof value === "string" && String(value).trim().length > 0)?.toString() ?? null
  const configRecord = asRecord(root.config)
  const reasoningEffort = normalizeReasoningEffort(
    pickFirstDefinedValue(
      root.reasoning_effort,
      root.reasoningEffort,
      root.model_reasoning_effort,
      root.modelReasoningEffort,
      root.effort,
      readFirstValue(configRecord, [
        "reasoning_effort",
        "reasoningEffort",
        "model_reasoning_effort",
        "modelReasoningEffort",
        "effort",
      ]),
      root.reasoning,
    ),
  )
  return {
    parsedRoot: root,
    model,
    sessionId,
    reasoningEffort,
    decodedBody: parsed.decodedBody,
    contentEncoding: parsed.contentEncoding,
    decodeError: parsed.decodeError,
  }
}

function parseAuditRequestFields(input: { body: Uint8Array; contentType?: string | null; contentEncoding?: string | null }) {
  const analysis = analyzeJsonRequestBody(input)
  return {
    model: analysis.model,
    sessionId: analysis.sessionId,
    reasoningEffort: analysis.reasoningEffort,
  }
}

function isEventStreamContentType(contentType?: string | null) {
  return String(contentType ?? "")
    .toLowerCase()
    .includes("text/event-stream")
}

function extractUsageFromJsonLineText(text: string) {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
  let latestUsage = emptyUsageMetrics()
  let matched = false

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim()
    if (!line || line === "[DONE]" || line.startsWith("event:")) continue
    const candidate = line.replace(/^data:\s*/, "").trim()
    if (!candidate || candidate === "[DONE]") continue
    const payload = tryParseJsonText(candidate)
    if (payload === undefined) continue
    matched = true
    const usage = extractUsageFromUnknown(payload)
    if (hasUsageDelta(usage)) latestUsage = usage
  }

  return { usage: latestUsage, matched }
}

async function extractUsageFromStructuredResponseText(text: string) {
  const directPayload = tryParseJsonText(text)
  if (directPayload !== undefined) {
    const directUsage = extractUsageFromUnknown(directPayload)
    return { usage: directUsage, matched: true }
  }

  const looksLikeEventStream = /(^|\n)(event:|data:)/.test(
    String(text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n"),
  )
  try {
    const { payload, usage: streamUsage } = await readCodexStream(new Response(text))
    const usage = hasUsageDelta(streamUsage) ? streamUsage : extractUsageFromUnknown(payload)
    if (looksLikeEventStream) return { usage, matched: true }
  } catch {
    // fall through to line-based parsing
  }

  const lineUsage = extractUsageFromJsonLineText(text)
  if (lineUsage.matched) return lineUsage

  return {
    usage: emptyUsageMetrics(),
    matched: false,
  }
}

function buildUpstreamProxyUrl(requestUrl: string, upstreamPath: string) {
  const upstream = new URL(`${CODEX_API_BASE}${upstreamPath}`)
  try {
    const incoming = new URL(requestUrl)
    appendSanitizedUpstreamQueryParams({
      incoming,
      upstream,
      strictPrivacy: isStrictUpstreamPrivacyEnabled(),
    })
  } catch {
    // ignore malformed request URL and fall back to upstream base path
  }
  return upstream.toString()
}

function buildUpstreamAbsoluteUrl(requestUrl: string, upstreamEndpoint: string, options?: { accountId?: string | null }) {
  const upstream = new URL(upstreamEndpoint)
  try {
    const incoming = new URL(requestUrl)
    appendSanitizedUpstreamQueryParams({
      incoming,
      upstream,
      strictPrivacy: isStrictUpstreamPrivacyEnabled(),
      accountId: options?.accountId,
    })
  } catch {
    // ignore malformed request URL and fall back to upstream endpoint
  }
  return upstream.toString()
}

function resolveResponsesUpstreamEndpoint(responsesEndpoint: string, upstreamPath: string) {
  const normalizedPath = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`
  const normalized = trimTrailingSlash(responsesEndpoint)
  if (normalizedPath === "/responses") return normalized
  if (normalized.endsWith("/responses")) {
    return `${normalized.slice(0, -"/responses".length)}${normalizedPath}`
  }
  return `${normalized}${normalizedPath}`
}

function parseHeaderNumber(value?: string | null) {
  const numeric = Number(value ?? "")
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.floor(numeric))
}

function usageHasTokenOrCostMetrics(usage: UsageMetrics) {
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    usage.totalTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.reasoningOutputTokens > 0 ||
    usage.estimatedCostUsd !== null
  )
}

function normalizeUsageFromAuditInput(input: RequestAuditCompatInput): UsageMetrics {
  const base = input.usage ? { ...emptyUsageMetrics(), ...input.usage } : emptyUsageMetrics()
  const promptTokens = base.promptTokens || normalizeNonNegativeInt(input.promptTokens)
  const completionTokens = base.completionTokens || normalizeNonNegativeInt(input.completionTokens)
  const totalCandidate = base.totalTokens || normalizeNonNegativeInt(input.totalTokens)
  return withEstimatedUsageCost({
    promptTokens,
    completionTokens,
    totalTokens: totalCandidate > 0 ? totalCandidate : promptTokens + completionTokens,
    cachedInputTokens: base.cachedInputTokens || normalizeNonNegativeInt(input.cachedInputTokens),
    reasoningOutputTokens: base.reasoningOutputTokens || normalizeNonNegativeInt(input.reasoningOutputTokens),
    estimatedCostUsd:
      base.estimatedCostUsd !== null
        ? base.estimatedCostUsd
        : normalizeNullableNonNegativeNumber(input.estimatedCostUsd) ?? null,
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort ?? base.reasoningEffort),
  }, input.model ?? null)
}

function rememberRequestAuditOverlay(auditId: string, overlay: Partial<RequestAuditOverlay>) {
  if (!auditId) return
  const current = requestAuditOverlays.get(auditId) ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    estimatedCostUsd: null,
    reasoningEffort: null,
    updatedAt: 0,
  }
  requestAuditOverlays.set(auditId, {
    promptTokens:
      overlay.promptTokens !== undefined ? normalizeNonNegativeInt(overlay.promptTokens) : current.promptTokens,
    completionTokens:
      overlay.completionTokens !== undefined ? normalizeNonNegativeInt(overlay.completionTokens) : current.completionTokens,
    totalTokens: overlay.totalTokens !== undefined ? normalizeNonNegativeInt(overlay.totalTokens) : current.totalTokens,
    cachedInputTokens:
      overlay.cachedInputTokens !== undefined ? normalizeNonNegativeInt(overlay.cachedInputTokens) : current.cachedInputTokens,
    reasoningOutputTokens:
      overlay.reasoningOutputTokens !== undefined
        ? normalizeNonNegativeInt(overlay.reasoningOutputTokens)
        : current.reasoningOutputTokens,
    estimatedCostUsd:
      overlay.estimatedCostUsd !== undefined
        ? normalizeNullableNonNegativeNumber(overlay.estimatedCostUsd)
        : current.estimatedCostUsd,
    reasoningEffort:
      overlay.reasoningEffort !== undefined
        ? normalizeReasoningEffort(overlay.reasoningEffort)
        : current.reasoningEffort,
    updatedAt: Math.max(current.updatedAt, normalizeNonNegativeInt(overlay.updatedAt), Date.now()),
  })

  while (requestAuditOverlays.size > REQUEST_AUDIT_OVERLAY_LIMIT) {
    const oldestKey = requestAuditOverlays.keys().next().value
    if (!oldestKey) break
    requestAuditOverlays.delete(oldestKey)
  }
}

function buildRequestTokenStatPayload(auditId: string, input: RequestAuditCompatInput) {
  const usage = normalizeUsageFromAuditInput(input)
  if (!usageHasTokenOrCostMetrics(usage)) return null
  const normalizedReasoningEffort = normalizeReasoningEffort(input.reasoningEffort ?? usage.reasoningEffort)
  const billableTokens = Math.max(0, usage.promptTokens - usage.cachedInputTokens) + Math.max(0, usage.completionTokens)
  return {
    requestAuditId: auditId,
    requestLogId: auditId,
    auditId,
    id: auditId,
    keyId: input.virtualKeyId ?? null,
    virtualKeyId: input.virtualKeyId ?? null,
    accountId: input.accountId ?? null,
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    sessionId: input.sessionId ?? null,
    inputTokens: usage.promptTokens,
    promptTokens: usage.promptTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.completionTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    billableTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    reasoningEffort: normalizedReasoningEffort,
    createdAt: Date.now(),
  }
}

function persistRequestTokenStatCompat(auditId: string, input: RequestAuditCompatInput) {
  const payload = buildRequestTokenStatPayload(auditId, input)
  if (!payload) return

  const compatStore = accountStore as any
  const methodNames = [
    "addRequestTokenStat",
    "addRequestTokenStats",
    "recordRequestTokenStat",
    "recordRequestTokenStats",
    "upsertRequestTokenStat",
    "attachRequestAuditUsage",
    "updateRequestAuditUsage",
  ]

  for (const methodName of methodNames) {
    if (typeof compatStore[methodName] !== "function") continue
    try {
      compatStore[methodName](payload)
    } catch (error) {
      console.warn(
        `[oauth-multi-login] request token stat persist failed method=${methodName} audit=${auditId} reason=${errorMessage(error)}`,
      )
    }
    return
  }
}

function writeRequestAuditCompat(input: RequestAuditCompatInput) {
  const usage = normalizeUsageFromAuditInput(input)
  const normalizedReasoningEffort = normalizeReasoningEffort(input.reasoningEffort ?? usage.reasoningEffort)
  const auditId = String(
    accountStore.addRequestAudit({
      ...input,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedInputTokens: usage.cachedInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      reasoningEffort: normalizedReasoningEffort,
    } as any) ?? "",
  )

  if (!auditId) return auditId

  if (usageHasTokenOrCostMetrics(usage) || normalizedReasoningEffort) {
    rememberRequestAuditOverlay(auditId, {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cachedInputTokens: usage.cachedInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      reasoningEffort: normalizedReasoningEffort,
      updatedAt: Date.now(),
    })
  }

  persistRequestTokenStatCompat(auditId, {
    ...input,
    usage: {
      ...usage,
      reasoningEffort: normalizedReasoningEffort,
    },
  })

  return auditId
}

function updateRequestAuditUsageCompat(input: {
  auditId: string
  accountId?: string | null
  providerId?: string | null
  virtualKeyId?: string | null
  model?: string | null
  sessionId?: string | null
  reasoningEffort?: string | null
  usage: UsageMetrics
}) {
  if (!input.auditId) return
  const normalizedReasoningEffort = normalizeReasoningEffort(input.reasoningEffort ?? input.usage.reasoningEffort)
  rememberRequestAuditOverlay(input.auditId, {
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    cachedInputTokens: input.usage.cachedInputTokens,
    reasoningOutputTokens: input.usage.reasoningOutputTokens,
    estimatedCostUsd: input.usage.estimatedCostUsd,
    reasoningEffort: normalizedReasoningEffort,
    updatedAt: Date.now(),
  })
  persistRequestTokenStatCompat(input.auditId, {
    route: "",
    method: "",
    accountId: input.accountId ?? null,
    providerId: input.providerId ?? null,
    virtualKeyId: input.virtualKeyId ?? null,
    model: input.model ?? null,
    sessionId: input.sessionId ?? null,
    reasoningEffort: normalizedReasoningEffort,
    usage: {
      ...input.usage,
      reasoningEffort: normalizedReasoningEffort,
    },
  })
}

function normalizeAuditText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
}

function matchesAuditText(value: unknown, needle: string) {
  if (!needle) return true
  return normalizeAuditText(value).includes(needle)
}

function matchesAuditStatus(statusCode: number, filterValue: string) {
  if (!filterValue) return true
  const terms = filterValue
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  if (terms.length === 0) return true

  return terms.some((term) => {
    if (/^\d{3}$/.test(term)) return statusCode === Number(term)
    if (/^[1-5]xx$/.test(term)) return String(statusCode).startsWith(term[0] ?? "")
    if (term === "ok") return statusCode >= 200 && statusCode < 400
    if (term === "error") return statusCode >= 400
    if (term === "success") return statusCode >= 200 && statusCode < 300
    return false
  })
}

function parseBooleanQueryFlag(value?: string | null) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
  if (!normalized) return null
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true
  if (normalized === "0" || normalized === "false" || normalized === "no") return false
  return null
}

function normalizeAuditLog(input: unknown) {
  const raw = asRecord(input) ?? {}
  const overlay = typeof raw.id === "string" ? requestAuditOverlays.get(raw.id) : undefined
  const promptTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(raw.promptTokens, raw.prompt_tokens, raw.inputTokens, raw.input_tokens, overlay?.promptTokens),
  )
  const completionTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      raw.completionTokens,
      raw.completion_tokens,
      raw.outputTokens,
      raw.output_tokens,
      overlay?.completionTokens,
    ),
  )
  const totalCandidate = normalizeNonNegativeInt(
    pickFirstDefinedValue(raw.totalTokens, raw.total_tokens, overlay?.totalTokens),
  )
  const totalTokens = totalCandidate > 0 ? totalCandidate : promptTokens + completionTokens
  const cachedInputTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      raw.cachedInputTokens,
      raw.cached_input_tokens,
      raw.cachedTokens,
      raw.cached_tokens,
      overlay?.cachedInputTokens,
    ),
  )
  const reasoningOutputTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(
      raw.reasoningOutputTokens,
      raw.reasoning_output_tokens,
      raw.reasoningTokens,
      raw.reasoning_tokens,
      overlay?.reasoningOutputTokens,
    ),
  )
  const estimatedCostUsd =
    normalizeNullableNonNegativeNumber(
      pickFirstDefinedValue(raw.estimatedCostUsd, raw.estimated_cost_usd, raw.costUsd, raw.cost_usd, overlay?.estimatedCostUsd),
    ) ?? null
  const reasoningEffort = normalizeReasoningEffort(
    pickFirstDefinedValue(raw.reasoningEffort, raw.reasoning_effort, overlay?.reasoningEffort),
  )
  const statusCode = normalizeNonNegativeInt(pickFirstDefinedValue(raw.statusCode, raw.status_code))
  const latencyMs = normalizeNonNegativeInt(pickFirstDefinedValue(raw.latencyMs, raw.latency_ms, raw.durationMs, raw.duration_ms))
  const route = String(pickFirstDefinedValue(raw.route, raw.requestPath, raw.request_path) ?? "")
  const method = String(raw.method ?? "").trim().toUpperCase()

  return {
    ...raw,
    id: String(raw.id ?? ""),
    at: normalizeNonNegativeInt(raw.at),
    route,
    requestPath: route,
    method,
    providerId: normalizeNullableString(pickFirstDefinedValue(raw.providerId, raw.provider_id), 160),
    accountId: normalizeNullableString(pickFirstDefinedValue(raw.accountId, raw.account_id), 200),
    virtualKeyId: normalizeNullableString(pickFirstDefinedValue(raw.virtualKeyId, raw.virtual_key_id, raw.keyId, raw.key_id), 200),
    keyId: normalizeNullableString(pickFirstDefinedValue(raw.virtualKeyId, raw.virtual_key_id, raw.keyId, raw.key_id), 200),
    model: normalizeNullableString(raw.model, 200),
    sessionId: normalizeNullableString(pickFirstDefinedValue(raw.sessionId, raw.session_id), 240),
    requestHash: normalizeNullableString(pickFirstDefinedValue(raw.requestHash, raw.request_hash), 128),
    requestBytes: normalizeNonNegativeInt(pickFirstDefinedValue(raw.requestBytes, raw.request_bytes)),
    responseBytes: normalizeNonNegativeInt(pickFirstDefinedValue(raw.responseBytes, raw.response_bytes)),
    statusCode,
    statusFamily: statusCode >= 100 ? `${String(statusCode)[0]}xx` : "other",
    latencyMs,
    durationMs: latencyMs,
    upstreamRequestId: normalizeNullableString(pickFirstDefinedValue(raw.upstreamRequestId, raw.upstream_request_id), 240),
    error: normalizeNullableString(raw.error ?? raw.error_text, 2000),
    hasError: Boolean(normalizeNullableString(raw.error ?? raw.error_text, 2000)),
    clientTag: normalizeNullableString(pickFirstDefinedValue(raw.clientTag, raw.client_tag), 240),
    inputTokens: promptTokens,
    promptTokens,
    outputTokens: completionTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    estimatedCostUsd,
    reasoningEffort,
  }
}

function matchesAuditQuery(log: ReturnType<typeof normalizeAuditLog>, query: string) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase()
  if (!normalizedQuery) return true

  const fulltext = [
    log.id,
    log.route,
    log.method,
    log.providerId,
    log.accountId,
    log.virtualKeyId,
    log.model,
    log.sessionId,
    log.requestHash,
    log.upstreamRequestId,
    log.error,
    log.clientTag,
    log.reasoningEffort,
    log.statusCode,
  ]
    .map((item) => String(item ?? ""))
    .join(" ")
    .toLowerCase()

  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => {
      const separatorIndex = token.indexOf(":")
      if (separatorIndex <= 0) return fulltext.includes(token)

      const prefix = token.slice(0, separatorIndex)
      const term = token.slice(separatorIndex + 1)
      if (!term) return true

      switch (prefix) {
        case "route":
        case "path":
          return matchesAuditText(log.route, term)
        case "method":
          return matchesAuditText(log.method, term)
        case "provider":
        case "providerid":
          return matchesAuditText(log.providerId, term)
        case "account":
        case "accountid":
          return matchesAuditText(log.accountId, term)
        case "key":
        case "keyid":
          return matchesAuditText(log.virtualKeyId, term)
        case "model":
          return matchesAuditText(log.model, term)
        case "session":
        case "sessionid":
          return matchesAuditText(log.sessionId, term)
        case "client":
        case "clienttag":
          return matchesAuditText(log.clientTag, term)
        case "hash":
        case "trace":
          return matchesAuditText(log.requestHash, term) || matchesAuditText(log.id, term)
        case "error":
          return matchesAuditText(log.error, term)
        case "status":
          return matchesAuditStatus(log.statusCode, term)
        default:
          return fulltext.includes(token)
      }
    })
}

function sortAuditLogs(logs: ReturnType<typeof normalizeAuditLog>[], sortValue: string) {
  const sorted = [...logs]
  switch (sortValue) {
    case "oldest":
      sorted.sort((a, b) => a.at - b.at)
      return sorted
    case "latency_desc":
      sorted.sort((a, b) => b.latencyMs - a.latencyMs || b.at - a.at)
      return sorted
    case "latency_asc":
      sorted.sort((a, b) => a.latencyMs - b.latencyMs || b.at - a.at)
      return sorted
    case "status_desc":
      sorted.sort((a, b) => b.statusCode - a.statusCode || b.at - a.at)
      return sorted
    case "status_asc":
      sorted.sort((a, b) => a.statusCode - b.statusCode || b.at - a.at)
      return sorted
    default:
      sorted.sort((a, b) => b.at - a.at)
      return sorted
  }
}

function buildAuditSummary(logs: ReturnType<typeof normalizeAuditLog>[]) {
  const uniqueAccounts = new Set<string>()
  const uniqueKeys = new Set<string>()
  const uniqueModels = new Set<string>()
  let success = 0
  let clientError = 0
  let serverError = 0
  let other = 0
  let latencyTotal = 0
  let maxLatencyMs = 0
  let requestBytes = 0
  let responseBytes = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedInputTokens = 0
  let reasoningOutputTokens = 0
  let estimatedCostUsd = 0
  let oldestAt = 0
  let newestAt = 0

  for (const log of logs) {
    if (log.accountId) uniqueAccounts.add(log.accountId)
    if (log.virtualKeyId) uniqueKeys.add(log.virtualKeyId)
    if (log.model) uniqueModels.add(log.model)

    if (log.statusCode >= 200 && log.statusCode < 400) success += 1
    else if (log.statusCode >= 400 && log.statusCode < 500) clientError += 1
    else if (log.statusCode >= 500) serverError += 1
    else other += 1

    latencyTotal += log.latencyMs
    maxLatencyMs = Math.max(maxLatencyMs, log.latencyMs)
    requestBytes += log.requestBytes
    responseBytes += log.responseBytes
    promptTokens += log.promptTokens
    completionTokens += log.completionTokens
    totalTokens += log.totalTokens
    cachedInputTokens += log.cachedInputTokens
    reasoningOutputTokens += log.reasoningOutputTokens
    estimatedCostUsd += log.estimatedCostUsd ?? 0
    if (oldestAt === 0 || (log.at > 0 && log.at < oldestAt)) oldestAt = log.at
    newestAt = Math.max(newestAt, log.at)
  }

  return {
    total: logs.length,
    success,
    clientError,
    serverError,
    error: clientError + serverError,
    other,
    avgLatencyMs: logs.length > 0 ? Math.round(latencyTotal / logs.length) : 0,
    maxLatencyMs,
    requestBytes,
    responseBytes,
    inputTokens: promptTokens,
    promptTokens,
    outputTokens: completionTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    estimatedCostUsd,
    uniqueAccounts: uniqueAccounts.size,
    uniqueKeys: uniqueKeys.size,
    uniqueModels: uniqueModels.size,
    oldestAt,
    newestAt,
  }
}

function getNormalizedAuditLogs(limit: number) {
  return accountStore
    .listRequestAudits(Math.min(1000, Math.max(1, Math.floor(limit))))
    .map((item) => normalizeAuditLog(item))
}

function isChatGptOAuthAccount(account: Pick<StoredAccount, "providerId" | "methodId">) {
  const provider = String(account.providerId ?? "")
    .trim()
    .toLowerCase()
  const method = String(account.methodId ?? "")
    .trim()
    .toLowerCase()
  if (method === "api" || method === "api-key") return false
  return provider === "openai" || provider === "chatgpt"
}

function buildPoolRemainingMetrics(now = Date.now()) {
  const primaryValues: number[] = []
  const secondaryValues: number[] = []
  let eligibleAccountCount = 0
  let quotaKnownAccountCount = 0

  for (const account of accountStore.list()) {
    if (!isChatGptOAuthAccount(account)) continue
    const quota = accountQuotaCache.get(account.id) ?? null
    const derived = resolvePublicAccountDerivedState(account.id, quota)
    if (derived.routing.state !== "excluded") eligibleAccountCount += 1
    const primaryRemainPercent = resolveQuotaWindowRemainingPercent(quota, "primary")
    const secondaryRemainPercent = resolveQuotaWindowRemainingPercent(quota, "secondary")
    if (primaryRemainPercent !== null) primaryValues.push(primaryRemainPercent)
    if (secondaryRemainPercent !== null) secondaryValues.push(secondaryRemainPercent)
    if (primaryRemainPercent !== null || secondaryRemainPercent !== null) quotaKnownAccountCount += 1
  }

  const average = (values: number[]) =>
    values.length > 0 ? Math.max(0, Math.min(100, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length))) : null

  return {
    primaryRemainPercent: average(primaryValues),
    secondaryRemainPercent: average(secondaryValues),
    knownPrimaryCount: primaryValues.length,
    knownSecondaryCount: secondaryValues.length,
    eligibleAccountCount,
    quotaKnownAccountCount,
    refreshedAt: now,
  }
}

function buildServiceStatusSummary(now = Date.now()) {
  const serviceInfo = getSafeServiceAddressInfo(AppConfig.host, AppConfig.port)
  return {
    serviceOnline: true,
    activeLocalServiceAddress: serviceInfo.activeLocalServiceAddress,
    bindServiceAddress: serviceInfo.bindServiceAddress,
    preferredClientServiceAddress: serviceInfo.preferredClientServiceAddress,
    lanServiceAddresses: serviceInfo.lanServiceAddresses,
    managementAuthEnabled: Boolean(getEffectiveManagementToken()),
    encryptionKeyConfigured: Boolean(getEffectiveEncryptionKey()),
    upstreamPrivacyStrict: isStrictUpstreamPrivacyEnabled(),
    officialStrictPassthrough: isOfficialStrictPassthroughEnabled(),
    officialAssets: OFFICIAL_ASSETS_STATUS,
    restartRequired: true,
    checkedAt: now,
  }
}

function buildDashboardMetrics() {
  return buildAuditDashboardMetrics({
    listProviders: () => providers.listPublic(),
    listAccounts: () => accountStore.list(),
    listVirtualKeys: () => accountStore.listVirtualApiKeys(),
    getTodaySummary: (now) => accountStore.getTodayRequestTokenStatsSummary(now),
    buildPoolRemainingMetrics,
    resolvePublicAccountDerivedState: (accountId) => {
      const quota = accountQuotaCache.get(accountId) ?? null
      return resolvePublicAccountDerivedState(accountId, quota)
    },
    getUsageTotalsSnapshot,
    buildServiceStatusSummary,
    statsTimezone: STATS_TIMEZONE,
    pricingMode: PRICING_MODE,
    pricingCatalogVersion: PRICING_CATALOG_VERSION,
  })
}

function syncExtendedUsageTotalsStateFromStore(now = Date.now()) {
  const totals = asRecord(accountStore.getUsageTotals()) ?? {}
  extendedUsageTotalsState.cachedInputTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(totals.cachedInputTokens, totals.cached_input_tokens),
  )
  extendedUsageTotalsState.reasoningOutputTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(totals.reasoningOutputTokens, totals.reasoning_output_tokens),
  )
  extendedUsageTotalsState.estimatedCostUsd =
    normalizeNullableNonNegativeNumber(
      pickFirstDefinedValue(totals.estimatedCostUsd, totals.estimated_cost_usd, totals.costUsd, totals.cost_usd),
    ) ?? 0
  extendedUsageTotalsState.pricedTokens = normalizeNonNegativeInt(
    pickFirstDefinedValue(totals.pricedTokens, totals.priced_tokens),
  )
  extendedUsageTotalsState.updatedAt = Math.max(
    now,
    normalizeNonNegativeInt(pickFirstDefinedValue(totals.updatedAt, totals.updated_at)),
  )
}

function bootstrapEstimatedUsageCosts() {
  const backfillResult = accountStore.backfillRequestAuditEstimatedCosts((audit) =>
    estimateUsageCostUsd({
      model: audit.model,
      promptTokens: audit.inputTokens,
      cachedInputTokens: audit.cachedInputTokens,
      completionTokens: audit.outputTokens,
    }),
  )
  if (typeof (accountStore as any).reconcileGlobalUsageTotals === "function") {
    ;(accountStore as any).reconcileGlobalUsageTotals()
  }
  syncExtendedUsageTotalsStateFromStore()
  if (backfillResult.updatedCount > 0) {
    console.log(
      `[oauth-multi-login] backfilled estimated costs for ${backfillResult.updatedCount}/${backfillResult.scannedCount} request audits`,
    )
  }
}

function cleanupExpiredEventStreamTokens(now = Date.now()) {
  for (const [token, expiresAt] of eventStreamAccessTokens.entries()) {
    if (expiresAt <= now) eventStreamAccessTokens.delete(token)
  }
}

function issueEventStreamToken() {
  cleanupExpiredEventStreamTokens()
  const token = crypto.randomUUID().replace(/-/g, "")
  const expiresAt = Date.now() + EVENT_STREAM_TOKEN_TTL_MS
  eventStreamAccessTokens.set(token, expiresAt)
  return { token, expiresAt }
}

function claimEventStreamToken(token: string) {
  cleanupExpiredEventStreamTokens()
  const expiresAt = eventStreamAccessTokens.get(token)
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    eventStreamAccessTokens.delete(token)
    return false
  }
  eventStreamAccessTokens.delete(token)
  return true
}

function readManagementToken(c: any) {
  const fromHeader = String(c.req.header("x-admin-token") ?? "").trim()
  if (fromHeader) return fromHeader
  return ""
}

function isManagementAuthorized(c: any) {
  const required = getEffectiveManagementToken()
  if (!required) return true
  if (readManagementToken(c) === required) return true

  if (c.req.path === "/api/events" || c.req.path === "/api/events/usage") {
    const eventToken = String(c.req.query("event_token") ?? "").trim()
    if (eventToken && claimEventStreamToken(eventToken)) return true
  }
  return false
}

function hasSensitiveActionConfirmation(c: any) {
  return String(c.req.header("x-sensitive-action") ?? "")
    .trim()
    .toLowerCase() === "confirm"
}

type ModelCatalogPayload = {
  object: "list"
  data: Array<Record<string, unknown>>
  models?: Array<Record<string, unknown>>
}

type ModelsUpstreamPayload = {
  models?: Array<Record<string, unknown>>
  data?: Array<Record<string, unknown>>
}

function getReasoningEffortDescription(effort: string, fallback?: unknown) {
  const explicit = extractModelID(fallback)
  if (explicit) return explicit
  const official = OFFICIAL_CODEX_REASONING_LEVELS.find((item) => item.effort === effort)
  return official?.description ?? effort
}

function normalizeCodexAppReasoningEfforts(source: unknown, fallbackLevels: string[]) {
  const entries = Array.isArray(source) ? source : []
  const result: Array<{ reasoningEffort: string; description: string }> = []
  const seen = new Set<string>()

  const add = (effort: unknown, description?: unknown) => {
    const normalized = extractModelID(effort)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    result.push({
      reasoningEffort: normalized,
      description: getReasoningEffortDescription(normalized, description),
    })
  }

  for (const item of entries) {
    if (typeof item === "string") {
      add(item)
      continue
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>
      add(record.reasoningEffort ?? record.effort, record.description)
    }
  }

  for (const level of fallbackLevels) {
    add(level)
  }

  if (result.length === 0) add("medium")
  return result
}

function normalizeCodexAppInputModalities(...sources: unknown[]) {
  const values: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const item of source) {
      const normalized = extractModelID(item)
      if ((normalized === "text" || normalized === "image") && !seen.has(normalized)) {
        seen.add(normalized)
        values.push(normalized)
      }
    }
  }
  return values.length > 0 ? values : ["text"]
}

function normalizeCodexAppAdditionalSpeedTiers(...sources: unknown[]) {
  const values: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const item of source) {
      const normalized = extractModelID(item)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      values.push(normalized)
    }
  }
  return values
}

function normalizeStringArray(...sources: unknown[]) {
  const values: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const item of source) {
      const normalized = extractModelID(item)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      values.push(normalized)
    }
  }
  return values
}

function normalizeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : null
}

function normalizeInteger(value: unknown, fallback: number) {
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback
}

function normalizeCodexAppAvailabilityNux(...sources: unknown[]) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue
    const message = extractModelID((source as Record<string, unknown>).message)
    if (message) return { message }
  }
  return null
}

function normalizeCodexModelInfoUpgrade(...sources: unknown[]) {
  for (const source of sources) {
    const record = normalizeRecord(source)
    if (!record) continue
    const model = extractModelID(record.model)
    if (!model) continue
    return {
      ...record,
      model,
      migration_markdown: extractModelID(record.migration_markdown ?? record.migrationMarkdown) ?? "",
    }
  }
  return null
}

function normalizeCodexAppUpgradeInfo(...sources: unknown[]) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue
    const record = source as Record<string, unknown>
    const model = extractModelID(record.model)
    if (!model) continue
    return {
      model,
      upgradeCopy: extractModelID(record.upgradeCopy ?? record.upgrade_copy),
      modelLink: extractModelID(record.modelLink ?? record.model_link),
      migrationMarkdown: extractModelID(record.migrationMarkdown ?? record.migration_markdown),
    }
  }
  return null
}

function buildCodexModelInfoCompatFields(input: {
  model?: Record<string, unknown>
  apiMetadata?: Record<string, unknown>
}) {
  const model = input.model ?? {}
  const apiMetadata = input.apiMetadata ?? {}
  return {
    shell_type: extractModelID(model.shell_type ?? apiMetadata.shell_type) ?? "shell_command",
    priority: normalizeInteger(model.priority ?? apiMetadata.priority, 0),
    additional_speed_tiers: normalizeCodexAppAdditionalSpeedTiers(
      model.additional_speed_tiers,
      apiMetadata.additional_speed_tiers,
      model.additionalSpeedTiers,
      apiMetadata.additionalSpeedTiers,
    ),
    availability_nux: normalizeCodexAppAvailabilityNux(
      model.availability_nux,
      apiMetadata.availability_nux,
      model.availabilityNux,
      apiMetadata.availabilityNux,
    ),
    upgrade: normalizeCodexModelInfoUpgrade(model.upgrade, apiMetadata.upgrade),
    base_instructions: extractModelID(model.base_instructions ?? apiMetadata.base_instructions) ?? CHAT_INSTRUCTIONS,
    truncation_policy:
      normalizeRecord(model.truncation_policy ?? apiMetadata.truncation_policy) ?? { mode: "tokens", limit: 10000 },
    experimental_supported_tools: normalizeStringArray(
      model.experimental_supported_tools,
      apiMetadata.experimental_supported_tools,
    ),
    input_modalities: normalizeCodexAppInputModalities(
      model.input_modalities,
      apiMetadata.input_modalities,
      model.inputModalities,
      apiMetadata.inputModalities,
    ),
    supports_image_detail_original:
      model.supports_image_detail_original === true || apiMetadata.supports_image_detail_original === true,
    apply_patch_tool_type: extractModelID(model.apply_patch_tool_type ?? apiMetadata.apply_patch_tool_type),
    web_search_tool_type: extractModelID(model.web_search_tool_type ?? apiMetadata.web_search_tool_type) ?? "text",
    supports_search_tool: model.supports_search_tool === true || apiMetadata.supports_search_tool === true,
  }
}

function buildCodexAppModelCompatFields(input: {
  id: string
  model?: Record<string, unknown>
  apiMetadata?: Record<string, unknown>
  displayName: string
  description: string | null
  visibility: string
  defaultReasoningLevel: string
  reasoningLevelsPayload: unknown
  fallbackReasoningLevels: string[]
}) {
  const model = input.model ?? {}
  const apiMetadata = input.apiMetadata ?? {}
  const defaultReasoningEffort =
    extractModelID(model.defaultReasoningEffort ?? apiMetadata.defaultReasoningEffort) ?? input.defaultReasoningLevel
  const upgrade = extractModelID(model.upgrade ?? apiMetadata.upgrade)
  return {
    model: input.id,
    displayName: extractModelID(model.displayName ?? apiMetadata.displayName) ?? input.displayName,
    hidden: (extractModelID(model.visibility ?? apiMetadata.visibility) ?? input.visibility).toLowerCase() === "hide",
    supportedReasoningEfforts: normalizeCodexAppReasoningEfforts(
      model.supportedReasoningEfforts ?? apiMetadata.supportedReasoningEfforts ?? input.reasoningLevelsPayload,
      input.fallbackReasoningLevels,
    ),
    defaultReasoningEffort,
    inputModalities: normalizeCodexAppInputModalities(
      model.inputModalities,
      apiMetadata.inputModalities,
      apiMetadata.input_modalities,
    ),
    supportsPersonality: model.supportsPersonality !== false && apiMetadata.supportsPersonality !== false,
    additionalSpeedTiers: normalizeCodexAppAdditionalSpeedTiers(
      model.additionalSpeedTiers,
      apiMetadata.additionalSpeedTiers,
      apiMetadata.additional_speed_tiers,
    ),
    isDefault: model.isDefault === true || input.id === resolveDefaultChatModelId(),
    upgrade,
    upgradeInfo: normalizeCodexAppUpgradeInfo(model.upgradeInfo, apiMetadata.upgradeInfo, apiMetadata.upgrade_info),
    availabilityNux: normalizeCodexAppAvailabilityNux(
      model.availabilityNux,
      apiMetadata.availabilityNux,
      apiMetadata.availability_nux,
    ),
  }
}

type AccountModelsSnapshot = {
  accountId: string
  clientVersion: string
  fetchedAt: number
  etag: string | null
  contentType: string
  payload: ModelsUpstreamPayload
  entries: Array<Record<string, unknown>>
  body: Uint8Array
}

const MODELS_CACHE_TTL_MS = 300 * 1000
const MODELS_REFRESH_TIMEOUT_MS = 5 * 1000
const accountModelsCache = new Map<string, AccountModelsSnapshot>()
const accountModelsRefreshInFlight = new Map<string, Promise<AccountModelsSnapshot>>()
const POOL_CONSISTENCY_TTL_MS = 60 * 1000
const POOL_CONSISTENCY_OBSERVATION_LOG_TTL_MS = 5 * 60 * 1000
const QUOTA_EXHAUSTED_ACCOUNT_COOLDOWN_MS = 30 * 60 * 1000
const quotaExhaustedAccountCooldown = new Map<string, number>()

type PoolConsistencySuccess = {
  ok: true
  providerId: string
  cohort: AccountPlanCohort | null
  checkedAt: number
  accountCount: number
  eligibleAccountIds: string[]
  excludedAccountIds: string[]
  warnings: string[]
}

type PoolConsistencyFailure = {
  ok: false
  providerId: string
  cohort: AccountPlanCohort | null
  checkedAt: number
  code: "pool_consistency_violation"
  message: string
  details: string[]
}

type PoolConsistencyResult = PoolConsistencySuccess | PoolConsistencyFailure

const poolConsistencyCache = new Map<string, PoolConsistencyResult>()
const poolConsistencyRefreshInFlight = new Map<string, Promise<PoolConsistencyResult>>()
const poolConsistencyObservationLogCache = new Map<
  string,
  {
    fingerprint: string
    loggedAt: number
  }
>()

function extractModelID(value: unknown) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : null
}

function emitPoolConsistencyWarnings(input: {
  providerId: string
  cohort: AccountPlanCohort | null
  eligibleCount: number
  accountCount: number
  excludedAccountIds: string[]
  warnings: string[]
}) {
  if (input.warnings.length === 0) return

  const details = input.warnings.join(" || ")
  const observationOnly =
    input.excludedAccountIds.length === 0 &&
    input.eligibleCount === input.accountCount &&
    input.warnings.every((warning) => warning.includes("no routing exclusion applied"))

  if (observationOnly) {
    const now = Date.now()
    const observationKey = buildPoolConsistencyCacheKey(input.providerId, input.cohort)
    const fingerprint = `${observationKey}:${details}`
    const cached = poolConsistencyObservationLogCache.get(observationKey)
    if (cached && cached.fingerprint === fingerprint && now - cached.loggedAt < POOL_CONSISTENCY_OBSERVATION_LOG_TTL_MS) {
      return
    }
    poolConsistencyObservationLogCache.set(observationKey, {
      fingerprint,
      loggedAt: now,
    })
    console.info(
      `[oauth-multi-login] pool consistency observe provider=${input.providerId} cohort=${input.cohort ?? "all"} eligible=${input.eligibleCount}/${input.accountCount} details=${details}`,
    )
    return
  }

  poolConsistencyObservationLogCache.delete(buildPoolConsistencyCacheKey(input.providerId, input.cohort))
  console.warn(
    `[oauth-multi-login] pool consistency constrained provider=${input.providerId} cohort=${input.cohort ?? "all"} eligible=${input.eligibleCount}/${input.accountCount} details=${details}`,
  )
}

function buildModelCatalogPayload(input: { ids?: string[] } = {}): ModelCatalogPayload {
  const created = Math.floor(Date.now() / 1000)
  const orderedIDs: string[] = []
  const seen = new Set<string>()

  for (const id of input.ids ?? []) {
    const normalized = extractModelID(id)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    orderedIDs.push(normalized)
  }

  if (orderedIDs.length === 0) {
    for (const id of DEFAULT_CHAT_MODELS) {
      if (seen.has(id)) continue
      seen.add(id)
      orderedIDs.push(id)
    }
  }

  const data = orderedIDs.map((id) => {
      const entry = getModelCatalogEntry(id)
      const levels = MODEL_REASONING_LEVELS[id] ?? ["medium"]
      const defaultReasoningLevel = MODEL_DEFAULT_REASONING_LEVELS[id] ?? (levels.includes("medium") ? "medium" : levels[0])
      const apiMetadata = entry?.apiMetadata ?? {}
      const reasoningLevelsPayload = Array.isArray(apiMetadata.supported_reasoning_levels)
        ? apiMetadata.supported_reasoning_levels
        : levels.map((effort) => ({ effort }))
      const displayName = entry?.displayName ?? id
      const description = entry?.description ?? null
      const visibility = MODEL_VISIBILITIES[id] ?? "list"
      return {
        ...apiMetadata,
        id,
        object: "model",
        created,
        owned_by: "openai",
        slug: id,
        display_name: displayName,
        description: description ?? "",
        visibility,
        supported_in_api: entry?.supportedInApi !== false,
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: reasoningLevelsPayload,
        supports_parallel_tool_calls: MODEL_SUPPORTS_PARALLEL_TOOL_CALLS[id] ?? false,
        supports_reasoning_summaries: entry?.supportsReasoningSummaries !== false,
        support_verbosity: entry?.supportVerbosity !== false,
        default_verbosity: entry?.defaultVerbosity ?? null,
        default_reasoning_summary: entry?.defaultReasoningSummary ?? null,
        reasoning_summary_format: entry?.reasoningSummaryFormat ?? null,
        prefer_websockets: entry?.preferWebsockets !== false,
        minimal_client_version: entry?.minimalClientVersion ?? null,
        context_window: entry?.contextWindow ?? null,
        max_context_window: MODEL_MAX_CONTEXT_WINDOWS[id] ?? null,
        ...buildCodexModelInfoCompatFields({
          apiMetadata,
        }),
        ...buildCodexAppModelCompatFields({
          id,
          apiMetadata,
          displayName,
          description,
          visibility,
          defaultReasoningLevel,
          reasoningLevelsPayload,
          fallbackReasoningLevels: levels,
        }),
      }
    })

  return {
    object: "list",
    data,
    models: data,
  }
}

function resolveModelCatalogForCodexMode() {
  return buildModelCatalogPayload({
    ids: [...DEFAULT_CHAT_MODELS],
  })
}

function resolveModelCatalogForCursorMode() {
  const availableIds = CURSOR_STABLE_MODEL_IDS.filter((id) => DEFAULT_CHAT_MODELS.includes(id))
  return buildModelCatalogPayload({
    ids: availableIds,
  })
}

function normalizeCursorStableModelIDs(ids: Iterable<string>) {
  const allowed = new Set<string>(CURSOR_STABLE_MODEL_IDS.filter((id) => DEFAULT_CHAT_MODELS.includes(id)))
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const rawId of ids) {
    const normalized = extractModelID(rawId)
    if (!normalized || !allowed.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    ordered.push(normalized)
  }
  return ordered
}

function extractCursorStableModelIDsFromSnapshot(snapshot?: AccountModelsSnapshot | null) {
  if (!snapshot) return []
  return normalizeCursorStableModelIDs(snapshot.entries.map((entry) => extractModelEntryID(entry) ?? ""))
}

async function resolveModelCatalogForCursorAccount(input: {
  account: StoredAccount
  requestUrl?: string
  requestHeaders?: Headers
  forceRefresh?: boolean
}) {
  try {
    const snapshot = await getModelsSnapshot({
      account: input.account,
      requestUrl: input.requestUrl,
      requestHeaders: input.requestHeaders,
      forceRefresh: input.forceRefresh,
    })
    const availableIds = extractCursorStableModelIDsFromSnapshot(snapshot)
    if (availableIds.length > 0) {
      return buildModelCatalogPayload({
        ids: availableIds,
      })
    }
  } catch {
    // fall through to the static compatibility catalog when models probing fails
  }
  return resolveModelCatalogForCursorMode()
}

function normalizeReasoningLevelsFromModelPayload(model: Record<string, unknown>) {
  const source = model.supported_reasoning_levels
  if (!Array.isArray(source)) return []
  const values = source
    .map((item) => {
      if (typeof item === "string") return extractModelID(item)
      if (item && typeof item === "object") {
        return extractModelID((item as Record<string, unknown>).effort)
      }
      return null
    })
    .filter((item): item is string => Boolean(item))
  return [...new Set(values)]
}

function toOpenAIModelListPayloadFromUpstream(payload: unknown): ModelCatalogPayload {
  const created = Math.floor(Date.now() / 1000)
  const body = payload as Record<string, unknown>
  const entries = Array.isArray(body.data)
    ? (body.data as Array<Record<string, unknown>>)
    : Array.isArray(body.models)
      ? (body.models as Array<Record<string, unknown>>)
      : []

  const data: Array<Record<string, unknown>> = []
  for (const model of entries) {
    const id = extractModelID(model.id ?? model.slug)
    if (!id) continue
    const catalogEntry = getModelCatalogEntry(id)
    const payloadLevels = normalizeReasoningLevelsFromModelPayload(model)
    const catalogLevels = catalogEntry?.supportedReasoningLevels ?? []
    const levels =
      isModelIdOnlyHardcodedOverride(id) && catalogLevels.length > 0
        ? [...new Set([...payloadLevels, ...catalogLevels])]
        : payloadLevels
    const defaultReasoningLevel =
      extractModelID(model.default_reasoning_level ?? model.defaultReasoningLevel) ??
      catalogEntry?.defaultReasoningLevel ??
      (levels.includes("medium") ? "medium" : levels[0] ?? "medium")
    const supportsParallelToolCalls =
      model.supports_parallel_tool_calls !== undefined
        ? model.supports_parallel_tool_calls !== false
        : catalogEntry?.supportsParallelToolCalls !== false
    const supportsReasoningSummaries =
      model.supports_reasoning_summaries !== undefined
        ? model.supports_reasoning_summaries !== false
        : catalogEntry?.supportsReasoningSummaries !== false
    const supportVerbosity =
      model.support_verbosity !== undefined ? model.support_verbosity !== false : catalogEntry?.supportVerbosity !== false
    const defaultVerbosity =
      extractModelID(model.default_verbosity ?? model.defaultVerbosity) ?? catalogEntry?.defaultVerbosity ?? null
    const defaultReasoningSummary =
      extractModelID(model.default_reasoning_summary ?? model.defaultReasoningSummary) ??
      catalogEntry?.defaultReasoningSummary ??
      null
    const reasoningSummaryFormat =
      extractModelID(model.reasoning_summary_format ?? model.reasoningSummaryFormat) ??
      catalogEntry?.reasoningSummaryFormat ??
      null
    const preferWebsockets =
      model.prefer_websockets !== undefined ? model.prefer_websockets !== false : catalogEntry?.preferWebsockets !== false
    const minimalClientVersion =
      extractModelID(model.minimal_client_version ?? model.minimalClientVersion) ?? catalogEntry?.minimalClientVersion ?? null
    const contextWindow = Number.isFinite(Number(model.context_window))
      ? Math.max(0, Math.floor(Number(model.context_window)))
      : (catalogEntry?.contextWindow ?? null)
    const maxContextWindow = Number.isFinite(Number(model.max_context_window))
      ? Math.max(0, Math.floor(Number(model.max_context_window)))
      : (catalogEntry?.maxContextWindow ?? null)
    const displayName = extractModelID(model.display_name ?? model.displayName) ?? catalogEntry?.displayName ?? id
    const description = extractModelID(model.description) ?? catalogEntry?.description ?? null
    const visibility = extractModelID(model.visibility) ?? catalogEntry?.visibility ?? "list"
    const catalogReasoningLevelsPayload = Array.isArray(catalogEntry?.apiMetadata.supported_reasoning_levels)
      ? catalogEntry.apiMetadata.supported_reasoning_levels
      : null
    const reasoningLevelsPayload =
      isModelIdOnlyHardcodedOverride(id) && catalogReasoningLevelsPayload
        ? catalogReasoningLevelsPayload
        : levels.length > 0
          ? levels.map((effort) => ({ effort }))
          : [{ effort: "medium" }]
    data.push({
      ...model,
      id,
      object: extractModelID(model.object) ?? "model",
      created,
      owned_by: extractModelID(model.owned_by ?? model.ownedBy) ?? "openai",
      slug: extractModelID(model.slug) ?? id,
      display_name: displayName,
      description: description ?? "",
      visibility,
      default_reasoning_level: defaultReasoningLevel,
      supported_reasoning_levels: reasoningLevelsPayload,
      supports_parallel_tool_calls: supportsParallelToolCalls,
      supports_reasoning_summaries: supportsReasoningSummaries,
      support_verbosity: supportVerbosity,
      default_verbosity: defaultVerbosity,
      default_reasoning_summary: defaultReasoningSummary,
      reasoning_summary_format: reasoningSummaryFormat,
      prefer_websockets: preferWebsockets,
      minimal_client_version: minimalClientVersion,
      context_window: contextWindow,
      max_context_window: maxContextWindow,
      ...buildCodexModelInfoCompatFields({
        model,
        apiMetadata: catalogEntry?.apiMetadata ?? {},
      }),
      ...buildCodexAppModelCompatFields({
        id,
        model,
        apiMetadata: catalogEntry?.apiMetadata ?? {},
        displayName,
        description,
        visibility,
        defaultReasoningLevel,
        reasoningLevelsPayload,
        fallbackReasoningLevels: levels,
      }),
    })
  }

  const listedIds = new Set(data.map((item) => extractModelID(item.id ?? item.slug)).filter(Boolean))
  for (const id of DEFAULT_CHAT_MODELS) {
    if (!isModelIdOnlyHardcodedOverride(id) || listedIds.has(id)) continue
    const entry = getModelCatalogEntry(id)
    if (!entry || entry.supportedInApi === false || entry.visibility.toLowerCase() === "hide") continue
    const levels = MODEL_REASONING_LEVELS[id] ?? ["medium"]
    const defaultReasoningLevel = MODEL_DEFAULT_REASONING_LEVELS[id] ?? (levels.includes("medium") ? "medium" : levels[0])
    const reasoningLevelsPayload = Array.isArray(entry.apiMetadata.supported_reasoning_levels)
      ? entry.apiMetadata.supported_reasoning_levels
      : levels.map((effort) => ({ effort }))
    data.unshift({
      ...(entry.apiMetadata ?? {}),
      id,
      object: "model",
      created,
      owned_by: "openai",
      slug: id,
      display_name: entry.displayName,
      description: entry.description ?? "",
      visibility: entry.visibility,
      supported_in_api: true,
      default_reasoning_level: defaultReasoningLevel,
      supported_reasoning_levels: reasoningLevelsPayload,
      supports_parallel_tool_calls: entry.supportsParallelToolCalls,
      supports_reasoning_summaries: entry.supportsReasoningSummaries,
      support_verbosity: entry.supportVerbosity,
      default_verbosity: entry.defaultVerbosity ?? null,
      default_reasoning_summary: entry.defaultReasoningSummary ?? null,
      reasoning_summary_format: entry.reasoningSummaryFormat ?? null,
      prefer_websockets: entry.preferWebsockets,
      minimal_client_version: entry.minimalClientVersion ?? null,
      context_window: entry.contextWindow ?? null,
      max_context_window: entry.maxContextWindow ?? null,
      ...buildCodexModelInfoCompatFields({
        apiMetadata: entry.apiMetadata ?? {},
      }),
      ...buildCodexAppModelCompatFields({
        id,
        apiMetadata: entry.apiMetadata ?? {},
        displayName: entry.displayName,
        description: entry.description ?? null,
        visibility: entry.visibility,
        defaultReasoningLevel,
        reasoningLevelsPayload,
        fallbackReasoningLevels: levels,
      }),
    })
    listedIds.add(id)
  }

  if (data.length === 0) {
    return resolveModelCatalogForCodexMode()
  }

  return {
    object: "list",
    data,
    models: data,
  }
}

function extractModelsEntries(payload: unknown) {
  const body = payload as ModelsUpstreamPayload
  if (Array.isArray(body.models)) return body.models
  if (Array.isArray(body.data)) return body.data
  return []
}

function extractModelEntryID(entry: Record<string, unknown>) {
  return extractModelID(entry.slug ?? entry.id ?? entry.name)
}

function buildModelsCacheKey(accountId: string, clientVersion: string) {
  return `${accountId}::${clientVersion}`
}

function isModelsCacheFresh(snapshot: AccountModelsSnapshot | undefined, now = Date.now()) {
  if (!snapshot) return false
  return now - Number(snapshot.fetchedAt || 0) <= MODELS_CACHE_TTL_MS
}

function resolveModelsClientVersion(requestUrl?: string) {
  if (!requestUrl) return CODEX_CLIENT_WHOLE_VERSION
  try {
    const incoming = new URL(requestUrl)
    const queryVersion = String(incoming.searchParams.get("client_version") ?? "").trim()
    if (queryVersion.length > 0) return queryVersion
  } catch {
    // ignore malformed URL and fallback to server version
  }
  return CODEX_CLIENT_WHOLE_VERSION
}

function buildModelsUpstreamUrl(input: { requestUrl?: string; clientVersion: string; modelsEndpoint: string; accountId?: string | null }) {
  const upstream = new URL(input.modelsEndpoint)
  if (input.requestUrl) {
    try {
      const incoming = new URL(input.requestUrl)
      appendSanitizedUpstreamQueryParams({
        incoming,
        upstream,
        strictPrivacy: isStrictUpstreamPrivacyEnabled(),
        accountId: input.accountId,
      })
    } catch {
      // ignore malformed URL and continue with default models endpoint
    }
  }
  if (!upstream.searchParams.has("client_version")) {
    upstream.searchParams.set("client_version", input.clientVersion)
  }
  return upstream
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function evictAccountModelsCache(accountId: string) {
  const prefix = `${accountId}::`
  for (const key of accountModelsCache.keys()) {
    if (key.startsWith(prefix)) accountModelsCache.delete(key)
  }
  for (const key of accountModelsRefreshInFlight.keys()) {
    if (key.startsWith(prefix)) accountModelsRefreshInFlight.delete(key)
  }
}

function invalidatePoolConsistency(
  providerId?: string | null,
  options?: {
    account?: StoredAccount | null
    preferredPlanCohort?: AccountPlanCohort | null
  },
) {
  const normalizedProviderId = normalizeIdentity(providerId)?.toLowerCase()
  if (normalizedProviderId) {
    const preferredPlanCohort =
      options?.preferredPlanCohort ??
      (options?.account ? resolveAccountPlanCohort(options.account) : null)
    if (preferredPlanCohort) {
      const cacheKey = buildPoolConsistencyCacheKey(normalizedProviderId, preferredPlanCohort)
      poolConsistencyCache.delete(cacheKey)
      poolConsistencyRefreshInFlight.delete(cacheKey)
      poolConsistencyObservationLogCache.delete(cacheKey)
      return
    }
    for (const key of [...poolConsistencyCache.keys()]) {
      if (key.startsWith(`${normalizedProviderId}::`)) poolConsistencyCache.delete(key)
    }
    for (const key of [...poolConsistencyRefreshInFlight.keys()]) {
      if (key.startsWith(`${normalizedProviderId}::`)) poolConsistencyRefreshInFlight.delete(key)
    }
    for (const key of [...poolConsistencyObservationLogCache.keys()]) {
      if (key.startsWith(`${normalizedProviderId}::`)) poolConsistencyObservationLogCache.delete(key)
    }
    return
  }
  poolConsistencyCache.clear()
  poolConsistencyRefreshInFlight.clear()
  poolConsistencyObservationLogCache.clear()
}

function formatPoolConsistencyIdentity(value?: string) {
  return value && value.length > 0 ? value : "<empty>"
}

function summarizePoolConsistencyValues(values: Set<string>) {
  const items = [...values].map((item) => formatPoolConsistencyIdentity(item))
  if (items.length <= 6) return items.join(", ")
  return `${items.slice(0, 6).join(", ")} (+${items.length - 6} more)`
}

function sanitizePoolConsistencyErrorDetail(value: string, maxLength = 280) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return "unknown_error"
  return normalized.slice(0, maxLength)
}

function resolvePoolAccountRegion(account: StoredAccount) {
  const metadata = (account.metadata ?? {}) as Record<string, unknown>
  const candidates = [
    metadata.region,
    metadata.regionId,
    metadata.region_id,
    metadata.country,
    metadata.location,
    metadata.geo,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeIdentity(String(candidate ?? ""))
    if (normalized) return normalized
  }
  return undefined
}

function buildModelSetSignature(snapshot: AccountModelsSnapshot) {
  const modelIds = snapshot.entries
    .map((entry) => extractModelEntryID(entry))
    .filter((id): id is string => Boolean(id))
  const normalized = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b))
  const fingerprint = createHash("sha256").update(normalized.join("\n")).digest("hex")
  return {
    modelIds: normalized,
    fingerprint,
  }
}

type PoolIdentityGroup = {
  signature: string
  organizationId: string
  projectId: string
  region: string
  completenessScore: number
  accounts: StoredAccount[]
}

type PoolModelFingerprintGroup = {
  fingerprint: string
  modelIds: string[]
  accountIds: string[]
}

function buildPoolIdentityGroupSignature(input: { organizationId: string; projectId: string; region: string }) {
  return JSON.stringify({
    organizationId: input.organizationId,
    projectId: input.projectId,
    region: input.region,
  })
}

function comparePoolIdentityGroups(a: PoolIdentityGroup, b: PoolIdentityGroup) {
  return (
    b.accounts.length - a.accounts.length ||
    b.completenessScore - a.completenessScore ||
    a.signature.localeCompare(b.signature)
  )
}

function comparePoolModelFingerprintGroups(a: PoolModelFingerprintGroup, b: PoolModelFingerprintGroup) {
  return (
    b.accountIds.length - a.accountIds.length ||
    b.modelIds.length - a.modelIds.length ||
    a.fingerprint.localeCompare(b.fingerprint)
  )
}

function formatPoolConsistencyAccountIDs(accountIds: string[]) {
  return accountIds.map((accountId) => normalizeIdentity(accountId) ?? accountId).join(", ")
}

function buildPoolConsistencyCacheKey(providerId: string, cohort?: AccountPlanCohort | null) {
  const normalizedProviderId = (normalizeIdentity(providerId) ?? "chatgpt").toLowerCase()
  const normalizedCohort = cohort ?? "all"
  return `${normalizedProviderId}::${normalizedCohort}`
}

function getCachedPoolConsistencySuccess(
  providerId: string,
  now = Date.now(),
  options?: { preferredPlanCohort?: AccountPlanCohort | null },
) {
  const cached = poolConsistencyCache.get(buildPoolConsistencyCacheKey(providerId, options?.preferredPlanCohort ?? null))
  if (!cached?.ok) return null
  if (now - cached.checkedAt > POOL_CONSISTENCY_TTL_MS) return null
  return cached
}

function getCachedPoolConsistencyResult(
  providerId: string,
  now = Date.now(),
  options?: { preferredPlanCohort?: AccountPlanCohort | null },
) {
  const cached = poolConsistencyCache.get(buildPoolConsistencyCacheKey(providerId, options?.preferredPlanCohort ?? null))
  if (!cached) return null
  if (now - cached.checkedAt > POOL_CONSISTENCY_TTL_MS) return null
  return cached
}

async function evaluateProviderPoolConsistency(
  providerId: string,
  options?: { preferredPlanCohort?: AccountPlanCohort | null },
): Promise<PoolConsistencyResult> {
  const normalizedProviderId = (normalizeIdentity(providerId) ?? "chatgpt").toLowerCase()
  const preferredPlanCohort = options?.preferredPlanCohort ?? null
  const checkedAt = Date.now()
  const candidates = accountStore
    .list()
    .filter(
      (account) =>
        account.providerId.toLowerCase() === normalizedProviderId &&
        Boolean(account.accessToken) &&
        (preferredPlanCohort === null || resolveAccountPlanCohort(account) === preferredPlanCohort) &&
      !isStickyAccountHealthSnapshot(
        getActiveAccountHealthSnapshot(accountHealthCache, account.id, normalizeIdentity, checkedAt),
      ),
    )

  if (candidates.length <= 1) {
    return {
      ok: true,
      providerId: normalizedProviderId,
      cohort: preferredPlanCohort,
      checkedAt,
      accountCount: candidates.length,
      eligibleAccountIds: candidates.map((account) => account.id),
      excludedAccountIds: [],
      warnings: [],
    }
  }

  const organizationValues = new Set<string>()
  const projectValues = new Set<string>()
  const regionValues = new Set<string>()
  const identityGroups = new Map<string, PoolIdentityGroup>()
  for (const account of candidates) {
    const openAIHeaders = resolveAccountOpenAIHeaders(account)
    const organizationId = openAIHeaders.organizationId ?? ""
    const projectId = openAIHeaders.projectId ?? ""
    const region = resolvePoolAccountRegion(account) ?? ""
    organizationValues.add(organizationId)
    projectValues.add(projectId)
    regionValues.add(region)
    const signature = buildPoolIdentityGroupSignature({
      organizationId,
      projectId,
      region,
    })
    const existing = identityGroups.get(signature)
    if (existing) {
      existing.accounts.push(account)
      continue
    }
    identityGroups.set(signature, {
      signature,
      organizationId,
      projectId,
      region,
      completenessScore: [organizationId, projectId, region].filter((value) => value.length > 0).length,
      accounts: [account],
    })
  }

  const mismatchDetails: string[] = []
  if (organizationValues.size > 1) {
    mismatchDetails.push(
      `OpenAI-Organization mismatch: ${summarizePoolConsistencyValues(organizationValues)}`,
    )
  }
  if (projectValues.size > 1) {
    mismatchDetails.push(`OpenAI-Project mismatch: ${summarizePoolConsistencyValues(projectValues)}`)
  }
  if (regionValues.size > 1) {
    mismatchDetails.push(`Region metadata mismatch: ${summarizePoolConsistencyValues(regionValues)}`)
  }
  const warnings: string[] = []
  const sortedIdentityGroups = [...identityGroups.values()].sort(comparePoolIdentityGroups)
  let eligibleAccounts = [...candidates]
  const excludedAccountIds = new Set<string>()
  if (mismatchDetails.length > 0) {
    warnings.push(
      `metadata heterogeneity observed groups=${sortedIdentityGroups.length} accounts=${candidates.length}; no routing exclusion applied; ${mismatchDetails.join(
        " | ",
      )}`,
    )
  }

  const modelCheckResults = await Promise.all(
    eligibleAccounts.map(async (account) => {
      try {
        const snapshot = await getModelsSnapshot({
          account,
        })
        return {
          accountId: account.id,
          ...buildModelSetSignature(snapshot),
        }
      } catch (error) {
        const blocked = detectRoutingBlockedAccount({
          error,
        })
        if (blocked.matched) {
          markAccountUnhealthy(account.id, blocked.reason, "models")
          evictAccountModelsCache(account.id)
        } else {
          const transient = detectTransientUpstreamError(error)
          if (transient.matched) {
            markAccountUnhealthy(account.id, transient.reason ?? "upstream_transport_error", "models")
          }
        }
        return {
          accountId: account.id,
          error: sanitizePoolConsistencyErrorDetail(errorMessage(error)),
        }
      }
    }),
  )

  const modelErrors = modelCheckResults
    .filter((item): item is { accountId: string; error: string } => "error" in item)
    .map((item) => `models fetch failed for account ${item.accountId}: ${item.error}`)
  if (modelErrors.length > 0) {
    // Soft-fail by design: transient model-catalog fetch failures should not
    // block request routing for the whole pool.
    console.warn(
      `[oauth-multi-login] pool consistency warn provider=${normalizedProviderId} reason=model_catalog_fetch_failed details=${modelErrors.join(
        " | ",
      )}`,
    )
    return {
      ok: true,
      providerId: normalizedProviderId,
      cohort: preferredPlanCohort,
      checkedAt,
      accountCount: candidates.length,
      eligibleAccountIds: eligibleAccounts.map((account) => account.id),
      excludedAccountIds: [...excludedAccountIds],
      warnings,
    }
  }

  const successfulModelChecks = modelCheckResults.filter(
    (item): item is { accountId: string; modelIds: string[]; fingerprint: string } => !("error" in item),
  )
  const signatures = new Set(successfulModelChecks.map((item) => item.fingerprint))
  if (signatures.size > 1) {
    const fingerprintGroups = new Map<string, PoolModelFingerprintGroup>()
    for (const item of successfulModelChecks) {
      const existing = fingerprintGroups.get(item.fingerprint)
      if (existing) {
        existing.accountIds.push(item.accountId)
        continue
      }
      fingerprintGroups.set(item.fingerprint, {
        fingerprint: item.fingerprint,
        modelIds: item.modelIds,
        accountIds: [item.accountId],
      })
    }
    const sortedFingerprintGroups = [...fingerprintGroups.values()].sort(comparePoolModelFingerprintGroups)
    const selectedFingerprintGroup = sortedFingerprintGroups[0]
    const eligibleAccountIdSet = new Set(selectedFingerprintGroup.accountIds)
    for (const item of successfulModelChecks) {
      if (!eligibleAccountIdSet.has(item.accountId)) {
        excludedAccountIds.add(item.accountId)
      }
    }
    eligibleAccounts = eligibleAccounts.filter((account) => eligibleAccountIdSet.has(account.id))
    warnings.push(
      `model subgroup selected accounts=${formatPoolConsistencyAccountIDs(eligibleAccounts.map((account) => account.id))} excluded=${formatPoolConsistencyAccountIDs([...excludedAccountIds]) || "<none>"}; ${successfulModelChecks
        .map((item) => `account=${item.accountId} models=${item.modelIds.length} fingerprint=${item.fingerprint.slice(0, 12)}...`)
        .join(" | ")}`,
    )
  }

  emitPoolConsistencyWarnings({
    providerId: normalizedProviderId,
    cohort: preferredPlanCohort,
    eligibleCount: eligibleAccounts.length,
    accountCount: candidates.length,
    excludedAccountIds: [...excludedAccountIds],
    warnings,
  })

  return {
    ok: true,
    providerId: normalizedProviderId,
    cohort: preferredPlanCohort,
    checkedAt,
    accountCount: candidates.length,
    eligibleAccountIds: eligibleAccounts.map((account) => account.id),
    excludedAccountIds: [...excludedAccountIds],
    warnings,
  }
}

async function getProviderPoolConsistency(
  providerId: string,
  options?: { force?: boolean; preferredPlanCohort?: AccountPlanCohort | null },
) {
  const normalizedProviderId = (normalizeIdentity(providerId) ?? "chatgpt").toLowerCase()
  const preferredPlanCohort = options?.preferredPlanCohort ?? null
  const cacheKey = buildPoolConsistencyCacheKey(normalizedProviderId, preferredPlanCohort)
  const force = options?.force === true
  if (!force) {
    const cached = poolConsistencyCache.get(cacheKey)
    if (cached && Date.now() - cached.checkedAt <= POOL_CONSISTENCY_TTL_MS) {
      return cached
    }
  }

  const inFlight = poolConsistencyRefreshInFlight.get(cacheKey)
  if (inFlight) return inFlight

  const refreshTask = (async () => {
    const result = await evaluateProviderPoolConsistency(normalizedProviderId, {
      preferredPlanCohort,
    })
    poolConsistencyCache.set(cacheKey, result)
    return result
  })()

  poolConsistencyRefreshInFlight.set(cacheKey, refreshTask)
  try {
    return await refreshTask
  } finally {
    poolConsistencyRefreshInFlight.delete(cacheKey)
  }
}

function refreshProviderPoolConsistencyInBackground(providerId: string, preferredPlanCohort?: AccountPlanCohort | null) {
  handleBackgroundPromise(
    `refreshProviderPoolConsistency:${providerId}:${preferredPlanCohort ?? "all"}`,
    getProviderPoolConsistency(providerId, {
      force: true,
      preferredPlanCohort: preferredPlanCohort ?? null,
    }),
  )
}

function toPoolConsistencyErrorResponse(result: PoolConsistencyFailure) {
  return new Response(
    JSON.stringify({
      error: result.message,
      code: result.code,
      details: result.details,
    }),
    {
      status: 409,
      headers: {
        "Content-Type": "application/json",
      },
    },
  )
}

function cleanupQuotaExhaustedCooldown(now = Date.now()) {
  for (const [accountId, expiresAt] of quotaExhaustedAccountCooldown.entries()) {
    if (expiresAt <= now) quotaExhaustedAccountCooldown.delete(accountId)
  }
}

function markAccountQuotaExhausted(accountId: string, now = Date.now()) {
  const normalized = normalizeIdentity(accountId)
  if (!normalized) return
  cleanupQuotaExhaustedCooldown(now)
  quotaExhaustedAccountCooldown.set(normalized, now + QUOTA_EXHAUSTED_ACCOUNT_COOLDOWN_MS)
}

function collectProviderQuotaExhaustedExclusions(providerId: string, now = Date.now()) {
  cleanupQuotaExhaustedCooldown(now)
  const normalizedProviderId = normalizeIdentity(providerId)?.toLowerCase()
  if (!normalizedProviderId) return []

  const excluded: string[] = []
  for (const [accountId] of quotaExhaustedAccountCooldown) {
    const account = accountStore.get(accountId)
    if (!account) {
      quotaExhaustedAccountCooldown.delete(accountId)
      continue
    }
    if (account.providerId.toLowerCase() === normalizedProviderId) {
      excluded.push(accountId)
    }
  }
  return excluded
}

function collectProviderUnhealthyExclusions(providerId: string, options?: { includeTransient?: boolean }) {
  const normalizedProviderId = normalizeIdentity(providerId)?.toLowerCase()
  if (!normalizedProviderId) return []
  const includeTransient = options?.includeTransient !== false
  const now = Date.now()

  const excluded: string[] = []
  for (const accountId of accountHealthCache.keys()) {
    const account = accountStore.get(accountId)
    if (!account) {
      accountHealthCache.delete(accountId)
      continue
    }
    if (account.providerId.toLowerCase() === normalizedProviderId) {
  const snapshot = getActiveAccountHealthSnapshot(accountHealthCache, accountId, normalizeIdentity, now)
      if (!snapshot) continue
      if (!includeTransient && !isStickyAccountHealthSnapshot(snapshot)) continue
      excluded.push(accountId)
    }
  }
  return excluded
}

function collectProviderConsistencyExclusions(
  providerId: string,
  now = Date.now(),
  options?: { preferredPlanCohort?: AccountPlanCohort | null },
) {
  const cached = getCachedPoolConsistencySuccess(providerId, now, options)
  return cached?.excludedAccountIds ?? []
}

function collectProviderRoutingExclusions(providerId: string, now = Date.now()) {
  return buildProviderRoutingHints(providerId, now).excludeAccountIds
}

function resolveAccountRoutingExclusionReason(accountId: string, now = Date.now()) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return "routing_excluded"
  cleanupQuotaExhaustedCooldown(now)
  const unhealthy = getActiveAccountHealthSnapshot(accountHealthCache, normalizedAccountId, normalizeIdentity, now)
  if (unhealthy) return unhealthy.reason || "account_unhealthy"
  if (quotaExhaustedAccountCooldown.has(normalizedAccountId)) return "quota_exhausted_cooldown"
  const account = accountStore.get(normalizedAccountId)
  if (account) {
    const consistency = getCachedPoolConsistencySuccess(account.providerId, now, {
      preferredPlanCohort: resolveAccountPlanCohort(account),
    })
    if (consistency?.excludedAccountIds.includes(normalizedAccountId)) {
      return "pool_consistency_excluded"
    }
  }
  const headroom = resolveQuotaSnapshotHeadroomPercent(accountQuotaCache.get(normalizedAccountId), now)
  if (Number.isFinite(headroom) && Number(headroom) <= 0) return "quota_headroom_exhausted"
  if (Number.isFinite(headroom) && Number(headroom) <= ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD) {
    return "quota_headroom_low"
  }
  return "routing_excluded"
}

async function detectQuotaExhaustedUpstreamResponse(response: Response) {
  const status = Number(response.status ?? 0)
  if (status !== 429 && status !== 403 && status !== 402) {
    return { matched: false as const }
  }

  let code = ""
  let type = ""
  let message = ""
  let rawText = ""
  try {
    rawText = await readResponsePreviewText(response, 8192)
    if (rawText.trim()) {
      try {
        const parsed = JSON.parse(rawText) as Record<string, unknown>
        const rootError =
          parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : parsed
        code = String(rootError.code ?? parsed.code ?? "").trim().toLowerCase()
        type = String(rootError.type ?? parsed.type ?? "").trim().toLowerCase()
        message = String(rootError.message ?? parsed.message ?? "").trim().toLowerCase()
      } catch {
        // non-json error payload
      }
    }
  } catch {
    // ignore parse failures
  }

  const corpus = `${code} ${type} ${message} ${rawText.toLowerCase()}`
  const strongCodes = new Set([
    "insufficient_quota",
    "billing_hard_limit_reached",
    "quota_exceeded",
    "usage_limit_reached",
    "credits_exhausted",
    "plan_limit_reached",
  ])
  if ((code && strongCodes.has(code)) || (type && strongCodes.has(type))) {
    return {
      matched: true as const,
      reason: code || type,
    }
  }

  const strongPhrases = [
    "exceeded your current quota",
    "insufficient quota",
    "quota exceeded",
    "usage limit reached",
    "billing hard limit",
    "credits have been exhausted",
    "额度已用尽",
    "配额不足",
  ]
  for (const phrase of strongPhrases) {
    if (corpus.includes(phrase)) {
      return {
        matched: true as const,
        reason: phrase,
      }
    }
  }

  return { matched: false as const }
}

async function detectQuotaExhaustedChatError(error: unknown) {
  const status = Number((error as { statusCode?: unknown } | null)?.statusCode ?? NaN)
  if (!Number.isFinite(status) || (status !== 429 && status !== 403 && status !== 402)) {
    return { matched: false as const }
  }

  const bodyRaw = (error as { upstreamBody?: unknown } | null)?.upstreamBody
  const bodyText =
    typeof bodyRaw === "string"
      ? bodyRaw
      : bodyRaw && typeof bodyRaw === "object"
        ? JSON.stringify(bodyRaw)
        : ""
  return detectQuotaExhaustedUpstreamResponse(
    new Response(bodyText, {
      status,
      headers: {
        "content-type": "application/json",
      },
    }),
  )
}

async function detectTransientUpstreamResponse(response: Response) {
  const status = Number(response.status ?? 0)
  if (!isTransientUpstreamStatus(status)) {
    return { matched: false as const }
  }
  return {
    matched: true as const,
    reason: `upstream_http_${status}`,
  }
}

async function detectRoutingBlockedUpstreamResponse(response: Response) {
  const status = Number(response.status ?? 0)
  if (status !== 401 && status !== 402 && status !== 403) {
    return { matched: false as const }
  }
  let text = ""
  try {
    text = await readResponsePreviewText(response, 8192)
  } catch {
    // ignore clone/parse failures
  }
  return detectRoutingBlockedAccount({
    statusCode: status,
    text,
  })
}

function detectRoutingBlockedChatError(error: unknown) {
  const bodyRaw = (error as { upstreamBody?: unknown } | null)?.upstreamBody
  const bodyText =
    typeof bodyRaw === "string"
      ? bodyRaw
      : bodyRaw && typeof bodyRaw === "object"
        ? JSON.stringify(bodyRaw)
        : ""
  return detectRoutingBlockedAccount({
    text: bodyText,
    error,
  })
}

function normalizeHeaderIdentityValue(value?: string | null) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : undefined
}

const STRICT_PRIVACY_TOP_LEVEL_BODY_FIELDS = ["user", "user_id", "chatgpt_user_id", "client_user_id", "end_user_id", "safety_identifier"]
const STRICT_PRIVACY_BODY_SESSION_FIELDS = [
  "session_id",
  "sessionId",
  "previous_response_id",
  "previousResponseId",
  "conversation",
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "prompt_cache_key",
  "promptCacheKey",
]
const STRICT_PRIVACY_METADATA_FIELD_PATTERN =
  /(^|_)(user|email|mail|phone|mobile|ip|account|workspace|org|organization|tenant|employee|device|machine|host|client)(_|$)/i
const strictPrivacySanitizedLogState = new Map<string, { lastAt: number; suppressed: number }>()

function logStrictPrivacySanitizedFields(input: {
  route: string
  keyId?: string | null
  accountId?: string | null
  fields: string[]
}) {
  if (input.fields.length === 0) return
  const normalizedFields = input.fields.slice(0, 12).join(",")
  const mapKey = `${input.route}|${input.keyId ?? "-"}|${input.accountId ?? "-"}|${normalizedFields}`
  const now = Date.now()
  const previous = strictPrivacySanitizedLogState.get(mapKey)
  if (previous && now - previous.lastAt < STRICT_PRIVACY_SANITIZED_LOG_INTERVAL_MS) {
    previous.suppressed += 1
    return
  }
  const suppressed = previous?.suppressed ?? 0
  strictPrivacySanitizedLogState.set(mapKey, { lastAt: now, suppressed: 0 })
  console.log(
    `[oauth-multi-login] strict-privacy sanitized request fields route=${input.route} key=${input.keyId ?? "-"} account=${input.accountId ?? "-"} fields=${normalizedFields}${suppressed > 0 ? ` suppressed=${suppressed}` : ""}`,
  )
}

function sanitizeUpstreamJsonBody(input: {
  body?: Uint8Array
  contentType?: string | null
  strictPrivacy: boolean
  accountId?: string | null
  parsedRoot?: Record<string, unknown> | null
}) {
  if (!input.body || (!input.strictPrivacy && !input.accountId)) return { body: input.body, strippedFields: [] as string[] }
  const contentType = String(input.contentType ?? "").toLowerCase()
  if (!input.parsedRoot && !contentType.includes("application/json")) {
    return { body: input.body, strippedFields: [] as string[] }
  }

  try {
    const payload = input.parsedRoot ?? (JSON.parse(new TextDecoder().decode(input.body)) as unknown)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { body: input.body, strippedFields: [] as string[] }
    }

    const root = { ...(payload as Record<string, unknown>) }
    const strippedFields: string[] = []

    for (const key of STRICT_PRIVACY_TOP_LEVEL_BODY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(root, key)) {
        delete root[key]
        strippedFields.push(key)
      }
    }

    for (const key of STRICT_PRIVACY_BODY_SESSION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(root, key)) continue
      const currentValue = root[key]
      const rewritten = rewriteClientIdentifierForUpstream({
        accountId: input.accountId,
        fieldKey: key,
        value: currentValue,
        strictPrivacy: input.strictPrivacy,
      })
      if (!rewritten) continue
      if (String(currentValue ?? "") === rewritten) continue
      root[key] = rewritten
      strippedFields.push(`${input.accountId ? "bound" : "anonymized"}:${key}`)
    }

    if (root.metadata && typeof root.metadata === "object" && !Array.isArray(root.metadata)) {
      const metadata = { ...(root.metadata as Record<string, unknown>) }
      for (const key of Object.keys(metadata)) {
        const normalizedKey = String(key).toLowerCase()
        if (STRICT_PRIVACY_METADATA_FIELD_PATTERN.test(key)) {
          delete metadata[key]
          strippedFields.push(`metadata.${key}`)
          continue
        }
        if (STRICT_PRIVACY_SESSION_KEYS_LOWER.has(normalizedKey)) {
          const currentValue = metadata[key]
          const rewritten = rewriteClientIdentifierForUpstream({
            accountId: input.accountId,
            fieldKey: normalizedKey,
            value: currentValue,
            strictPrivacy: input.strictPrivacy,
          })
          if (!rewritten) continue
          if (String(currentValue ?? "") === rewritten) continue
          metadata[key] = rewritten
          strippedFields.push(`${input.accountId ? "bound" : "anonymized"}:metadata.${key}`)
        }
      }
      root.metadata = metadata
    }

    if (strippedFields.length === 0) {
      return { body: input.body, strippedFields }
    }

    return {
      body: new TextEncoder().encode(JSON.stringify(root)),
      strippedFields,
    }
  } catch {
    return { body: input.body, strippedFields: [] as string[] }
  }
}

const ALWAYS_DROPPED_FORWARD_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "authorization",
  "originator",
  "user-agent",
  "version",
  "chatgpt-account-id",
  "x-admin-token",
  "x-sensitive-action",
  "x-internal-admin-token",
  "x-internal-sensitive-action",
  "x-forwarded-for",
  "x-real-ip",
  "cookie",
])

const STRICT_PRIVACY_DROPPED_FORWARD_HEADERS = new Set([
  "forwarded",
  "via",
  "true-client-ip",
  "x-client-ip",
  "x-user-ip",
  "x-remote-ip",
  "x-original-forwarded-for",
  "x-original-host",
  "x-remote-user",
  "x-authenticated-user",
  "x-auth-request-user",
  "x-auth-request-email",
  "x-user-id",
  "x-user-email",
  "x-user-name",
  "x-account-id",
  "x-workspace-id",
  "x-org-id",
  "x-organization-id",
  "x-employee-id",
  "x-device-id",
  "x-machine-id",
  "origin",
  "referer",
])

const STRICT_PRIVACY_DROPPED_HEADER_PREFIXES = [
  "x-forwarded-",
  "x-real-",
  "x-client-",
  "x-user-",
  "x-auth-",
  "x-remote-",
  "x-workspace-",
  "x-account-",
  "x-organization-",
  "x-org-",
  "x-employee-",
  "x-device-",
  "x-machine-",
  "cf-",
]

function shouldDropForwardHeader(headerName: string, strictPrivacy: boolean) {
  const lower = headerName.toLowerCase()
  if (ALWAYS_DROPPED_FORWARD_HEADERS.has(lower)) return true
  if (!strictPrivacy) return false
  if (STRICT_PRIVACY_DROPPED_FORWARD_HEADERS.has(lower)) return true
  if (lower === "x-client-request-id") return false
  if (lower === "x-codex-beta-features") return false
  if (lower === "x-responsesapi-include-timing-metrics") return false
  if (lower === "openai-beta") return false
  if (lower === "traceparent") return false
  if (lower === "tracestate") return false
  if (lower === "x-codex-turn-metadata") return false
  if (lower === RESPONSES_TURN_STATE_HEADER) return false
  return STRICT_PRIVACY_DROPPED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

const STRICT_PRIVACY_SESSION_HEADER_NAMES = [
  "session_id",
  "session-id",
  "sessionid",
  "x-session-id",
  "x-client-request-id",
  "previous_response_id",
  "previous-response-id",
  "previousresponseid",
  "conversation",
  "prompt_cache_key",
  "prompt-cache-key",
  "x-prompt-cache-key",
  "conversation_id",
  "conversation-id",
  "thread_id",
  "thread-id",
]

function rewriteUpstreamSessionHeaders(headers: Headers, input: { strictPrivacy: boolean; accountId?: string | null }) {
  if (!input.strictPrivacy && !input.accountId) return
  for (const headerName of STRICT_PRIVACY_SESSION_HEADER_NAMES) {
    const current = headers.get(headerName)
    if (!current) continue
    const rewritten = rewriteClientIdentifierForUpstream({
      accountId: input.accountId,
      fieldKey: headerName,
      value: current,
      strictPrivacy: input.strictPrivacy,
    })
    if (rewritten) {
      headers.set(headerName, rewritten)
    } else if (input.strictPrivacy) {
      headers.delete(headerName)
    }
  }
}

function resolveForwardClientIdentity(incoming?: Headers) {
  const incomingOriginator = normalizeHeaderIdentityValue(incoming?.get("originator"))
  const incomingVersion = normalizeHeaderIdentityValue(incoming?.get("version"))
  const incomingUserAgent = normalizeHeaderIdentityValue(incoming?.get("user-agent"))

  // These headers describe the Codex client itself rather than the end user.
  // Keeping a self-consistent incoming identity preserves official wire parity
  // while strict privacy continues to strip user/account/session identifiers.
  if (
    incomingOriginator &&
    incomingVersion &&
    incomingUserAgent &&
    isFirstPartyCodexOriginator(incomingOriginator) &&
    CODEX_VERSION_PATTERN.test(incomingVersion) &&
    (incomingUserAgent === `${incomingOriginator}/${incomingVersion}` ||
      incomingUserAgent.startsWith(`${incomingOriginator}/${incomingVersion} `))
  ) {
    return {
      originator: incomingOriginator,
      userAgent: incomingUserAgent,
      version: incomingVersion,
    }
  }

  return {
    originator: CODEX_ORIGINATOR,
    userAgent: CODEX_USER_AGENT,
    version: CODEX_CLIENT_VERSION,
  }
}

function resolveAccountOpenAIHeaders(account: StoredAccount) {
  const metadata = (account.metadata ?? {}) as Record<string, unknown>
  return {
    organizationId: normalizeIdentity(String(metadata.organizationId ?? "")),
    projectId: normalizeIdentity(String(metadata.projectId ?? "")),
  }
}

function buildUpstreamForwardHeaders(input: {
  incoming?: Headers
  accessToken: string
  accountId?: string
  boundAccountId?: string
  providerMode?: UpstreamProfile["providerMode"]
  attachChatgptAccountId?: boolean
  defaultAccept?: string
  organizationId?: string
  projectId?: string
  strictPrivacy?: boolean
  codexClientMetadata?: Record<string, string> | null
}) {
  const strictPrivacy = input.strictPrivacy ?? isStrictUpstreamPrivacyEnabled()
  const identity = resolveForwardClientIdentity(input.incoming)
  const headers = new Headers()
  input.incoming?.forEach((value, key) => {
    if (shouldDropForwardHeader(key, strictPrivacy)) return
    headers.set(key, value)
  })
  rewriteUpstreamSessionHeaders(headers, {
    strictPrivacy,
    accountId: input.boundAccountId,
  })

  if (input.defaultAccept && !headers.has("accept")) {
    headers.set("accept", input.defaultAccept)
  }
  headers.set("originator", identity.originator)
  headers.set("user-agent", identity.userAgent)
  if (input.providerMode === "openai") {
    headers.set("version", identity.version)
  } else {
    headers.delete("version")
  }
  headers.set("authorization", `Bearer ${input.accessToken}`)
  if (input.organizationId) {
    headers.set("OpenAI-Organization", input.organizationId)
  }
  if (input.projectId) {
    headers.set("OpenAI-Project", input.projectId)
  }
  if (input.attachChatgptAccountId !== false && input.accountId) {
    headers.set("ChatGPT-Account-ID", input.accountId)
  } else {
    headers.delete("ChatGPT-Account-ID")
  }
  appendOfficialCodexForwardHeaders(headers, input.codexClientMetadata)
  return headers
}

const PASSTHROUGH_CODEX_FAILURE_HEADERS = new Set([
  "content-type",
  "content-language",
  "retry-after",
  "x-request-id",
  "x-oai-request-id",
  "cf-ray",
  "x-codex-active-limit",
  "x-codex-promo-message",
  "x-codex-credits-has-credits",
  "x-codex-credits-unlimited",
  "x-codex-credits-balance",
])

function isCodexRateLimitWindowHeader(headerName: string) {
  const lower = headerName.toLowerCase()
  return (
    /^x-[a-z0-9-]+-(primary|secondary)-(used-percent|window-minutes|reset-at)$/.test(lower) ||
    /^x-[a-z0-9-]+-limit-name$/.test(lower)
  )
}

function buildSanitizedCodexFailureHeaders(upstreamHeaders: Headers) {
  const headers = new Headers()
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (PASSTHROUGH_CODEX_FAILURE_HEADERS.has(lower) || isCodexRateLimitWindowHeader(lower)) {
      headers.set(key, value)
    }
  })
  return headers
}

async function normalizeCodexFailureResponse(input: {
  status: number
  headers: Headers
  bodyBytes: Uint8Array
  routingMode: string
}) {
  const decodedBody = new TextDecoder().decode(input.bodyBytes)
  const blocked = detectRoutingBlockedAccount({
    statusCode: input.status,
    text: decodedBody,
  })

  if (blocked.matched) {
    return buildUpstreamAccountUnavailableFailure({
      routingMode: input.routingMode,
      retryAfter: input.headers.get("retry-after"),
    })
  }

  if (input.routingMode === "pool" && isTransientUpstreamStatus(input.status)) {
    return buildUpstreamAccountUnavailableFailure({
      routingMode: input.routingMode,
      retryAfter: input.headers.get("retry-after"),
    })
  }

  return {
    status: input.status,
    headers: buildSanitizedCodexFailureHeaders(input.headers),
    bodyText: decodedBody,
  }
}

async function requestUpstreamWithPolicy(input: {
  url: string
  method: string
  headers: Headers
  body?: Uint8Array
  accountId?: string
  routeTag: string
  policyOverride?: Partial<UpstreamRetryPolicy>
  recordBehaviorResult?: boolean
}) {
  const policy: UpstreamRetryPolicy = {
    ...upstreamRetryPolicy,
    ...input.policyOverride,
  }
  const startedAt = Date.now()
  try {
    const result = await fetchWithUpstreamRetry({
      url: input.url,
      method: input.method,
      headers: input.headers,
      body: input.body,
      policy,
      onRetry: (ctx) => {
        const accountPart = input.accountId ? ` account=${input.accountId}` : ""
        const message = `[oauth-multi-login] upstream retry route=${input.routeTag}${accountPart} attempt=${ctx.attempt}/${ctx.maxAttempts} reason=${ctx.reason} delay_ms=${ctx.delayMs}`
        if (input.routeTag === "/api/accounts/quota") {
          console.log(`${message} transient=true`)
        } else {
          console.warn(message)
        }
      },
    })
    if (input.recordBehaviorResult && input.accountId) {
      behaviorController.recordResult({
        accountId: input.accountId,
        latencyMs: Date.now() - startedAt,
        failed: !result.response.ok,
      })
    }
    return result
  } catch (error) {
    if (input.recordBehaviorResult && input.accountId) {
      behaviorController.recordResult({
        accountId: input.accountId,
        latencyMs: Date.now() - startedAt,
        failed: true,
      })
    }
    throw error
  }
}

async function fetchModelsSnapshotFromUpstream(input: {
  account: StoredAccount
  requestUrl?: string
  requestHeaders?: Headers
  clientVersion: string
  cached?: AccountModelsSnapshot
}) {
  const profile = resolveUpstreamProfileForAccount(input.account)
  const openAIHeaders = profile.providerMode === "openai" ? resolveAccountOpenAIHeaders(input.account) : null
  const upstream = buildModelsUpstreamUrl({
    requestUrl: input.requestUrl,
    clientVersion: input.clientVersion,
    modelsEndpoint: profile.modelsEndpoint,
    accountId: input.account.id,
  })

  async function requestWithAuth(auth: { accessToken: string; accountId?: string }) {
    const headers = buildUpstreamForwardHeaders({
      incoming: input.requestHeaders,
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      boundAccountId: input.account.id,
      providerMode: profile.providerMode,
      attachChatgptAccountId: profile.attachChatgptAccountId,
      defaultAccept: "application/json",
      organizationId: openAIHeaders?.organizationId,
      projectId: openAIHeaders?.projectId,
    })
    const cachedEtag = normalizeHeaderIdentityValue(input.cached?.etag)
    if (cachedEtag) {
      headers.set("if-none-match", cachedEtag)
    }
    const result = await withTimeout(
      requestUpstreamWithPolicy({
        url: upstream.toString(),
        method: "GET",
        headers,
        accountId: input.account.id,
        routeTag: "/models",
      }),
      MODELS_REFRESH_TIMEOUT_MS,
      "models request",
    )
    return result.response
  }

  const markModelsRequestFailure = (error: unknown) => {
    const blocked = detectRoutingBlockedAccount({
      error,
    })
    if (blocked.matched) {
      markAccountUnhealthy(input.account.id, blocked.reason, "models")
      evictAccountModelsCache(input.account.id)
      return
    }
    const transient = detectTransientUpstreamError(error)
    if (transient.matched) {
      markAccountUnhealthy(input.account.id, transient.reason ?? "upstream_transport_error", "models")
    }
  }

  let auth = await resolveUpstreamAccountAuth(input.account)
  let response: Response
  try {
    response = await requestWithAuth(auth)
  } catch (error) {
    markModelsRequestFailure(error)
    throw error
  }
  if (response.status === 401 && profile.canRefreshOn401) {
    const latest = accountStore.get(input.account.id) ?? input.account
    auth = await resolveUpstreamAccountAuth(latest, { forceRefresh: true })
    try {
      response = await requestWithAuth(auth)
    } catch (error) {
      markModelsRequestFailure(error)
      throw error
    }
  }

  if (response.status === 304 && input.cached) {
    markAccountHealthy(input.account.id, "models")
    return {
      ...input.cached,
      fetchedAt: Date.now(),
    }
  }

  if (!response.ok) {
    const errorText = sanitizePoolConsistencyErrorDetail((await response.text().catch(() => "")).trim(), 200)
    const blocked = detectRoutingBlockedAccount({
      statusCode: response.status,
      text: errorText,
    })
    if (blocked.matched) {
      markAccountUnhealthy(input.account.id, blocked.reason, "models")
    }
    throw makeStatusError(response.status, `models request failed (${response.status})${errorText ? `: ${errorText}` : ""}`)
  }

  const body = new Uint8Array(await response.arrayBuffer())
  let payload: unknown = {}
  if (body.byteLength > 0) {
    const decoded = new TextDecoder().decode(body)
    try {
      payload = JSON.parse(decoded) as unknown
    } catch {
      throw new Error("models payload is not valid json")
    }
  }
  const normalizedPayload = toOpenAIModelListPayloadFromUpstream(payload)
  const entries = extractModelsEntries(normalizedPayload)
  const normalizedBody = new TextEncoder().encode(JSON.stringify(normalizedPayload))
  const contentType = normalizeHeaderIdentityValue(response.headers.get("content-type")) ?? "application/json"
  const etag = normalizeHeaderIdentityValue(response.headers.get("etag")) ?? null
  markAccountHealthy(input.account.id, "models")
  return {
    accountId: input.account.id,
    clientVersion: input.clientVersion,
    fetchedAt: Date.now(),
    etag,
    contentType,
    payload: normalizedPayload as ModelsUpstreamPayload,
    entries,
    body: normalizedBody,
  } satisfies AccountModelsSnapshot
}

async function getModelsSnapshot(input: {
  account: StoredAccount
  requestUrl?: string
  requestHeaders?: Headers
  forceRefresh?: boolean
}): Promise<AccountModelsSnapshot> {
  const clientVersion = resolveModelsClientVersion(input.requestUrl)
  const cacheKey = buildModelsCacheKey(input.account.id, clientVersion)
  const now = Date.now()
  const cached = accountModelsCache.get(cacheKey)

  if (!input.forceRefresh && cached && isModelsCacheFresh(cached, now)) {
    return cached
  }

  const inFlight = accountModelsRefreshInFlight.get(cacheKey)
  if (inFlight) return inFlight

  const refreshTask = (async () => {
    const latestCached = accountModelsCache.get(cacheKey) ?? cached
    try {
      const snapshot = await fetchModelsSnapshotFromUpstream({
        account: input.account,
        requestUrl: input.requestUrl,
        requestHeaders: input.requestHeaders,
        clientVersion,
        cached: latestCached,
      })
      accountModelsCache.set(cacheKey, snapshot)
      return snapshot
    } catch (error) {
      if (latestCached) {
        return latestCached
      }
      throw error
    }
  })()

  accountModelsRefreshInFlight.set(cacheKey, refreshTask)
  try {
    return await refreshTask
  } finally {
    accountModelsRefreshInFlight.delete(cacheKey)
  }
}

async function proxyOpenAIModelsRequest(input: {
  account: StoredAccount
  requestUrl: string
  requestHeaders: Headers
  routeTag: string
  modelId?: string
}) {
  const profile = resolveUpstreamProfileForAccount(input.account)
  if (profile.providerMode !== "openai") {
    throw new Error("OpenAI models proxy only supports api-key accounts")
  }

  const auth = await resolveUpstreamAccountAuth(input.account)
  const openAIHeaders = resolveAccountOpenAIHeaders(input.account)
  const headers = buildUpstreamForwardHeaders({
    incoming: input.requestHeaders,
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    boundAccountId: input.account.id,
    providerMode: profile.providerMode,
    attachChatgptAccountId: profile.attachChatgptAccountId,
    defaultAccept: "application/json",
    organizationId: openAIHeaders.organizationId,
    projectId: openAIHeaders.projectId,
  })

  const modelsEndpoint = input.modelId
    ? `${trimTrailingSlash(profile.modelsEndpoint)}/${encodeURIComponent(input.modelId)}`
    : profile.modelsEndpoint
  const upstreamUrl = buildUpstreamAbsoluteUrl(input.requestUrl, modelsEndpoint, {
    accountId: input.account.id,
  })
  const upstream = (
    await requestUpstreamWithPolicy({
      url: upstreamUrl,
      method: "GET",
      headers,
      accountId: input.account.id,
      routeTag: input.routeTag,
    })
  ).response

  return new Response(upstream.body, {
    status: upstream.status,
    headers: new Headers(upstream.headers),
  })
}

async function trackUsageFromStream(input: {
  accountId: string
  keyId?: string
  stream: ReadableStream<Uint8Array>
  auditId?: string
  providerId?: string | null
  virtualKeyId?: string | null
  model?: string | null
  sessionId?: string | null
  reasoningEffort?: string | null
}) {
  try {
    const { payload, usage: streamUsage } = await readCodexStream(new Response(input.stream))
    const usage = hasUsageDelta(streamUsage) ? streamUsage : normalizeUsage(payload)
    recordUsageMetrics({
      accountId: input.accountId,
      keyId: input.keyId,
      usage,
      source: "proxy-stream",
      auditId: input.auditId,
      providerId: input.providerId ?? null,
      virtualKeyId: input.virtualKeyId ?? input.keyId ?? null,
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
    })
  } catch (error) {
    console.warn(
      `[oauth-multi-login] usage track failed source=proxy-stream account=${input.accountId} key=${input.keyId ?? "-"} reason=${errorMessage(error)}`,
    )
  }
}

function detectWorktreeRoot(start: string) {
  let current = path.resolve(start)
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const

function collectProjectInstructionPaths(cwd: string, worktreeRoot: string | null) {
  const root = worktreeRoot ?? path.parse(cwd).root
  for (const filename of INSTRUCTION_FILES) {
    const matches: string[] = []
    let current = path.resolve(cwd)
    while (true) {
      const candidate = path.join(current, filename)
      if (existsSync(candidate)) matches.push(candidate)
      if (current === root) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    if (matches.length > 0) return matches
  }
  return []
}

async function loadInstructionSections(cwd: string, worktreeRoot: string | null) {
  const paths = collectProjectInstructionPaths(cwd, worktreeRoot)
  const sections = await Promise.all(
    paths.map(async (filepath) => {
      try {
        const content = (await readFile(filepath, "utf8")).trim()
        if (!content) return ""
        return `Instructions from: ${filepath}\n${content}`
      } catch {
        return ""
      }
    }),
  )
  return sections.filter((section) => section.length > 0)
}

function buildEnvironmentContext(model: string) {
  const cwd = process.cwd()
  const worktreeRoot = detectWorktreeRoot(cwd)
  const workspaceRoot = worktreeRoot ?? cwd
  const isGitRepo = worktreeRoot ? "yes" : "no"

  return [
    `You are powered by the model named ${model}. The exact model ID is openai/${model}.`,
    `Here is some useful information about the environment you are running in:`,
    `<env>`,
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${workspaceRoot}`,
    `  Is directory a git repo: ${isGitRepo}`,
    `  Platform: ${process.platform}`,
    `  Today's date: ${new Date().toDateString()}`,
    `</env>`,
    `<directories>`,
    `  `,
    `</directories>`,
  ].join("\n")
}

type ResponsesModelConfig = {
  isReasoningModel: boolean
  systemMessageMode: "remove" | "system" | "developer"
  requiredAutoTruncation: boolean
}

function getResponsesModelConfig(model: string): ResponsesModelConfig {
  const defaults: Omit<ResponsesModelConfig, "isReasoningModel"> = {
    requiredAutoTruncation: false,
    systemMessageMode: "system",
  }

  if (model.startsWith("gpt-5-chat")) {
    return {
      ...defaults,
      isReasoningModel: false,
    }
  }

  if (model.startsWith("o") || model.startsWith("gpt-5") || model.startsWith("codex-") || model.startsWith("computer-use")) {
    if (model.startsWith("o1-mini") || model.startsWith("o1-preview")) {
      return {
        ...defaults,
        isReasoningModel: true,
        systemMessageMode: "remove",
      }
    }

    return {
      ...defaults,
      isReasoningModel: true,
      systemMessageMode: "developer",
    }
  }

  return {
    ...defaults,
    isReasoningModel: false,
  }
}

async function buildSystemSections(model: string) {
  const cwd = process.cwd()
  const worktreeRoot = detectWorktreeRoot(cwd)
  const environment = buildEnvironmentContext(model)
  const instructions = await loadInstructionSections(cwd, worktreeRoot)
  return [environment, ...instructions].filter((section) => section.trim().length > 0)
}

function buildInputWithHistory(
  systemSections: string[],
  history: Array<{ role: "user" | "assistant"; text: string }>,
  message: string,
  systemMessageMode: "remove" | "system" | "developer",
) {
  const input: Array<Record<string, unknown>> = []

  if (systemMessageMode !== "remove") {
    for (const section of systemSections) {
      input.push({
        role: systemMessageMode,
        content: section,
      })
    }
  }

  for (const item of history) {
    if (!item.text) continue
    if (item.role === "assistant") {
      input.push({
        role: "assistant",
        content: [{ type: "output_text", text: item.text }],
      })
      continue
    }
    input.push({
      role: "user",
      content: [{ type: "input_text", text: item.text }],
    })
  }

  input.push({
    role: "user",
    content: [{ type: "input_text", text: message }],
  })

  return input
}

function buildCodexRequestBody(input: {
  model: string
  sessionId: string
  accountId?: string | null
  payloadInput: Array<Record<string, unknown>>
  codexClientMetadata?: Record<string, string> | null
  reasoningEffort?: string | null
}) {
  const modelConfig = getResponsesModelConfig(input.model)
  const promptCacheKey = rewriteClientIdentifierForUpstream({
    accountId: input.accountId,
    fieldKey: "prompt_cache_key",
    value: input.sessionId,
    strictPrivacy: isStrictUpstreamPrivacyEnabled(),
  })
  const requestBody: Record<string, unknown> = {
    model: input.model,
    input: input.payloadInput,
    store: false,
    instructions: CHAT_INSTRUCTIONS,
    prompt_cache_key: promptCacheKey,
    stream: true,
  }

  const clientMetadata = mergeOfficialCodexClientMetadata(null, input.codexClientMetadata)
  if (clientMetadata) {
    requestBody.client_metadata = clientMetadata
  }

  if (shouldSendAutoTruncation(input.model, modelConfig)) {
    requestBody.truncation = "auto"
  }

  if (modelConfig.isReasoningModel) {
    const reasoning = input.reasoningEffort
      ? buildForcedReasoningPayloadForModel(input.model, input.reasoningEffort)
      : buildReasoningPayloadForModel(input.model, null)
    if (reasoning) {
      requestBody.reasoning = reasoning
    }
  }

  const textConfig = buildTextConfigForModel(input.model)
  if (textConfig) {
    requestBody.text = textConfig
  }

  return requestBody
}

function normalizeCursorTextContent(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = content
    .map((part) => {
      const record = asRecord(part)
      if (!record) return ""
      const type = normalizeNullableString(record.type, 64)
      if (type === "text" || type === "input_text") {
        return String(pickFirstDefinedValue(record.text, record.input_text) ?? "")
      }
      return ""
    })
    .filter((item) => item.length > 0)
  return parts.join("\n")
}

function convertCursorMessagesToResponsesInput(messages: Array<Record<string, unknown>>) {
  const input: Array<Record<string, unknown>> = []

  for (const message of messages) {
    const role = normalizeNullableString(message.role, 32)
    if (!role) continue
    if (role === "system" || role === "developer") continue
    const text = normalizeCursorTextContent(message.content)
    if (role === "tool") {
      const toolCallId = normalizeNullableString(
        pickFirstDefinedValue(message.tool_call_id, message.toolCallId, message.call_id, message.callId),
        200,
      )
      if (toolCallId) {
        input.push({
          type: "function_call_output",
          call_id: toolCallId,
          output: text,
        })
        continue
      }
    }

    const contentParts: Array<Record<string, unknown>> = []
    if (text) {
      contentParts.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text,
      })
    }

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawToolCall of message.tool_calls) {
        const toolCall = asRecord(rawToolCall)
        const fn = asRecord(toolCall?.function)
        const name = normalizeNullableString(fn?.name, 200)
        if (!name) continue
        const callId = normalizeNullableString(toolCall?.id, 200) ?? crypto.randomUUID()
        contentParts.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
        })
      }
    }

    if (contentParts.length === 0) continue
    const item: Record<string, unknown> = {
      role,
      content: contentParts,
    }
    const name = normalizeNullableString(message.name, 200)
    if (name) item.name = name
    input.push(item)
  }

  return input
}

function buildCursorResponsesInstructions(messages: Array<Record<string, unknown>>) {
  const segments: string[] = []
  const baseInstructions = String(CHAT_INSTRUCTIONS ?? "").trim()
  if (baseInstructions.length > 0) segments.push(baseInstructions)

  for (const message of messages) {
    const role = normalizeNullableString(message.role, 32)
    if (role !== "system" && role !== "developer") continue
    const text = normalizeCursorTextContent(message.content)
    if (!text) continue
    const name = normalizeNullableString(message.name, 200)
    const label = role === "developer" ? "Developer instruction" : "System instruction"
    segments.push(name ? `${label} (${name}):\n${text}` : `${label}:\n${text}`)
  }

  return segments.join("\n\n").trim()
}

function convertCursorToolsToResponsesTools(tools: Array<Record<string, unknown>>) {
  const converted: Array<Record<string, unknown>> = []
  for (const rawTool of tools) {
    const tool = asRecord(rawTool)
    if (!tool) continue
    const type = normalizeNullableString(tool.type, 64) ?? "function"
    if (type !== "function") continue
    const fn = asRecord(tool.function)
    const name = normalizeNullableString(fn?.name, 200)
    if (!name) continue
    converted.push({
      type: "function",
      name,
      description: normalizeNullableString(fn?.description, 4000) ?? undefined,
      parameters: asRecord(fn?.parameters) ?? {},
    })
  }
  return converted
}

function convertCursorToolChoice(toolChoice: unknown) {
  if (typeof toolChoice === "string") {
    const normalized = toolChoice.trim()
    if (normalized === "auto" || normalized === "none" || normalized === "required") return normalized
    return undefined
  }
  const record = asRecord(toolChoice)
  if (!record) return undefined
  const fn = asRecord(record.function)
  const name = normalizeNullableString(fn?.name, 200)
  if (!name) return undefined
  return {
    type: "function",
    name,
  }
}

function buildCursorResponsesRequestBody(input: {
  model: string
  sessionId?: string | null
  accountId?: string | null
  messages: Array<Record<string, unknown>>
  tools: Array<Record<string, unknown>>
  toolChoice?: unknown
  temperature?: number
  maxTokens?: number
  parallelToolCalls?: boolean
  reasoningEffort?: string | null
  stream?: boolean
  codexClientMetadata?: Record<string, string> | null
}) {
  const payloadInput = convertCursorMessagesToResponsesInput(input.messages)
  const instructions = buildCursorResponsesInstructions(input.messages)
  const modelConfig = getResponsesModelConfig(input.model)
  const promptCacheKey = rewriteClientIdentifierForUpstream({
    accountId: input.accountId,
    fieldKey: "prompt_cache_key",
    value: input.sessionId ?? undefined,
    strictPrivacy: isStrictUpstreamPrivacyEnabled(),
  })

  const requestBody: Record<string, unknown> = {
    model: input.model,
    input: payloadInput,
    store: false,
    instructions,
    stream: true,
  }

  if (promptCacheKey) {
    requestBody.prompt_cache_key = promptCacheKey
  }
  if (shouldSendAutoTruncation(input.model, modelConfig)) {
    requestBody.truncation = "auto"
  }
  if (Number.isFinite(Number(input.temperature))) {
    requestBody.temperature = Number(input.temperature)
  }
  if (Number.isFinite(Number(input.maxTokens)) && Number(input.maxTokens) > 0) {
    requestBody.max_output_tokens = Math.floor(Number(input.maxTokens))
  }
  if (input.parallelToolCalls !== undefined) {
    requestBody.parallel_tool_calls = Boolean(input.parallelToolCalls)
  }

  const clientMetadata = mergeOfficialCodexClientMetadata(null, input.codexClientMetadata)
  if (clientMetadata) {
    requestBody.client_metadata = clientMetadata
  }

  const toolDefs = convertCursorToolsToResponsesTools(input.tools)
  if (toolDefs.length > 0) {
    requestBody.tools = toolDefs
    const toolChoice = convertCursorToolChoice(input.toolChoice)
    if (toolChoice !== undefined) requestBody.tool_choice = toolChoice
  } else if (typeof input.toolChoice === "string" && input.toolChoice.trim() === "none") {
    requestBody.tool_choice = "none"
  }

  if (modelConfig.isReasoningModel) {
    const reasoning = input.reasoningEffort
      ? buildForcedReasoningPayloadForModel(input.model, input.reasoningEffort)
      : buildReasoningPayloadForModel(input.model, null)
    if (reasoning) {
      requestBody.reasoning = reasoning
    }
  }

  const textConfig = buildTextConfigForModel(input.model)
  if (textConfig) {
    requestBody.text = textConfig
  }

  return requestBody
}

function buildCursorUsagePayload(usage: UsageMetrics) {
  const payload: Record<string, unknown> = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  }
  if (usage.cachedInputTokens > 0) {
    payload.prompt_tokens_details = { cached_tokens: usage.cachedInputTokens }
  }
  if (usage.reasoningOutputTokens > 0) {
    payload.completion_tokens_details = { reasoning_tokens: usage.reasoningOutputTokens }
  }
  return payload
}

function extractCursorToolCallFromResponseItem(rawItem: unknown) {
  const item = asRecord(rawItem)
  if (!item) return null
  const itemType = normalizeNullableString(item.type, 64)
  if (itemType === "function_call" || itemType === "tool_call") {
    const name = normalizeNullableString(pickFirstDefinedValue(item.name, asRecord(item.function)?.name), 200)
    if (!name) return null
    return {
      id: normalizeNullableString(pickFirstDefinedValue(item.call_id, item.id), 200) ?? crypto.randomUUID(),
      type: "function",
      function: {
        name,
        arguments:
          typeof pickFirstDefinedValue(item.arguments, asRecord(item.function)?.arguments) === "string"
            ? String(pickFirstDefinedValue(item.arguments, asRecord(item.function)?.arguments))
            : JSON.stringify(pickFirstDefinedValue(item.arguments, asRecord(item.function)?.arguments) ?? {}),
      },
    } satisfies Record<string, unknown>
  }

  const content = Array.isArray(item.content) ? item.content : []
  for (const rawContent of content) {
    const contentItem = asRecord(rawContent)
    if (!contentItem) continue
    const contentType = normalizeNullableString(contentItem.type, 64)
    if (contentType !== "function_call") continue
    const name = normalizeNullableString(contentItem.name, 200)
    if (!name) continue
    return {
      id: normalizeNullableString(pickFirstDefinedValue(contentItem.call_id, contentItem.id), 200) ?? crypto.randomUUID(),
      type: "function",
      function: {
        name,
        arguments:
          typeof contentItem.arguments === "string" ? contentItem.arguments : JSON.stringify(contentItem.arguments ?? {}),
      },
    } satisfies Record<string, unknown>
  }

  return null
}

function extractCursorToolCallsFromResponsePayload(payload: unknown) {
  const output = Array.isArray(asRecord(payload)?.output) ? (asRecord(payload)?.output as Array<unknown>) : []
  const toolCalls: Array<Record<string, unknown>> = []
  for (const rawItem of output) {
    const toolCall = extractCursorToolCallFromResponseItem(rawItem)
    if (toolCall) toolCalls.push(toolCall)
  }
  return toolCalls
}

function extractCursorFinishReasonFromResponsePayload(payload: unknown) {
  const record = asRecord(payload)
  const explicitFinishReason = normalizeNullableString(record?.finish_reason, 64)
  if (explicitFinishReason === "tool_calls") return "tool_calls"
  if (explicitFinishReason === "length" || explicitFinishReason === "max_output_tokens") return "length"
  if (extractCursorToolCallsFromResponsePayload(payload).length > 0) return "tool_calls"

  const status = normalizeNullableString(record?.status, 64)
  const incompleteDetails = asRecord(record?.incomplete_details)
  const incompleteReason = normalizeNullableString(
    pickFirstDefinedValue(incompleteDetails?.reason, incompleteDetails?.type, status),
    64,
  )
  if (
    incompleteReason === "max_output_tokens" ||
    incompleteReason === "max_completion_tokens" ||
    incompleteReason === "length" ||
    status === "incomplete"
  ) {
    return "length"
  }
  return "stop"
}

function buildCursorChatCompletionMessage(payload: unknown, fallbackText: string) {
  const toolCalls = extractCursorToolCallsFromResponsePayload(payload)
  const text = extractResponseText(payload) || fallbackText
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls.length > 0 ? (text || null) : text,
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return message
}

function buildCursorChatCompletionResponse(input: {
  payload: unknown
  model: string
  usage: UsageMetrics
  reply: string
}) {
  const record = asRecord(input.payload)
  const created = normalizeNonNegativeInt(record?.created_at ?? record?.created) || Math.floor(Date.now() / 1000)
  const id = normalizeNullableString(record?.id, 200) ?? `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`
  const message = buildCursorChatCompletionMessage(input.payload, input.reply)
  const finishReason = extractCursorFinishReasonFromResponsePayload(input.payload)
  return {
    id,
    object: "chat.completion",
    created,
    model: input.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: buildCursorUsagePayload(input.usage),
  }
}

function extractCursorChatCompletionText(payload: unknown): string {
  const record = asRecord(payload)
  const choices = Array.isArray(record?.choices) ? record.choices : []
  const firstChoice = asRecord(choices[0])
  const message = asRecord(firstChoice?.message)
  const content = message?.content
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") return item
        const part = asRecord(item)
        return (
          normalizeNullableString(part?.text, 16000) ??
          normalizeNullableString(part?.input_text, 16000) ??
          ""
        )
      })
      .filter(Boolean)
    if (parts.length > 0) {
      return parts.join("")
    }
  }
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (toolCalls.length > 0) {
    return "(tool calls)"
  }
  return ""
}

function extractOpenAICompatibleErrorMessage(payload: unknown): string {
  const record = asRecord(payload)
  const error = asRecord(record?.error)
  return (
    normalizeNullableString(pickFirstDefinedValue(error?.message, error?.detail, record?.message), 16000) ?? ""
  )
}

function encodeCursorSseChunk(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function streamCursorChatCompletionFromResponses(input: {
  upstream: Response
  model: string
  accountId: string
  keyId: string
  auditId?: string
  providerId?: string | null
  virtualKeyId?: string | null
  sessionId?: string | null
  reasoningEffort?: string | null
  includeUsage?: boolean
}) {
  const streamId = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`
  const created = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = input.upstream.body?.getReader()
  if (!reader) {
    throw new Error("Cursor upstream stream body is empty")
  }
  let buffer = ""
  let roleSent = false
  let reply = ""
  let latestUsage = emptyUsageMetrics()
  let finishReason = "stop"
  let pendingToolCalls: Array<Record<string, unknown>> = []
  const emittedToolCallIds = new Set<string>()
  const toolCallIndexById = new Map<string, number>()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => controller.enqueue(encoder.encode(encodeCursorSseChunk(payload)))
      const sendRoleIfNeeded = () => {
        if (roleSent) return
        roleSent = true
        send({
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: input.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        })
      }

      const emitToolCalls = (toolCalls: Array<Record<string, unknown>>) => {
        if (!toolCalls.length) return
        sendRoleIfNeeded()
        for (const toolCall of toolCalls) {
          const rawId = normalizeNullableString(toolCall.id, 200) ?? crypto.randomUUID()
          if (emittedToolCallIds.has(rawId)) continue
          emittedToolCallIds.add(rawId)
          const index = toolCallIndexById.size
          toolCallIndexById.set(rawId, index)
          send({
            id: streamId,
            object: "chat.completion.chunk",
            created,
            model: input.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      ...toolCall,
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })
        }
      }

      const finalize = () => {
        if (pendingToolCalls.length > 0) {
          emitToolCalls(pendingToolCalls)
        }
        send({
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: input.model,
          choices: [
            {
              index: 0,
              delta: {},
                finish_reason: finishReason,
              },
            ],
        })
        if (input.includeUsage) {
          send({
            id: streamId,
            object: "chat.completion.chunk",
            created,
            model: input.model,
            choices: [],
            usage: buildCursorUsagePayload(latestUsage),
          })
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
        recordUsageMetrics({
          accountId: input.accountId,
          keyId: input.keyId,
          usage: latestUsage,
          source: "cursor-chat-stream",
          auditId: input.auditId,
          providerId: input.providerId ?? null,
          virtualKeyId: input.virtualKeyId ?? input.keyId ?? null,
          model: input.model,
          sessionId: input.sessionId ?? null,
          reasoningEffort: input.reasoningEffort ?? null,
        })
      }

      const consumeChunk = (chunk: string) => {
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data:\s*/, ""))
          .join("\n")
          .trim()
        if (!data || data === "[DONE]") return
        const event = tryParseJsonText(data)
        if (!event || typeof event !== "object") return
        const latestEventUsage = extractUsageFromUnknown(event)
        if (hasUsageDelta(latestEventUsage)) {
          latestUsage = latestEventUsage
        }
        const eventRecord = asRecord(event)
        const type = normalizeNullableString(eventRecord?.type, 96) ?? ""
        if (type === "response.output_text.delta") {
          const delta = typeof eventRecord?.delta === "string" ? eventRecord.delta : ""
          if (!delta) return
          reply += delta
          sendRoleIfNeeded()
          send({
            id: streamId,
            object: "chat.completion.chunk",
            created,
            model: input.model,
            choices: [
              {
                index: 0,
                delta: { content: delta },
                finish_reason: null,
              },
            ],
          })
          return
        }
        if (type === "response.output_item.added" || type === "response.output_item.done") {
          const toolCall = extractCursorToolCallFromResponseItem(eventRecord?.item)
          if (!toolCall) return
          finishReason = "tool_calls"
          emitToolCalls([toolCall])
          return
        }
        if (type === "response.completed") {
          const responsePayload = eventRecord?.response
          const completedUsage = extractUsageFromUnknown(responsePayload)
          if (hasUsageDelta(completedUsage)) latestUsage = completedUsage
          finishReason = extractCursorFinishReasonFromResponsePayload(responsePayload)
          const toolCalls = extractCursorToolCallsFromResponsePayload(responsePayload)
          if (toolCalls.length > 0) {
            pendingToolCalls = toolCalls
          }
          return
        }
        if (type === "response.failed" || type === "error") {
          throw new Error(data)
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) consumeChunk(chunk)
        }
        buffer += decoder.decode()
        if (buffer.trim().length > 0) consumeChunk(buffer)
        finalize()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

function toOpenAICompatibleErrorResponse(message: string, status = 400, type = "invalid_request_error") {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    },
  )
}

async function ensureChatgptAccountAccess(account: StoredAccount) {
  if (account.providerId !== "chatgpt") {
    throw new Error("Only ChatGPT OAuth accounts are supported in this flow")
  }

  let accessToken = account.accessToken
  let accountId = account.accountId ?? undefined
  let expiresAt = account.expiresAt ?? undefined

  if (!accessToken || isTokenExpired(account)) {
    return refreshChatgptAccountAccess(account)
  }

  return {
    accessToken,
    refreshToken: account.refreshToken ?? undefined,
    idToken: account.idToken ?? undefined,
    accountId,
    expiresAt,
  }
}

async function resolveUpstreamAccountAuth(account: StoredAccount, options?: { forceRefresh?: boolean }) {
  const profile = resolveUpstreamProfileForAccount(account)
  if (profile.providerMode === "openai") {
    const accessToken = String(account.accessToken ?? "").trim()
    if (!accessToken) {
      throw new Error("API key is not available for this account")
    }
    return {
      accessToken,
      accountId: undefined as string | undefined,
    }
  }

  if (options?.forceRefresh) {
    return refreshChatgptAccountAccess(account)
  }
  return ensureChatgptAccountAccess(account)
}

async function trackUsageFromJsonStream(input: {
  accountId: string
  keyId?: string
  stream: ReadableStream<Uint8Array>
  auditId?: string
  providerId?: string | null
  virtualKeyId?: string | null
  model?: string | null
  sessionId?: string | null
  reasoningEffort?: string | null
}) {
  try {
    const text = await new Response(input.stream).text()
    if (!text) return
    const parsed = await extractUsageFromStructuredResponseText(text)
    const usage = parsed.usage
    if (hasUsageDelta(usage)) {
      recordUsageMetrics({
        accountId: input.accountId,
        keyId: input.keyId,
        usage,
        source: "proxy-json",
        auditId: input.auditId,
        providerId: input.providerId ?? null,
        virtualKeyId: input.virtualKeyId ?? input.keyId ?? null,
        model: input.model ?? null,
        sessionId: input.sessionId ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
      })
      return
    }
    if (!parsed.matched) {
      console.warn(
        `[oauth-multi-login] usage track failed source=proxy-json account=${input.accountId} key=${input.keyId ?? "-"} reason=invalid_json_or_usage_payload`,
      )
    }
  } catch {
    console.warn(
      `[oauth-multi-login] usage track failed source=proxy-json account=${input.accountId} key=${input.keyId ?? "-"} reason=invalid_json_or_usage_payload`,
    )
  }
}

function createUsageTrackingProxyStream(input: {
  stream: ReadableStream<Uint8Array>
  accountId: string
  keyId?: string
  auditId?: string
  providerId?: string | null
  virtualKeyId?: string | null
  model?: string | null
  sessionId?: string | null
  reasoningEffort?: string | null
  source: "proxy-stream" | "proxy-json"
}) {
  const decoder = new TextDecoder()
  let text = ""
  let truncated = false

  const finalizeUsage = async () => {
    try {
      if (truncated || !text) return
      const parsed = await extractUsageFromStructuredResponseText(text)
      const usage = parsed.usage
      if (!hasUsageDelta(usage)) return
      recordUsageMetrics({
        accountId: input.accountId,
        keyId: input.keyId,
        usage,
        source: input.source,
        auditId: input.auditId,
        providerId: input.providerId ?? null,
        virtualKeyId: input.virtualKeyId ?? input.keyId ?? null,
        model: input.model ?? null,
        sessionId: input.sessionId ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
      })
    } catch (error) {
      console.warn(
        `[oauth-multi-login] usage track failed source=${input.source} account=${input.accountId} key=${input.keyId ?? "-"} reason=${errorMessage(error)}`,
      )
    }
  }

  return input.stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        if (truncated || chunk.byteLength === 0) return
        const decoded = decoder.decode(chunk, { stream: true })
        const remaining = USAGE_TRACK_MAX_TEXT_CHARS - text.length
        if (decoded.length <= remaining) {
          text += decoded
          return
        }
        if (remaining > 0) text += decoded.slice(0, remaining)
        truncated = true
      },
      flush() {
        if (!truncated) {
          const tail = decoder.decode()
          const remaining = USAGE_TRACK_MAX_TEXT_CHARS - text.length
          if (tail.length <= remaining) {
            text += tail
          } else {
            if (remaining > 0) text += tail.slice(0, remaining)
            truncated = true
          }
        }
        handleBackgroundPromise(`trackUsageFromResponseStream:${input.source}`, finalizeUsage())
      },
    }),
  )
}

async function refreshChatgptAccountAccess(account: StoredAccount) {
  if (account.providerId !== "chatgpt") {
    throw new Error("Only ChatGPT OAuth accounts are supported in this flow")
  }
  const provider = providers.getProvider(account.providerId)
  const refreshToken = account.refreshToken ?? undefined
  if (!refreshToken) {
    throw new Error("Account refresh token is not available")
  }
  if (!provider?.refresh) {
    throw new Error(`Provider ${account.providerId} does not support refresh in this flow`)
  }

  let refreshed: RefreshResult | null
  try {
    refreshed = await provider.refresh(account)
  } catch (error) {
    const blocked = detectRoutingBlockedAccount({
      error,
    })
    if (blocked.matched) {
      markAccountUnhealthy(account.id, blocked.reason, "refresh")
    }
    throw error
  }
  if (!refreshed) {
    markAccountUnhealthy(account.id, "refresh_token_missing", "refresh")
    throw new Error("No refresh token available for this account")
  }

  const next = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshToken,
    idToken: refreshed.idToken ?? account.idToken ?? undefined,
    expiresAt: refreshed.expiresAt ?? Date.now() + 3600 * 1000,
    accountId: refreshed.accountId ?? account.accountId ?? undefined,
  }
  accountStore.updateTokens({
    id: account.id,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    idToken: next.idToken,
    expiresAt: next.expiresAt,
    accountId: next.accountId,
  })
  markAccountHealthy(account.id, "refresh")
  return next
}

async function refreshChatgptAccountAccessForLocalCodex(account: StoredAccount) {
  if (account.providerId !== "chatgpt") {
    throw new Error("Only ChatGPT OAuth accounts are supported in this flow")
  }
  const provider = providers.getProvider(account.providerId)
  const refreshToken = account.refreshToken ?? undefined
  if (!refreshToken) {
    throw new Error("Account refresh token is not available")
  }
  if (!provider?.refresh) {
    throw new Error(`Provider ${account.providerId} does not support refresh in this flow`)
  }

  const refreshed = await provider.refresh(account)
  if (!refreshed) {
    throw new Error("No refresh token available for this account")
  }

  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshToken,
    idToken: refreshed.idToken ?? account.idToken ?? undefined,
    expiresAt: refreshed.expiresAt ?? Date.now() + 3600 * 1000,
    accountId: refreshed.accountId ?? account.accountId ?? undefined,
    refreshed: true,
  }
}

async function resolveCodexLocalAuthTokens(account: StoredAccount) {
  const storedAccessToken = account.accessToken ?? undefined
  const storedRefreshToken = account.refreshToken ?? undefined
  const storedIdToken = account.idToken ?? undefined
  const storedExpiresAt = account.expiresAt ?? 0
  const storedAccountId = account.accountId ?? undefined

  if (storedAccessToken && storedRefreshToken && storedIdToken && !isTokenExpired(account)) {
    if (storedAccountId) ensureForcedWorkspaceAllowed(storedAccountId)
    return {
      accessToken: storedAccessToken,
      refreshToken: storedRefreshToken,
      idToken: storedIdToken,
      expiresAt: storedExpiresAt,
      accountId: storedAccountId,
      refreshed: false,
    }
  }

  return refreshChatgptAccountAccessForLocalCodex(account)
}

async function loginCodexLocalAuth(account: StoredAccount, input: { restartCodexApp?: boolean }) {
  if (account.providerId !== "chatgpt") {
    throw new Error("Only ChatGPT OAuth accounts can be written to Codex local login")
  }
  if (!account.refreshToken) {
    throw new Error("Account refresh token is not available")
  }

  const latest = accountStore.get(account.id) ?? account
  const localTokens = await resolveCodexLocalAuthTokens(latest)
  const idToken = localTokens.idToken ?? latest.idToken ?? account.idToken ?? undefined
  const refreshToken = localTokens.refreshToken ?? latest.refreshToken ?? account.refreshToken ?? undefined
  const accountId = localTokens.accountId ?? latest.accountId ?? account.accountId ?? undefined

  if (!idToken) {
    throw new Error("Codex local login requires id_token; refresh this account with the latest OAuth flow first")
  }
  if (!refreshToken) {
    throw new Error("Codex local login requires refresh_token")
  }

  const result = await writeCodexLocalAuth({
    account: latest,
    tokens: {
      accessToken: localTokens.accessToken,
      refreshToken,
      idToken,
      accountId,
    },
    restartCodexApp: input.restartCodexApp !== false,
  })
  return {
    codexLocalAuth: {
      accountId: latest.id,
      email: latest.email,
      displayName: latest.displayName,
      providerId: latest.providerId,
      refreshedForLocalAuth: localTokens.refreshed,
      writtenAt: Date.now(),
      ...result,
    },
  }
}

async function runChatWithAccount(input: {
  account: StoredAccount
  model: string
  message: string
  sessionId?: string
  historyNamespace: string
  keyId?: string
  behaviorSignal?: ReturnType<typeof resolveBehaviorSignal>
  reasoningEffort?: string | null
}) {
  if (input.account.providerId !== "chatgpt") {
    throw new Error("Only ChatGPT OAuth accounts support this chat endpoint")
  }
  ensureAutomaticAccountAvailable(input.account)

  const sessionId = input.sessionId || crypto.randomUUID()
  const auth = await ensureChatgptAccountAccess(input.account)
  const accessToken = auth.accessToken
  const accountId = auth.accountId
  const boundSessionId = rewriteClientIdentifierForUpstream({
    accountId: input.account.id,
    fieldKey: "session_id",
    value: sessionId,
    strictPrivacy: isStrictUpstreamPrivacyEnabled(),
  })

  const headers = appendResponsesProtocolHeaders(
    new Headers({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      originator: CODEX_ORIGINATOR,
      "User-Agent": CODEX_USER_AGENT,
      session_id: boundSessionId,
      "x-client-request-id": boundSessionId,
    }),
    { sessionRouteId: sessionId },
  )

  if (accountId) {
    headers.set("ChatGPT-Account-ID", accountId)
  }

  const modelConfig = getResponsesModelConfig(input.model)
  const systemSections = await buildSystemSections(input.model)
  const historyKey = `${input.historyNamespace}:${input.model}:${sessionId}`
  const history = chatHistory.get(historyKey) ?? []
  const payloadInput = buildInputWithHistory(systemSections, history, input.message, modelConfig.systemMessageMode)
  const requestBody = buildCodexRequestBody({
    model: input.model,
    sessionId,
    accountId: input.account.id,
    payloadInput,
    reasoningEffort: input.reasoningEffort ?? null,
    codexClientMetadata: buildResponsesClientMetadata({
      sessionRouteId: sessionId,
    }),
  })
  const requestBodyBytes = new TextEncoder().encode(JSON.stringify(requestBody))
  const behaviorSignal = input.behaviorSignal ?? {
    clientTag: input.keyId ? `virtual_key_chat:${input.keyId}` : `chat:${input.account.id}`,
    egressKind: "unknown" as const,
  }
  const behaviorDecision = await behaviorController.acquire({
    accountId: input.account.id,
    signal: behaviorSignal,
  })
  if (!behaviorDecision.ok) {
    throw createBehaviorAcquireError(behaviorDecision)
  }

  let chatResponse: Response
  try {
    chatResponse = (
      await requestUpstreamWithPolicy({
        url: CODEX_RESPONSES_ENDPOINT,
        method: "POST",
        headers,
        body: requestBodyBytes,
        accountId: input.account.id,
        routeTag: "/api/chat",
        policyOverride: INTERACTIVE_FAST_RETRY_POLICY,
        recordBehaviorResult: true,
      })
    ).response

    if (chatResponse.status === 401) {
      maybeResetResponsesTurnState(sessionId, chatResponse.status)
      const latest = accountStore.get(input.account.id) ?? input.account
      const refreshed = await refreshChatgptAccountAccess(latest)
      headers.set("authorization", `Bearer ${refreshed.accessToken}`)
      if (refreshed.accountId) {
        headers.set("ChatGPT-Account-ID", refreshed.accountId)
      } else {
        headers.delete("ChatGPT-Account-ID")
      }
      chatResponse = (
        await requestUpstreamWithPolicy({
          url: CODEX_RESPONSES_ENDPOINT,
          method: "POST",
          headers,
          body: requestBodyBytes,
          accountId: input.account.id,
          routeTag: "/api/chat",
          policyOverride: INTERACTIVE_FAST_RETRY_POLICY,
          recordBehaviorResult: true,
        })
      ).response
    }
  } finally {
    behaviorDecision.release()
  }

  if (!chatResponse.ok) {
    const body = await chatResponse.text().catch(() => "")
    const quotaSignal = await detectQuotaExhaustedUpstreamResponse(
      new Response(body, {
        status: chatResponse.status,
        headers: chatResponse.headers,
      }),
    )
    const blocked = detectRoutingBlockedAccount({
      statusCode: chatResponse.status,
      text: body,
    })
    if (quotaSignal.matched) {
      markAccountQuotaExhausted(input.account.id)
      handleBackgroundPromise(
        "refreshAndEmitAccountQuota:chat-usage-limit-reached",
        refreshAndEmitAccountQuota(input.account.id, "chat-usage-limit-reached"),
      )
    } else if (blocked.matched) {
      markAccountUnhealthy(input.account.id, blocked.reason, "chat")
      evictAccountModelsCache(input.account.id)
    }
    const error = new Error(`Codex request failed (${chatResponse.status}): ${body}`) as Error & {
      statusCode?: number
      upstreamBody?: string
    }
    error.statusCode = chatResponse.status
    error.upstreamBody = body
    throw error
  }

  const { payload, reply, usage: streamUsage } = await readCodexStream(chatResponse)
  const usage = hasUsageDelta(streamUsage) ? streamUsage : normalizeUsage(payload)
  recordUsageMetrics({
    accountId: input.account.id,
    keyId: input.keyId,
    usage,
    source: input.keyId ? "virtual-key-chat" : "chat",
  })

  history.push({ role: "user", text: input.message })
  if (reply) history.push({ role: "assistant", text: reply })
  if (history.length > 80) history.splice(0, history.length - 80)
  chatHistory.set(historyKey, history)
  markAccountHealthy(input.account.id, "chat")

  return {
    reply,
    usage,
    model: input.model,
    account: accountStore.get(input.account.id),
    raw: payload,
    sessionId,
  }
}

function resolveWebAssetContentType(filepath: string) {
  switch (path.extname(filepath).toLowerCase()) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".json":
    case ".map":
      return "application/json; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".ico":
      return "image/x-icon"
    default:
      return "application/octet-stream"
  }
}

function serveWebAsset(requestPath: string) {
  const webRoot = path.resolve(AppConfig.webDir)
  const normalizedRelativePath = String(requestPath || "")
    .replace(/^\/+/, "")
    .replace(/\//g, path.sep)
  const targetPath = path.resolve(webRoot, normalizedRelativePath)
  if (!(targetPath === webRoot || targetPath.startsWith(`${webRoot}${path.sep}`))) {
    return new Response("Not found", { status: 404 })
  }
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    return new Response("Not found", { status: 404 })
  }
  return new Response(Bun.file(targetPath), {
    headers: {
      "Content-Type": resolveWebAssetContentType(targetPath),
      "Cache-Control": "no-store",
    },
  })
}

app.get("/app/*", (c) => serveWebAsset(c.req.path))

app.get("/", async () => {
  const htmlFile = Bun.file(AppConfig.indexHtmlPath)
  if (!(await htmlFile.exists())) {
    return new Response(`UI file not found: ${AppConfig.indexHtmlPath}`, { status: 500 })
  }
  return new Response(htmlFile, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
})

app.get("/api/health", () =>
  Response.json({
    ok: true,
    name: AppConfig.name,
    timestamp: Date.now(),
    pid: process.pid,
    runtime: {
      instanceId: process.env.OAUTH_APP_INSTANCE_ID ?? null,
      serverExecutable: process.env.OAUTH_APP_SERVER_EXE ?? process.execPath,
      serverBuildId: process.env.OAUTH_APP_SERVER_BUILD_ID ?? null,
      dataDir: process.env.OAUTH_APP_DATA_DIR ?? null,
      webDir: process.env.OAUTH_APP_WEB_DIR ?? null,
    },
    managementAuthEnabled: Boolean(getEffectiveManagementToken()),
    forwardProxyEnabled: Boolean(forwardProxy),
    forwardProxyPort: forwardProxy ? FORWARD_PROXY_PORT : null,
    forwardProxyAllowedHosts: FORWARD_PROXY_ALLOWED_HOSTS,
  }),
)

function createEventStreamResponse(c: any) {
  const id = crypto.randomUUID()
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(usageEventEncoder.encode(`: ping ${Date.now()}\n\n`))
        } catch {
          cleanup()
        }
      }, 5000)

      usageEventClients.set(id, { controller, heartbeat })
      controller.enqueue(usageEventEncoder.encode(`event: ready\ndata: {"type":"ready","at":${Date.now()}}\n\n`))
      notifyHealth()
    },
    cancel() {
      cleanup()
    },
  })

  cleanup = () => {
    const client = usageEventClients.get(id)
    if (!client) return
    clearInterval(client.heartbeat)
    usageEventClients.delete(id)
  }

  c.req.raw.signal?.addEventListener("abort", cleanup, { once: true })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

app.get("/api/events", (c) => createEventStreamResponse(c))
app.get("/api/events/usage", (c) => createEventStreamResponse(c))
app.post("/api/events/token", (c) => {
  const issued = issueEventStreamToken()
  return c.json({
    token: issued.token,
    expiresAt: issued.expiresAt,
  })
})

function buildSettingsPayload(now = Date.now()) {
  const serviceInfo = getSafeServiceAddressInfo(AppConfig.host, AppConfig.port)
  return {
    localServiceAddress: runtimeSettings.localServiceAddress,
    activeLocalServiceAddress: serviceInfo.activeLocalServiceAddress,
    bindServiceAddress: serviceInfo.bindServiceAddress,
    lanServiceAddresses: serviceInfo.lanServiceAddresses,
    preferredClientServiceAddress: serviceInfo.preferredClientServiceAddress,
    managementAuthEnabled: Boolean(getEffectiveManagementToken()),
    encryptionKeyConfigured: Boolean(getEffectiveEncryptionKey()),
    upstreamPrivacyStrict: isStrictUpstreamPrivacyEnabled(),
    officialStrictPassthrough: isOfficialStrictPassthroughEnabled(),
    themeId: normalizeUiThemeId(runtimeSettings.themeId),
    restartRequired: true,
    statsTimezone: STATS_TIMEZONE,
    pricingMode: PRICING_MODE,
    pricingCatalogVersion: PRICING_CATALOG_VERSION,
    serviceStatusSummary: buildServiceStatusSummary(now),
  }
}

async function persistSettings(input: z.infer<typeof UpdateSettingsSchema>) {
  const normalized = normalizeLocalServiceAddress(input.localServiceAddress)
  const nextAdminToken = input.adminToken === undefined ? String(runtimeSettings.adminToken ?? "").trim() : String(input.adminToken ?? "").trim()
  const nextEncryptionKey =
    input.encryptionKey === undefined ? String(runtimeSettings.encryptionKey ?? "").trim() : String(input.encryptionKey ?? "").trim()
  const nextUpstreamPrivacyStrict =
    input.upstreamPrivacyStrict === undefined ? runtimeSettings.upstreamPrivacyStrict !== false : Boolean(input.upstreamPrivacyStrict)
  const nextOfficialStrictPassthrough =
    input.officialStrictPassthrough === undefined
      ? runtimeSettings.officialStrictPassthrough === true
      : Boolean(input.officialStrictPassthrough)
  const nextThemeId =
    input.themeId === undefined ? normalizeUiThemeId(runtimeSettings.themeId) : normalizeUiThemeId(input.themeId)
  const effectiveEncryptionKey = String(AppConfig.encryptionKey ?? "").trim() || nextEncryptionKey
  const warnings: string[] = []
  if (normalized) {
    const parsed = new URL(normalized)
    if (isNonLoopbackBindingHost(parsed.hostname) && !effectiveEncryptionKey) {
      warnings.push(
        "Non-loopback local service address was saved, but OAUTH_APP_ENCRYPTION_KEY is not configured. Desktop startup will fall back to 127.0.0.1.",
      )
    }
  }
  runtimeSettings.localServiceAddress = normalized
  runtimeSettings.adminToken = nextAdminToken
  runtimeSettings.encryptionKey = nextEncryptionKey
  runtimeSettings.upstreamPrivacyStrict = nextUpstreamPrivacyStrict
  runtimeSettings.officialStrictPassthrough = nextOfficialStrictPassthrough
  runtimeSettings.themeId = nextThemeId
  await saveRuntimeSettings(runtimeSettings)
  return {
    settings: buildSettingsPayload(),
    warnings,
  }
}

registerSettingsRoutes(app, {
  getSettings: () => buildSettingsPayload(),
  parseUpdateSettingsInput: (raw) => UpdateSettingsSchema.parse(raw),
  saveSettings: persistSettings,
  errorMessage,
})

app.post("/api/system/open-url", async (c) => {
  try {
    const raw = await c.req.json()
    const input = OpenExternalUrlSchema.parse(raw)
    const opened = openExternalUrl(input.url)
    return c.json({ success: true, opened })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.get("/api/bootstrap/logs", async (c) => {
  try {
    if (!existsSync(AppConfig.bootstrapLogFile)) {
      return c.json({ logs: [] })
    }

    const content = await readFile(AppConfig.bootstrapLogFile, "utf8")
    const logs = content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { id: string; at: number; level: string; message: string; source?: string }
        } catch {
          return null
        }
      })
      .filter((item): item is { id: string; at: number; level: string; message: string; source?: string } => Boolean(item))
      .slice(-200)

    return c.json({ logs })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500)
  }
})

app.post("/api/bootstrap/logs/clear", async (c) => {
  try {
    await writeFile(AppConfig.bootstrapLogFile, "", "utf8")
    bootstrapLogState = getBootstrapLogState()
    emitServerEvent("bootstrap-updated", {
      type: "bootstrap-updated",
      at: Date.now(),
      reason: "cleared",
    })
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500)
  }
})

registerAuditRoutes(app, {
  accountStore,
  normalizeAuditLog,
  clearAuditOverlays: () => requestAuditOverlays.clear(),
  parseHeaderNumber,
})

registerDashboardRoutes(app, {
  buildDashboardMetrics,
})

app.get("/api/providers", () =>
  Response.json({
    providers: providers.listPublic(),
  }),
)

registerModelsRoutes(app, {
  resolveChatModelList,
  resolveDefaultChatModelId,
  resolveVirtualKeyContext,
  ensureResolvedPoolAccountConsistent,
  behaviorController,
  resolveBehaviorSignal,
  proxyOpenAIModelsRequest,
  getModelsSnapshot,
  extractModelEntryID,
  resolveUpstreamProfileForAccount,
  normalizeCaughtCodexFailure,
  getStatusErrorCode,
  errorMessage,
  isLikelyAuthError,
  resolveModelCatalogForCursorAccount,
  toOpenAICompatibleErrorResponse,
})

registerAccountRoutes(app, {
  accountStore,
  providers,
  accountQuotaCache,
  accountHealthCache,
  refreshAccountQuotaCache,
  refreshAndEmitAccountQuota,
  toPublicAccount,
  getUsageTotalsSnapshot,
  buildDashboardMetrics,
  emitAccountRateLimitsUpdated,
  resolvePublicAccountDerivedState,
  deleteAccountsWithSingleRouteKeys,
  buildApiKeyIdentity,
  normalizeIdentity,
  exportStoredOAuthAccount,
  importJsonOAuthAccount,
  importRefreshTokenOAuthAccount,
  loginCodexLocalAuth,
  invalidatePoolConsistency,
  evictAccountModelsCache,
  handleBackgroundPromise,
  markAccountHealthy,
  markAccountUnhealthy,
  detectRoutingBlockedAccount,
  errorMessage,
  hasSensitiveActionConfirmation,
  parseBulkDeleteAccounts: (raw) => BulkDeleteAccountsSchema.parse(raw),
  parseAddApiKeyAccount: (raw) => AddApiKeyAccountSchema.parse(raw),
  parseExportAccounts: (raw) => ExportAccountsSchema.parse(raw),
  parseImportJsonAccount: (raw) => ImportJsonAccountSchema.parse(raw),
  parseImportRtAccount: (raw) => ImportRtAccountSchema.parse(raw),
})

registerVirtualKeysRoutes(app, {
  accountStore,
  IssueVirtualKeySchema,
  RenameVirtualKeySchema,
  RenewVirtualKeySchema,
  UpdateVirtualKeySchema,
  getCachedPoolConsistencyResult,
  hasSensitiveActionConfirmation,
  errorMessage,
  setCodexOAuthBridgeBinding,
})

registerBridgeRoutes(app, {
  accountStore,
  parseSyncOAuthInput: (raw) => SyncOAuthSchema.parse(raw),
  parseJwtAuthClaims,
  normalizeIdentity,
  ensureForcedWorkspaceAllowed,
  buildOAuthIdentity: ({ email, accountId }) =>
    buildOAuthIdentity({
      email,
      accountId: accountId ?? undefined,
    }),
  invalidatePoolConsistency,
  handleBackgroundPromise,
  refreshAndEmitAccountQuota,
  toPublicAccount,
  errorMessage,
})

registerLoginRoutes(app, {
  loginSessions,
  parseStartLoginInput: (raw) => StartLoginSchema.parse(raw),
  parseCodeInput: (raw) => CodeSchema.parse(raw),
  errorMessage,
})

async function proxyVirtualKeyCodexRequest(c: any, upstreamPath = "/responses") {
  const startedAt = Date.now()
  const route = c.req.path
  const method = c.req.method
  const behaviorSignal = resolveBehaviorSignal(c.req.raw.headers)
  const clientTag = behaviorSignal.clientTag || null

  let auditProviderId: string | null = null
  let auditAccountId: string | null = null
  let auditKeyId: string | null = null
  let auditModel: string | null = null
  let auditSessionId: string | null = null
  let auditReasoningEffort: string | null = null
  let auditClientMode: "codex" | "cursor" | null = null
  let auditWireApi: "responses" | "chat_completions" | null = null
  let outgoingBody: Uint8Array | undefined = undefined
  let auditRoutingMode = "single"
  let proxyPressureLease: ProxyPressureLease | null = null
  const writeAudit = buildResponsesAuditWriter(route, method, () => ({
    reasoningEffort: auditReasoningEffort,
    clientMode: auditClientMode,
    wireApi: auditWireApi,
  }))

  try {
    const bearer = extractBearerToken(c.req.header("authorization"))
    if (!bearer) {
      writeAudit({
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: "Missing Authorization Bearer token",
        clientTag,
      })
      return c.json({ error: "Missing Authorization Bearer token" }, 401)
    }

    const contentType = c.req.header("content-type")
    const contentEncoding = c.req.header("content-encoding")
    const strictUpstreamPrivacy = isStrictUpstreamPrivacyEnabled()
    const declaredRequestBytes = parseHeaderNumber(c.req.header("content-length"))
    proxyPressureLease = await proxyRequestPressureLimiter.acquire({
      heavy: upstreamPath === "/responses/compact" || declaredRequestBytes >= PROXY_HEAVY_BODY_BYTES,
      label: route,
      signal: c.req.raw.signal,
    })
    outgoingBody = await readRequestBodyBytesWithLimit(c.req.raw)
    const requestBodyAnalysis = analyzeJsonRequestBody({
      body: outgoingBody,
      contentType,
      contentEncoding,
    })
    const sessionRouteId = resolveSessionRouteID({
      headers: c.req.raw.headers,
      requestUrl: c.req.url,
      bodySessionId: requestBodyAnalysis.sessionId,
    })
    const codexClientMetadata = buildResponsesClientMetadata({
      incoming: c.req.raw.headers,
      sessionRouteId,
    })
    const requestBodyBaseRoot =
      upstreamPath === "/responses/compact"
        ? stripResponsesClientMetadata(requestBodyAnalysis.parsedRoot)
        : withResponsesProtocolMetadata(requestBodyAnalysis.parsedRoot, {
            incoming: c.req.raw.headers,
            sessionRouteId,
          })
    auditSessionId = sessionRouteId ?? null

    const resolved = resolveVirtualApiKeyWithPoolFallback(bearer, sessionRouteId, {
      requestedModel: requestBodyAnalysis.model,
    })
    if (!resolved) {
      writeAudit({
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: "Invalid, revoked, or expired virtual API key",
        clientTag,
      })
      return c.json({ error: "Invalid, revoked, or expired virtual API key" }, 401)
    }

    const keyOverrides = resolveVirtualKeyRequestOverrides(resolved.key)
    const effectiveRequestedModel = keyOverrides.fixedModel ?? requestBodyAnalysis.model
    const effectiveRequestBodyBaseRoot = applyVirtualKeyOverridesToResponsesBody(requestBodyBaseRoot, keyOverrides)
    auditModel = effectiveRequestedModel
    auditReasoningEffort = keyOverrides.fixedReasoningEffort ?? requestBodyAnalysis.reasoningEffort

    const modeError = buildVirtualKeyModeError({
      key: resolved.key,
      expectedClientMode: "codex",
      expectedWireApi: "responses",
    })
    if (modeError) {
      writeAudit({
        virtualKeyId: resolved.key.id,
        providerId: resolved.key.providerId,
        statusCode: modeError.status,
        latencyMs: Date.now() - startedAt,
        error: modeError.error,
        clientTag,
      })
      return c.json({ error: modeError.error }, modeError.status)
    }

    const eligibleResolved = ensureResolvedPoolAccountEligible({
      resolved,
      sessionId: sessionRouteId,
      requestedModel: effectiveRequestedModel,
    })
    if (!eligibleResolved) {
      writeAudit({
        virtualKeyId: resolved.key.id,
        providerId: resolved.key.providerId,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }

    const consistentResolved = await ensureResolvedPoolAccountConsistent({
      resolved: eligibleResolved,
      sessionId: sessionRouteId,
      requestedModel: effectiveRequestedModel,
    })
    if (!consistentResolved.ok) {
      writeAudit({
        virtualKeyId: eligibleResolved.key.id,
        providerId: eligibleResolved.key.providerId,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }

    const key = consistentResolved.resolved.key as typeof consistentResolved.resolved.key & {
      clientMode?: "codex" | "cursor" | null
      wireApi?: "responses" | "chat_completions" | null
    }
    auditRoutingMode = key.routingMode
    auditClientMode = key.clientMode ?? "codex"
    auditWireApi = key.wireApi ?? "responses"
    let account = consistentResolved.resolved.account
    let profile = resolveUpstreamProfileForAccount(account)
    auditKeyId = key.id
    auditAccountId = account.id
    auditProviderId = account.providerId
    let sameAccountRetryBudget = 1

    const acquireBehaviorBudgetForCurrentAccount = async () => {
      const behaviorDecision = await behaviorController.acquire({
        accountId: account.id,
        signal: behaviorSignal,
      })
      if (!behaviorDecision.ok) {
        throw createBehaviorAcquireError(behaviorDecision)
      }
      return behaviorDecision.release
    }

    const hasEstablishedStickyRouteForCurrentAccount = () =>
      Boolean(
        key.routingMode === "pool" &&
          sessionRouteId &&
          accountStore.hasEstablishedVirtualKeySessionRoute({
            keyId: key.id,
            sessionId: sessionRouteId,
            accountId: account.id,
          }),
      )

    const buildHeadersForCurrentAccount = (auth: { accessToken: string; accountId?: string }) => {
      const openAIHeaders = buildAccountOpenAIHeadersForProfile(account, profile.providerMode)
      const headers = appendResponsesProtocolHeaders(
        buildUpstreamForwardHeadersForAccount({
          incoming: c.req.raw.headers,
          accessToken: auth.accessToken,
          accountId: auth.accountId,
          boundAccountId: account.id,
          providerMode: profile.providerMode,
          attachChatgptAccountId: profile.attachChatgptAccountId,
          organizationId: openAIHeaders?.organizationId,
          projectId: openAIHeaders?.projectId,
          codexClientMetadata,
        }),
        {
          incoming: c.req.raw.headers,
          sessionRouteId,
        },
      )
      if (requestBodyAnalysis.parsedRoot) {
        headers.delete("content-encoding")
        headers.delete("content-md5")
        headers.set("content-type", "application/json")
      }
      return headers
    }

    const rerouteTriedAccounts = new Set<string>()
    const buildPoolUnavailableResponse = () => {
      const normalizedFailure = buildUpstreamAccountUnavailableFailure({
        routingMode: key.routingMode,
      })
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        responseBytes: new TextEncoder().encode(normalizedFailure.bodyText).byteLength,
        statusCode: normalizedFailure.status,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return new Response(normalizedFailure.bodyText, {
        status: normalizedFailure.status,
        headers: normalizedFailure.headers,
      })
    }
    const selectReroutedPoolAccount = (failedAccountId: string) => {
      if (rerouteTriedAccounts.size >= POOL_REROUTE_MAX_ATTEMPTS) {
        return null
      }
      const failedAccount = accountStore.get(failedAccountId)
      const preferredPlanCohort = resolvePreferredPlanCohortForVirtualKey({
        key,
        requestedModel: auditModel,
        account: failedAccount ?? null,
      })
      const routingHints = buildProviderRoutingHintsForVirtualKey(key, auditModel, Date.now(), {
        preferredPlanCohort,
      })
      const excluded = new Set<string>([...routingHints.excludeAccountIds, ...rerouteTriedAccounts])

      let reRoutedAccount = sessionRouteId
        ? accountStore.reassignVirtualKeySessionRoute({
            keyId: key.id,
            providerId: key.providerId,
            sessionId: sessionRouteId,
            failedAccountId,
            accountScope: key.accountScope ?? "all",
            excludeAccountIds: [...excluded],
            deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
            headroomByAccountId: routingHints.headroomByAccountId,
            pressureScoreByAccountId: routingHints.pressureScoreByAccountId,
          })
      : accountStore.reassignVirtualKeyRoute({
          keyId: key.id,
          providerId: key.providerId,
          failedAccountId,
          accountScope: key.accountScope ?? "all",
          excludeAccountIds: [...excluded],
          deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
          headroomByAccountId: routingHints.headroomByAccountId,
          pressureScoreByAccountId: routingHints.pressureScoreByAccountId,
        })

      if (!reRoutedAccount) {
        const relaxedHints = buildRelaxedProviderRoutingHintsForVirtualKey(key, auditModel, Date.now(), {
          preferredPlanCohort,
        })
        const relaxedExcluded = new Set<string>([...relaxedHints.excludeAccountIds, ...rerouteTriedAccounts])
        reRoutedAccount = sessionRouteId
          ? accountStore.reassignVirtualKeySessionRoute({
              keyId: key.id,
              providerId: key.providerId,
              sessionId: sessionRouteId,
              failedAccountId,
              accountScope: key.accountScope ?? "all",
              excludeAccountIds: [...relaxedExcluded],
              deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
              headroomByAccountId: relaxedHints.headroomByAccountId,
              pressureScoreByAccountId: relaxedHints.pressureScoreByAccountId,
            })
        : accountStore.reassignVirtualKeyRoute({
            keyId: key.id,
            providerId: key.providerId,
            failedAccountId,
            accountScope: key.accountScope ?? "all",
            excludeAccountIds: [...relaxedExcluded],
            deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
            headroomByAccountId: relaxedHints.headroomByAccountId,
            pressureScoreByAccountId: relaxedHints.pressureScoreByAccountId,
          })
      }

      if (!reRoutedAccount || rerouteTriedAccounts.has(reRoutedAccount.id)) {
        return null
      }
      return reRoutedAccount
    }

    let auth: { accessToken: string; accountId?: string } = { accessToken: "" }
    let headers = new Headers()
    const requestBodyCache = new Map<string, Uint8Array | undefined>()
    let upstreamRequestBody: Uint8Array | undefined
    const buildRequestBodyForCurrentAccount = () => {
      const cacheKey = `${strictUpstreamPrivacy ? "strict" : "standard"}:${account.id}`
      if (requestBodyCache.has(cacheKey)) {
        return requestBodyCache.get(cacheKey)
      }
      const requestBodyBytes = mergeParsedJsonBodyWithCodexMetadata({
        body: outgoingBody,
        parsedRoot: effectiveRequestBodyBaseRoot,
        codexClientMetadata: upstreamPath === "/responses/compact" ? null : codexClientMetadata,
      })
      const bodySanitized = sanitizeUpstreamJsonBody({
        body: requestBodyBytes,
        contentType,
        strictPrivacy: strictUpstreamPrivacy,
        accountId: account.id,
        parsedRoot: effectiveRequestBodyBaseRoot,
      })
      if (bodySanitized.strippedFields.length > 0) {
        logStrictPrivacySanitizedFields({
          route,
          keyId: auditKeyId,
          accountId: account.id,
          fields: bodySanitized.strippedFields,
        })
      }
      requestBodyCache.set(cacheKey, bodySanitized.body)
      return bodySanitized.body
    }

    const runUpstreamRequest = async (requestHeaders: Headers) =>
      (
        await requestUpstreamWithPolicy({
          url: buildUpstreamAbsoluteUrl(
            c.req.url,
            resolveResponsesUpstreamEndpoint(profile.responsesEndpoint, upstreamPath),
            {
              accountId: account.id,
            },
          ),
          method: "POST",
          headers: requestHeaders,
          body: upstreamRequestBody,
          accountId: account.id,
          routeTag: route,
          policyOverride: key.routingMode === "pool" ? POOL_FAIL_FAST_RETRY_POLICY : undefined,
          recordBehaviorResult: true,
        })
      ).response

    const attemptUpstreamForCurrentAccount = async () => {
      const releaseBehavior = await acquireBehaviorBudgetForCurrentAccount()
      try {
        auth = await resolveUpstreamAccountAuth(account)
        headers = buildHeadersForCurrentAccount(auth)
        upstreamRequestBody = buildRequestBodyForCurrentAccount()
        let currentUpstream = await runUpstreamRequest(headers)

        if (currentUpstream.status === 401 && profile.canRefreshOn401) {
          const latest = accountStore.get(account.id) ?? account
          auth = await resolveUpstreamAccountAuth(latest, { forceRefresh: true })
          headers = buildHeadersForCurrentAccount(auth)
          upstreamRequestBody = buildRequestBodyForCurrentAccount()
          currentUpstream = await runUpstreamRequest(headers)
        }

        return currentUpstream
      } finally {
        releaseBehavior()
      }
    }

    const tryStickySameAccountRetry = async () => {
      if (sameAccountRetryBudget <= 0) return null
      if (!hasEstablishedStickyRouteForCurrentAccount()) return null
      sameAccountRetryBudget -= 1
      emitServerEvent("virtual-key-retry", {
        type: "virtual-key-retry",
        at: Date.now(),
        keyId: key.id,
        sessionId: sessionRouteId ?? null,
        accountId: account.id,
      })
      return attemptUpstreamForCurrentAccount()
    }

    let upstream: Response
    while (true) {
      try {
        upstream = await attemptUpstreamForCurrentAccount()
        break
      } catch (error) {
        const behaviorFailure = getBehaviorAcquireFailure(error)
        const blocked = detectRoutingBlockedAccount({
          error,
        })
        const transient = detectTransientUpstreamError(error)
        if (transient.matched) {
          const sameAccountRetryResponse = await tryStickySameAccountRetry().catch(() => null)
          if (sameAccountRetryResponse) {
            upstream = sameAccountRetryResponse
            break
          }
        }
        if (!(key.routingMode === "pool" && (blocked.matched || transient.matched || behaviorFailure))) {
          if (behaviorFailure) {
            writeAudit({
              providerId: auditProviderId,
              accountId: auditAccountId,
              virtualKeyId: auditKeyId,
              statusCode: behaviorFailure.status,
              latencyMs: Date.now() - startedAt,
              error: `${behaviorFailure.code}: ${behaviorFailure.message}`,
              clientTag,
            })
            return toBehaviorAcquireResponse(behaviorFailure)
          }
          throw error
        }

        const failedAccountId = account.id
        rerouteTriedAccounts.add(failedAccountId)
        if (blocked.matched) {
          markAccountUnhealthy(failedAccountId, blocked.reason, "responses")
          evictAccountModelsCache(failedAccountId)
        } else if (!behaviorFailure && transient.matched) {
          if (transient.reason === "upstream_certificate_verification_error") {
            markAccountUnhealthy(failedAccountId, transient.reason, "responses")
          }
        }

        const reRoutedAccount = selectReroutedPoolAccount(failedAccountId)
        if (!reRoutedAccount) {
          return buildPoolUnavailableResponse()
        }

        account = reRoutedAccount
        profile = resolveUpstreamProfileForAccount(account)
        auditAccountId = account.id
        auditProviderId = account.providerId
        emitServerEvent("virtual-key-failover", {
          type: "virtual-key-failover",
          at: Date.now(),
          keyId: key.id,
          sessionId: sessionRouteId ?? null,
          fromAccountId: failedAccountId,
          toAccountId: account.id,
          reason: blocked.reason ?? transient.reason ?? behaviorFailure?.code ?? "routing_excluded",
        })
      }
    }

    if (key.routingMode === "pool") {
      while (true) {
        const blockedSignal = await detectRoutingBlockedUpstreamResponse(upstream)
        const quotaSignal = await detectQuotaExhaustedUpstreamResponse(upstream)
        const transientSignal = await detectTransientUpstreamResponse(upstream)
        if (!blockedSignal.matched && !quotaSignal.matched && !transientSignal.matched) break
        if (transientSignal.matched) {
          const sameAccountRetryResponse = await tryStickySameAccountRetry().catch(() => null)
          if (sameAccountRetryResponse) {
            upstream = sameAccountRetryResponse
            continue
          }
        }

        const failedAccountId = account.id
        rerouteTriedAccounts.add(failedAccountId)
        if (blockedSignal.matched) {
          markAccountUnhealthy(failedAccountId, blockedSignal.reason, "responses")
          evictAccountModelsCache(failedAccountId)
        } else if (quotaSignal.matched) {
          markAccountQuotaExhausted(failedAccountId)
          handleBackgroundPromise(
            "refreshAndEmitAccountQuota:proxy-usage-limit-reached",
            refreshAndEmitAccountQuota(failedAccountId, "proxy-usage-limit-reached"),
          )
        } else if (transientSignal.reason === "upstream_certificate_verification_error") {
          markAccountUnhealthy(failedAccountId, transientSignal.reason, "responses")
        }

        const reRoutedAccount = selectReroutedPoolAccount(failedAccountId)
        if (!reRoutedAccount) {
          break
        }

        const previousAccount = account
        const previousProfile = profile
        const previousAuditAccountId: string | null = auditAccountId
        const previousAuditProviderId: string | null = auditProviderId
        try {
          account = reRoutedAccount
          profile = resolveUpstreamProfileForAccount(account)
          auditAccountId = account.id
          auditProviderId = account.providerId

          upstream = await attemptUpstreamForCurrentAccount()
          emitServerEvent("virtual-key-failover", {
            type: "virtual-key-failover",
            at: Date.now(),
            keyId: key.id,
            sessionId: sessionRouteId ?? null,
            fromAccountId: failedAccountId,
            toAccountId: account.id,
            reason: blockedSignal.reason ?? quotaSignal.reason ?? transientSignal.reason ?? "routing_excluded",
          })
          continue
        } catch (error) {
          account = previousAccount
          profile = previousProfile
          auditAccountId = previousAuditAccountId
          auditProviderId = previousAuditProviderId
          const behaviorFailure = getBehaviorAcquireFailure(error)
          const reroutedBlocked = detectRoutingBlockedAccount({
            error,
          })
          const reroutedTransient = detectTransientUpstreamError(error)
          if (reroutedBlocked.matched) {
            rerouteTriedAccounts.add(reRoutedAccount.id)
            markAccountUnhealthy(reRoutedAccount.id, reroutedBlocked.reason, "responses")
            evictAccountModelsCache(reRoutedAccount.id)
            continue
          }
          if (reroutedTransient.matched) {
            rerouteTriedAccounts.add(reRoutedAccount.id)
            if (reroutedTransient.reason === "upstream_certificate_verification_error") {
              markAccountUnhealthy(reRoutedAccount.id, reroutedTransient.reason, "responses")
            }
            continue
          }
          if (behaviorFailure) {
            rerouteTriedAccounts.add(reRoutedAccount.id)
            continue
          }
          break
        }
      }
    }

    if (upstream.ok) {
      markAccountHealthy(account.id, "responses")
    }

    const upstreamRequestId =
      upstream.headers.get("x-request-id") ||
      upstream.headers.get("x-oai-request-id") ||
      upstream.headers.get("openai-request-id") ||
      upstream.headers.get("cf-ray") ||
      null

    if (!upstream.ok) {
      const responseBuffer = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
      const normalizedFailure = await normalizeCodexFailureResponse({
        status: upstream.status,
        headers: upstream.headers,
        bodyBytes: new Uint8Array(responseBuffer),
        routingMode: key.routingMode,
      })
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        responseBytes: new TextEncoder().encode(normalizedFailure.bodyText).byteLength,
        statusCode: normalizedFailure.status,
        latencyMs: Date.now() - startedAt,
        upstreamRequestId,
        error: normalizedFailure.bodyText || `Upstream request failed (${normalizedFailure.status})`,
        clientTag,
      })
      return new Response(normalizedFailure.bodyText, {
        status: normalizedFailure.status,
        headers: normalizedFailure.headers,
      })
    }

    const responseHeaders = finalizeResponsesUpstreamHeaders(auditSessionId, upstream.headers)

    if (!upstream.body) {
      const text = await upstream.text().catch(() => "")
      const responseBytes = new TextEncoder().encode(text).byteLength
      let usage = emptyUsageMetrics()
      try {
        usage = (await extractUsageFromStructuredResponseText(text)).usage
        recordUsageMetrics({
          accountId: account.id,
          keyId: key.id,
          usage,
          source: "proxy-single",
          providerId: auditProviderId,
          virtualKeyId: auditKeyId,
          model: auditModel,
          sessionId: auditSessionId,
          reasoningEffort: auditReasoningEffort,
        })
      } catch {
        // ignore usage parse errors
      }
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        responseBytes,
        statusCode: upstream.status,
        latencyMs: Date.now() - startedAt,
        upstreamRequestId,
        clientTag,
        usage,
      })
      return new Response(text, {
        status: upstream.status,
        headers: responseHeaders,
      })
    }

    const auditId = writeAudit({
      providerId: auditProviderId,
      accountId: auditAccountId,
      virtualKeyId: auditKeyId,
      model: auditModel,
      sessionId: auditSessionId,
      requestBytes: outgoingBody?.byteLength ?? 0,
      requestBody: outgoingBody,
      responseBytes: parseHeaderNumber(upstream.headers.get("content-length")),
      statusCode: upstream.status,
      latencyMs: Date.now() - startedAt,
      upstreamRequestId,
      clientTag,
    })
    const clientStream = createUsageTrackingProxyStream({
      accountId: account.id,
      keyId: key.id,
      stream: upstream.body,
      auditId,
      providerId: auditProviderId,
      virtualKeyId: auditKeyId,
      model: auditModel,
      sessionId: auditSessionId,
      reasoningEffort: auditReasoningEffort,
      source: isEventStreamContentType(upstream.headers.get("content-type")) ? "proxy-stream" : "proxy-json",
    })

    return new Response(clientStream, {
      status: upstream.status,
      headers: responseHeaders,
    })
  } catch (error) {
    const normalizedCaughtFailure = normalizeCaughtCodexFailure({
      error,
      routingMode: auditRoutingMode,
    })
    if (normalizedCaughtFailure) {
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        responseBytes: new TextEncoder().encode(normalizedCaughtFailure.bodyText).byteLength,
        statusCode: normalizedCaughtFailure.status,
        latencyMs: Date.now() - startedAt,
        error: errorMessage(error),
        clientTag,
      })
      return new Response(normalizedCaughtFailure.bodyText, {
        status: normalizedCaughtFailure.status,
        headers: normalizedCaughtFailure.headers,
      })
    }
    const finalStatus = getStatusErrorCode(error) ?? (isLikelyAuthError(error) ? 401 : 400)
    writeAudit({
      providerId: auditProviderId,
      accountId: auditAccountId,
      virtualKeyId: auditKeyId,
      model: auditModel,
      sessionId: auditSessionId,
      requestBytes: outgoingBody?.byteLength ?? 0,
      requestBody: outgoingBody,
      statusCode: finalStatus,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
      clientTag,
    })
    return c.json({ error: errorMessage(error) }, finalStatus)
  } finally {
    proxyPressureLease?.release()
  }
}

async function proxyVirtualKeyCursorChatCompletions(c: any) {
  const startedAt = Date.now()
  const route = c.req.path
  const method = c.req.method
  const behaviorSignal = resolveBehaviorSignal(c.req.raw.headers)
  const clientTag = behaviorSignal.clientTag || null

  let auditProviderId: string | null = null
  let auditAccountId: string | null = null
  let auditKeyId: string | null = null
  let auditModel: string | null = null
  let auditSessionId: string | null = null
  let auditReasoningEffort: string | null = null
  let outgoingBody: Uint8Array | undefined = undefined
  let auditRoutingMode = "single"
  let proxyPressureLease: ProxyPressureLease | null = null
  const auditClientMode: "cursor" = "cursor"
  const auditWireApi: "chat_completions" = "chat_completions"
  const writeAudit = buildResponsesAuditWriter(route, method, () => ({
    reasoningEffort: auditReasoningEffort,
    clientMode: auditClientMode,
    wireApi: auditWireApi,
  }))

  try {
    const declaredRequestBytes = parseHeaderNumber(c.req.header("content-length"))
    proxyPressureLease = await proxyRequestPressureLimiter.acquire({
      heavy: declaredRequestBytes >= PROXY_HEAVY_BODY_BYTES,
      label: route,
      signal: c.req.raw.signal,
    })
    outgoingBody = await readRequestBodyBytesWithLimit(c.req.raw)
    const rawBodyText = outgoingBody ? new TextDecoder().decode(outgoingBody) : "{}"
    const parsedBody = CursorChatCompletionsSchema.parse(JSON.parse(rawBodyText))
    const auditFields = parseAuditRequestFields({
      body: outgoingBody ?? new Uint8Array(0),
      contentType: c.req.header("content-type"),
    })
    auditModel = parsedBody.model
    auditReasoningEffort = auditFields.reasoningEffort

    const modelId = extractModelID(parsedBody.model)
    if (!modelId) {
      writeAudit({
        model: parsedBody.model,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        statusCode: 404,
        latencyMs: Date.now() - startedAt,
        error: "Model is not available for Cursor compatibility mode",
        clientTag,
      })
      return toOpenAICompatibleErrorResponse("Model is not available for Cursor compatibility mode", 404, "invalid_request_error")
    }

    const context = resolveVirtualKeyContext(c, {
      expectedClientMode: "cursor",
      expectedWireApi: "chat_completions",
      bodySessionId: auditFields.sessionId ?? null,
      requestedModel: modelId,
    })
    if ("error" in context) {
      const status = typeof context.status === "number" ? context.status : 401
      const message = String(context.error || "Invalid virtual API key")
      writeAudit({
        model: auditModel,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        statusCode: status,
        latencyMs: Date.now() - startedAt,
        error: message,
        clientTag,
      })
      return toOpenAICompatibleErrorResponse(message, status, status === 401 ? "authentication_error" : "invalid_request_error")
    }

    const keyOverrides = resolveVirtualKeyRequestOverrides(context.resolved.key as { fixedModel?: unknown; fixedReasoningEffort?: unknown })
    const effectiveModelId = keyOverrides.fixedModel ?? modelId
    const effectiveReasoningEffort = keyOverrides.fixedReasoningEffort ?? auditFields.reasoningEffort
    auditModel = effectiveModelId
    auditReasoningEffort = effectiveReasoningEffort

    const sessionRouteId = context.sessionId ?? null
    const consistentContext = await ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
      sessionId: sessionRouteId,
      requestedModel: effectiveModelId,
    })
    const codexClientMetadata = buildResponsesClientMetadata({
      incoming: c.req.raw.headers,
      sessionRouteId,
    })
    const parsedBodyRecord = parsedBody as Record<string, unknown>
    const encodedCursorClientMetadata = mergeOfficialCodexClientMetadata(
      asRecord(parsedBodyRecord.client_metadata) ?? asRecord(parsedBodyRecord.clientMetadata),
      codexClientMetadata,
    )
    const cursorRequestBody = { ...parsedBody, model: effectiveModelId } as typeof parsedBody
    if (encodedCursorClientMetadata && !hasOwnKey(parsedBodyRecord, "client_metadata")) {
      ;(cursorRequestBody as Record<string, unknown>).client_metadata = encodedCursorClientMetadata as Record<string, unknown>
    }
    if (encodedCursorClientMetadata && hasOwnKey(parsedBodyRecord, "client_metadata")) {
      ;(cursorRequestBody as Record<string, unknown>).client_metadata = encodedCursorClientMetadata as Record<string, unknown>
    }
    if (encodedCursorClientMetadata && hasOwnKey(parsedBodyRecord, "clientMetadata")) {
      delete (cursorRequestBody as Record<string, unknown>).clientMetadata
    }
    const normalizedCursorMessages = cursorRequestBody.messages as Array<Record<string, unknown>>
    const normalizedCursorTools = cursorRequestBody.tools as Array<Record<string, unknown>>
    const normalizedCursorToolChoice = cursorRequestBody.tool_choice
    const normalizedCursorTemperature = cursorRequestBody.temperature
    const normalizedCursorMaxTokens = cursorRequestBody.max_tokens
    const normalizedCursorParallelToolCalls = cursorRequestBody.parallel_tool_calls
    const normalizedCursorStream = cursorRequestBody.stream === true
    const normalizedCursorReasoningEffort = effectiveReasoningEffort
    const normalizedCursorRawBody = new TextEncoder().encode(JSON.stringify(cursorRequestBody))
    outgoingBody = normalizedCursorRawBody

    if (!consistentContext.ok) {
      writeAudit({
        virtualKeyId: context.resolved.key.id,
        providerId: context.resolved.key.providerId,
        model: auditModel,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return toOpenAICompatibleErrorResponse("No healthy accounts available for pool routing", 503, "server_error")
    }

    const key = consistentContext.resolved.key as typeof consistentContext.resolved.key & {
      clientMode?: "codex" | "cursor" | null
      wireApi?: "responses" | "chat_completions" | null
    }
    auditRoutingMode = key.routingMode
    let account = consistentContext.resolved.account
    let profile = resolveUpstreamProfileForAccount(account)
    auditKeyId = key.id
    auditAccountId = account.id
    auditProviderId = account.providerId
    auditSessionId = context.sessionId ?? null
    let sameAccountRetryBudget = 1

    const acquireBehaviorBudgetForCurrentAccount = async () => {
      const behaviorDecision = await behaviorController.acquire({
        accountId: account.id,
        signal: behaviorSignal,
      })
      if (!behaviorDecision.ok) {
        throw createBehaviorAcquireError(behaviorDecision)
      }
      return behaviorDecision.release
    }

    const hasEstablishedStickyRouteForCurrentAccount = () =>
      Boolean(
        key.routingMode === "pool" &&
          context.sessionId &&
          accountStore.hasEstablishedVirtualKeySessionRoute({
            keyId: key.id,
            sessionId: context.sessionId,
            accountId: account.id,
          }),
      )

    const buildHeadersForCurrentAccount = (auth: { accessToken: string; accountId?: string }) => {
      const openAIHeaders = buildAccountOpenAIHeadersForProfile(account, profile.providerMode)
      return appendResponsesProtocolHeaders(
        buildUpstreamForwardHeadersForAccount({
          incoming: c.req.raw.headers,
          accessToken: auth.accessToken,
          accountId: auth.accountId,
          boundAccountId: account.id,
          providerMode: profile.providerMode,
          attachChatgptAccountId: profile.attachChatgptAccountId,
          organizationId: openAIHeaders?.organizationId,
          projectId: openAIHeaders?.projectId,
          codexClientMetadata,
        }),
        {
          incoming: c.req.raw.headers,
          sessionRouteId,
        },
      )
    }

    const rerouteTriedAccounts = new Set<string>()
    const buildPoolUnavailableResponse = () => {
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return toOpenAICompatibleErrorResponse("No healthy accounts available for pool routing", 503, "server_error")
    }
    const selectReroutedPoolAccount = (failedAccountId: string) => {
      if (rerouteTriedAccounts.size >= POOL_REROUTE_MAX_ATTEMPTS) {
        return null
      }
      const failedAccount = accountStore.get(failedAccountId)
      const preferredPlanCohort = resolvePreferredPlanCohortForVirtualKey({
        key,
        requestedModel: effectiveModelId,
        account: failedAccount ?? null,
      })
      const routingHints = buildProviderRoutingHintsForVirtualKey(key, effectiveModelId, Date.now(), {
        preferredPlanCohort,
      })
      const excluded = new Set<string>([...routingHints.excludeAccountIds, ...rerouteTriedAccounts])

      let reroutedAccount = context.sessionId
        ? accountStore.reassignVirtualKeySessionRoute({
            keyId: key.id,
            providerId: key.providerId,
            sessionId: context.sessionId,
            failedAccountId,
            accountScope: key.accountScope ?? "all",
            excludeAccountIds: [...excluded],
            deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
            headroomByAccountId: routingHints.headroomByAccountId,
            pressureScoreByAccountId: routingHints.pressureScoreByAccountId,
          })
        : accountStore.reassignVirtualKeyRoute({
            keyId: key.id,
            providerId: key.providerId,
            failedAccountId,
            accountScope: key.accountScope ?? "all",
            excludeAccountIds: [...excluded],
            deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
            headroomByAccountId: routingHints.headroomByAccountId,
            pressureScoreByAccountId: routingHints.pressureScoreByAccountId,
          })

      if (!reroutedAccount) {
        const relaxedHints = buildRelaxedProviderRoutingHintsForVirtualKey(key, effectiveModelId, Date.now(), {
          preferredPlanCohort,
        })
        const relaxedExcluded = new Set<string>([...relaxedHints.excludeAccountIds, ...rerouteTriedAccounts])
        reroutedAccount = context.sessionId
          ? accountStore.reassignVirtualKeySessionRoute({
              keyId: key.id,
              providerId: key.providerId,
              sessionId: context.sessionId,
              failedAccountId,
              accountScope: key.accountScope ?? "all",
              excludeAccountIds: [...relaxedExcluded],
              deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
              headroomByAccountId: relaxedHints.headroomByAccountId,
              pressureScoreByAccountId: relaxedHints.pressureScoreByAccountId,
            })
          : accountStore.reassignVirtualKeyRoute({
              keyId: key.id,
              providerId: key.providerId,
              failedAccountId,
              accountScope: key.accountScope ?? "all",
              excludeAccountIds: [...relaxedExcluded],
              deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
              headroomByAccountId: relaxedHints.headroomByAccountId,
              pressureScoreByAccountId: relaxedHints.pressureScoreByAccountId,
            })
      }

      if (!reroutedAccount || rerouteTriedAccounts.has(reroutedAccount.id)) {
        return null
      }
      return reroutedAccount
    }

    const ensureCurrentAccountSupportsRequestedModel = async () => {
      while (true) {
        if (getModelCatalogEntry(effectiveModelId) && accountCanUseRequestedModel(account, effectiveModelId)) {
          return null
        }
        const catalog = await resolveModelCatalogForCursorAccount({
          account,
          requestUrl: c.req.url,
          requestHeaders: c.req.raw.headers,
        })
        const supported = catalog.data.some((item) => String(item.id || "") === effectiveModelId)
        if (supported) return null
        if (key.routingMode !== "pool") {
          writeAudit({
            providerId: auditProviderId,
            accountId: auditAccountId,
            virtualKeyId: auditKeyId,
            model: auditModel,
            sessionId: auditSessionId,
            requestBytes: outgoingBody?.byteLength ?? 0,
            requestBody: outgoingBody,
            statusCode: 404,
            latencyMs: Date.now() - startedAt,
            error: "Model is not available for Cursor compatibility mode",
            clientTag,
          })
          return toOpenAICompatibleErrorResponse("Model is not available for Cursor compatibility mode", 404, "invalid_request_error")
        }
        rerouteTriedAccounts.add(account.id)
        const reroutedAccount = selectReroutedPoolAccount(account.id)
        if (!reroutedAccount) {
          writeAudit({
            providerId: auditProviderId,
            accountId: auditAccountId,
            virtualKeyId: auditKeyId,
            model: auditModel,
            sessionId: auditSessionId,
            requestBytes: outgoingBody?.byteLength ?? 0,
            requestBody: outgoingBody,
            statusCode: 404,
            latencyMs: Date.now() - startedAt,
            error: "Requested model is not available for any healthy accounts in the pool",
            clientTag,
          })
          return toOpenAICompatibleErrorResponse(
            "Requested model is not available for any healthy accounts in the pool",
            404,
            "invalid_request_error",
          )
        }
        account = reroutedAccount
        profile = resolveUpstreamProfileForAccount(account)
        auditAccountId = account.id
        auditProviderId = account.providerId
      }
    }

    const resolvedModelId = effectiveModelId
    const unsupportedModelResponse = await ensureCurrentAccountSupportsRequestedModel()
    if (unsupportedModelResponse) {
      return unsupportedModelResponse
    }
    let auth: { accessToken: string; accountId?: string } = { accessToken: "" }
    let headers = new Headers()
    const buildRequestBodyForCurrentAccount = () => {
      const requestBody = buildCursorResponsesRequestBody({
        model: resolvedModelId,
        sessionId: context.sessionId,
        accountId: account.id,
        messages: normalizedCursorMessages,
        tools: normalizedCursorTools,
        toolChoice: normalizedCursorToolChoice,
        temperature: normalizedCursorTemperature,
        maxTokens: normalizedCursorMaxTokens,
        parallelToolCalls: normalizedCursorParallelToolCalls,
        reasoningEffort: normalizedCursorReasoningEffort,
        stream: normalizedCursorStream,
        codexClientMetadata,
      })
      return new TextEncoder().encode(JSON.stringify(requestBody))
    }

    const runUpstreamRequest = async (requestHeaders: Headers, requestBody: Uint8Array) =>
      (
        await requestUpstreamWithPolicy({
          url: buildUpstreamAbsoluteUrl(
            c.req.url,
            resolveResponsesUpstreamEndpoint(profile.responsesEndpoint, "/responses"),
            {
              accountId: account.id,
            },
          ),
          method: "POST",
          headers: requestHeaders,
          body: requestBody,
          accountId: account.id,
          routeTag: route,
          policyOverride: key.routingMode === "pool" ? POOL_FAIL_FAST_RETRY_POLICY : INTERACTIVE_FAST_RETRY_POLICY,
          recordBehaviorResult: true,
        })
      ).response

    let upstreamRequestBody = new Uint8Array()
    const attemptUpstreamForCurrentAccount = async () => {
      const releaseBehavior = await acquireBehaviorBudgetForCurrentAccount()
      try {
        auth = await resolveUpstreamAccountAuth(account)
        headers = buildHeadersForCurrentAccount(auth)
        upstreamRequestBody = buildRequestBodyForCurrentAccount()
        let currentUpstream = await runUpstreamRequest(headers, upstreamRequestBody)

        if (currentUpstream.status === 401 && profile.canRefreshOn401) {
          const latest = accountStore.get(account.id) ?? account
          auth = await resolveUpstreamAccountAuth(latest, { forceRefresh: true })
          headers = buildHeadersForCurrentAccount(auth)
          upstreamRequestBody = buildRequestBodyForCurrentAccount()
          currentUpstream = await runUpstreamRequest(headers, upstreamRequestBody)
        }

        return currentUpstream
      } finally {
        releaseBehavior()
      }
    }

    const tryStickySameAccountRetry = async () => {
      if (sameAccountRetryBudget <= 0) return null
      if (!hasEstablishedStickyRouteForCurrentAccount()) return null
      sameAccountRetryBudget -= 1
      return attemptUpstreamForCurrentAccount()
    }

    let upstream: Response
    while (true) {
      try {
        upstream = await attemptUpstreamForCurrentAccount()
        break
      } catch (error) {
        const behaviorFailure = getBehaviorAcquireFailure(error)
        const blocked = detectRoutingBlockedAccount({ error })
        const transient = detectTransientUpstreamError(error)
        if (transient.matched) {
          const sameAccountRetryResponse = await tryStickySameAccountRetry().catch(() => null)
          if (sameAccountRetryResponse) {
            upstream = sameAccountRetryResponse
            break
          }
        }
        if (!(key.routingMode === "pool" && (blocked.matched || transient.matched || behaviorFailure))) {
          if (behaviorFailure) {
            writeAudit({
              providerId: auditProviderId,
              accountId: auditAccountId,
              virtualKeyId: auditKeyId,
              model: auditModel,
              sessionId: auditSessionId,
              requestBytes: outgoingBody?.byteLength ?? 0,
              requestBody: outgoingBody,
              statusCode: behaviorFailure.status,
              latencyMs: Date.now() - startedAt,
              error: `${behaviorFailure.code}: ${behaviorFailure.message}`,
              clientTag,
            })
            return toOpenAICompatibleErrorResponse(behaviorFailure.message, behaviorFailure.status, "server_error")
          }
          throw error
        }

        const failedAccountId = account.id
        rerouteTriedAccounts.add(failedAccountId)
        if (blocked.matched) {
          markAccountUnhealthy(failedAccountId, blocked.reason, "cursor-chat")
          evictAccountModelsCache(failedAccountId)
        } else if (!behaviorFailure && transient.matched) {
          if (transient.reason === "upstream_certificate_verification_error") {
            markAccountUnhealthy(failedAccountId, transient.reason, "cursor-chat")
          }
        }

        const reroutedAccount = selectReroutedPoolAccount(failedAccountId)
        if (!reroutedAccount) {
          return buildPoolUnavailableResponse()
        }
        account = reroutedAccount
        profile = resolveUpstreamProfileForAccount(account)
        auditAccountId = account.id
        auditProviderId = account.providerId
      }
    }

    if (key.routingMode === "pool") {
      while (true) {
        const blockedSignal = await detectRoutingBlockedUpstreamResponse(upstream)
        const quotaSignal = await detectQuotaExhaustedUpstreamResponse(upstream)
        const transientSignal = await detectTransientUpstreamResponse(upstream)
        if (!blockedSignal.matched && !quotaSignal.matched && !transientSignal.matched) break
        if (transientSignal.matched) {
          const sameAccountRetryResponse = await tryStickySameAccountRetry().catch(() => null)
          if (sameAccountRetryResponse) {
            upstream = sameAccountRetryResponse
            continue
          }
        }

        const failedAccountId = account.id
        rerouteTriedAccounts.add(failedAccountId)
        if (blockedSignal.matched) {
          markAccountUnhealthy(failedAccountId, blockedSignal.reason, "cursor-chat")
          evictAccountModelsCache(failedAccountId)
        } else if (quotaSignal.matched) {
          markAccountQuotaExhausted(failedAccountId)
          handleBackgroundPromise(
            "refreshAndEmitAccountQuota:cursor-chat-usage-limit-reached",
            refreshAndEmitAccountQuota(failedAccountId, "cursor-chat-usage-limit-reached"),
          )
        } else if (transientSignal.reason === "upstream_certificate_verification_error") {
          markAccountUnhealthy(failedAccountId, transientSignal.reason, "cursor-chat")
        }

        const reroutedAccount = selectReroutedPoolAccount(failedAccountId)
        if (!reroutedAccount) {
          break
        }

        const previousAccount = account
        const previousProfile = profile
        const previousAuditAccountId: string | null = auditAccountId
        const previousAuditProviderId: string | null = auditProviderId
        try {
          account = reroutedAccount
          profile = resolveUpstreamProfileForAccount(account)
          auditAccountId = account.id
          auditProviderId = account.providerId
          upstream = await attemptUpstreamForCurrentAccount()
          continue
        } catch (error) {
          account = previousAccount
          profile = previousProfile
          auditAccountId = previousAuditAccountId
          auditProviderId = previousAuditProviderId
          const behaviorFailure = getBehaviorAcquireFailure(error)
          const reroutedBlocked = detectRoutingBlockedAccount({ error })
          const reroutedTransient = detectTransientUpstreamError(error)
          if (reroutedBlocked.matched) {
            rerouteTriedAccounts.add(reroutedAccount.id)
            markAccountUnhealthy(reroutedAccount.id, reroutedBlocked.reason, "cursor-chat")
            evictAccountModelsCache(reroutedAccount.id)
            continue
          }
          if (reroutedTransient.matched) {
            rerouteTriedAccounts.add(reroutedAccount.id)
            if (reroutedTransient.reason === "upstream_certificate_verification_error") {
              markAccountUnhealthy(reroutedAccount.id, reroutedTransient.reason, "cursor-chat")
            }
            continue
          }
          if (behaviorFailure) {
            rerouteTriedAccounts.add(reroutedAccount.id)
            continue
          }
          break
        }
      }
    }

    if (upstream.ok) {
      markAccountHealthy(account.id, "cursor-chat")
    }

    const upstreamRequestId =
      upstream.headers.get("x-request-id") ||
      upstream.headers.get("x-oai-request-id") ||
      upstream.headers.get("openai-request-id") ||
      upstream.headers.get("cf-ray") ||
      null

    if (!upstream.ok) {
      const bodyText = await upstream.text().catch(() => "")
      const blocked = detectRoutingBlockedAccount({
        statusCode: upstream.status,
        text: bodyText,
      })
      if (blocked.matched) {
        markAccountUnhealthy(account.id, blocked.reason, "cursor-chat")
      }
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        responseBytes: new TextEncoder().encode(bodyText).byteLength,
        statusCode: upstream.status,
        latencyMs: Date.now() - startedAt,
        upstreamRequestId,
        error: bodyText || "Cursor upstream request failed",
        clientTag,
      })
      return toOpenAICompatibleErrorResponse(bodyText || `Upstream request failed (${upstream.status})`, upstream.status, upstream.status === 401 ? "authentication_error" : "server_error")
    }

    if (normalizedCursorStream) {
      const auditId = writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        responseBytes: parseHeaderNumber(upstream.headers.get("content-length")),
        statusCode: upstream.status,
        latencyMs: Date.now() - startedAt,
        upstreamRequestId,
        clientTag,
      })
      const headers = new Headers({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      if (upstreamRequestId) headers.set("x-request-id", upstreamRequestId)
      return new Response(
        streamCursorChatCompletionFromResponses({
          upstream,
          model: resolvedModelId,
          accountId: account.id,
          keyId: key.id,
          auditId,
          providerId: auditProviderId,
          virtualKeyId: auditKeyId,
          sessionId: auditSessionId,
          reasoningEffort: auditReasoningEffort,
          includeUsage: cursorRequestBody.stream_options?.include_usage === true,
        }),
        {
          status: 200,
          headers,
        },
      )
    }

    let payload: unknown = {}
    let reply = ""
    let usage = emptyUsageMetrics()
    const bodyResult = await readCodexCompatibleBody(upstream)
    payload = bodyResult.payload
    reply = bodyResult.reply
    usage = bodyResult.usage

    recordUsageMetrics({
      accountId: account.id,
      keyId: key.id,
      usage,
      source: "cursor-chat",
      providerId: auditProviderId,
      virtualKeyId: auditKeyId,
      model: resolvedModelId,
      sessionId: auditSessionId,
      reasoningEffort: auditReasoningEffort,
    })
    writeAudit({
      providerId: auditProviderId,
      accountId: auditAccountId,
      virtualKeyId: auditKeyId,
      model: auditModel,
      sessionId: auditSessionId,
      requestBytes: outgoingBody?.byteLength ?? 0,
      requestBody: outgoingBody,
      statusCode: upstream.status,
      latencyMs: Date.now() - startedAt,
      upstreamRequestId,
      clientTag,
      usage,
    })

    return c.json(
      buildCursorChatCompletionResponse({
        payload,
        model: resolvedModelId,
        usage,
        reply,
      }),
      200,
    )
  } catch (error) {
    const behaviorFailure = getBehaviorAcquireFailure(error)
    if (behaviorFailure) {
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        model: auditModel,
        sessionId: auditSessionId,
        requestBytes: outgoingBody?.byteLength ?? 0,
        requestBody: outgoingBody,
        statusCode: behaviorFailure.status,
        latencyMs: Date.now() - startedAt,
        error: `${behaviorFailure.code}: ${behaviorFailure.message}`,
        clientTag,
      })
      return toOpenAICompatibleErrorResponse(behaviorFailure.message, behaviorFailure.status, "server_error")
    }
    const statusCode = getStatusErrorCode(error) ?? (isLikelyAuthError(error) ? 401 : 400)
    const message = errorMessage(error)
    writeAudit({
      providerId: auditProviderId,
      accountId: auditAccountId,
      virtualKeyId: auditKeyId,
      model: auditModel,
      sessionId: auditSessionId,
      requestBytes: outgoingBody?.byteLength ?? 0,
      requestBody: outgoingBody,
      statusCode,
      latencyMs: Date.now() - startedAt,
      error: message,
      clientTag,
    })
    return toOpenAICompatibleErrorResponse(message, statusCode, statusCode === 401 ? "authentication_error" : "invalid_request_error")
  } finally {
    proxyPressureLease?.release()
  }
}

async function proxyVirtualKeyRateLimitUsage(c: any) {
  const startedAt = Date.now()
  const route = c.req.path
  const method = c.req.method
  const behaviorSignal = resolveBehaviorSignal(c.req.raw.headers)
  const clientTag = behaviorSignal.clientTag || null

  let auditProviderId: string | null = null
  let auditAccountId: string | null = null
  let auditKeyId: string | null = null
  let auditSessionId: string | null = null
  let auditClientMode: "codex" | "cursor" | null = null
  let auditWireApi: "responses" | "chat_completions" | null = null
  let behaviorRelease: (() => void) | null = null
  let auditRoutingMode = "single"
  const writeAudit = (input: Omit<RequestAuditCompatInput, "route" | "method" | "reasoningEffort">) =>
    writeRequestAuditCompat({
      route,
      method,
      clientMode: auditClientMode,
      wireApi: auditWireApi,
      ...input,
    })

  try {
    const bearer = extractBearerToken(c.req.header("authorization"))
    if (!bearer) {
      writeAudit({
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: "Missing Authorization Bearer token",
        clientTag,
      })
      return c.json({ error: "Missing Authorization Bearer token" }, 401)
    }

    const sessionRouteId = resolveSessionRouteID({
      headers: c.req.raw.headers,
      requestUrl: c.req.url,
    })
    auditSessionId = sessionRouteId ?? null
    const resolved = resolveVirtualApiKeyWithPoolFallback(bearer, sessionRouteId)
    if (!resolved) {
      writeAudit({
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: "Invalid, revoked, or expired virtual API key",
        clientTag,
      })
      return c.json({ error: "Invalid, revoked, or expired virtual API key" }, 401)
    }

    const modeError = buildVirtualKeyModeError({
      key: resolved.key,
      expectedClientMode: "codex",
      expectedWireApi: "responses",
    })
    if (modeError) {
      writeAudit({
        virtualKeyId: resolved.key.id,
        providerId: resolved.key.providerId,
        statusCode: modeError.status,
        latencyMs: Date.now() - startedAt,
        error: modeError.error,
        clientTag,
      })
      return c.json({ error: modeError.error }, modeError.status)
    }

    const eligibleResolved = ensureResolvedPoolAccountEligible({
      resolved,
      sessionId: sessionRouteId,
    })
    if (!eligibleResolved) {
      writeAudit({
        virtualKeyId: resolved.key.id,
        providerId: resolved.key.providerId,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }

    const consistentResolved = await ensureResolvedPoolAccountConsistent({
      resolved: eligibleResolved,
      sessionId: sessionRouteId,
    })
    if (!consistentResolved.ok) {
      writeAudit({
        virtualKeyId: eligibleResolved.key.id,
        providerId: eligibleResolved.key.providerId,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }

    const key = consistentResolved.resolved.key as typeof consistentResolved.resolved.key & {
      clientMode?: "codex" | "cursor" | null
      wireApi?: "responses" | "chat_completions" | null
    }
    auditRoutingMode = key.routingMode
    auditClientMode = key.clientMode ?? "codex"
    auditWireApi = key.wireApi ?? "responses"
    const account = consistentResolved.resolved.account
    const profile = resolveUpstreamProfileForAccount(account)
    auditKeyId = key.id
    auditAccountId = account.id
    auditProviderId = account.providerId

    const behaviorDecision = await behaviorController.acquire({
      accountId: account.id,
      signal: behaviorSignal,
    })
    if (!behaviorDecision.ok) {
      const retryAfterSeconds = behaviorDecision.retryAfterMs ? Math.max(1, Math.ceil(behaviorDecision.retryAfterMs / 1000)) : undefined
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        statusCode: behaviorDecision.status,
        latencyMs: Date.now() - startedAt,
        error: `${behaviorDecision.code}: ${behaviorDecision.message}`,
        clientTag,
      })
      return new Response(
        JSON.stringify({
          error: behaviorDecision.message,
          code: behaviorDecision.code,
        }),
        {
          status: behaviorDecision.status,
          headers: {
            "Content-Type": "application/json",
            ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
          },
        },
      )
    }
    behaviorRelease = behaviorDecision.release

    let accessToken = ""
    let accountId: string | undefined
    try {
      const auth = await resolveUpstreamAccountAuth(account)
      accessToken = auth.accessToken
      accountId = auth.accountId
    } catch (error) {
      const message = errorMessage(error)
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: message,
        clientTag,
      })
      return c.json({ error: message }, 401)
    }

    const openAIHeaders = buildAccountOpenAIHeadersForProfile(account, profile.providerMode)
    const headers = buildUpstreamForwardHeaders({
      incoming: c.req.raw.headers,
      accessToken,
      accountId,
      boundAccountId: account.id,
      providerMode: profile.providerMode,
      attachChatgptAccountId: profile.attachChatgptAccountId,
      defaultAccept: "application/json",
      organizationId: openAIHeaders?.organizationId,
      projectId: openAIHeaders?.projectId,
    })
    const upstreamUrl = buildUpstreamAbsoluteUrl(c.req.url, profile.rateLimitsEndpoint, {
      accountId: account.id,
    })

    const runUsageRequest = async (requestHeaders: Headers) =>
      (
        await requestUpstreamWithPolicy({
          url: upstreamUrl,
          method: "GET",
          headers: requestHeaders,
          accountId: account.id,
          routeTag: route,
        })
      ).response

    let upstream = await runUsageRequest(headers)
    if (upstream.status === 401 && profile.canRefreshOn401) {
      try {
        const latest = accountStore.get(account.id) ?? account
        const refreshed = await resolveUpstreamAccountAuth(latest, { forceRefresh: true })
        headers.set("authorization", `Bearer ${refreshed.accessToken}`)
        if (profile.attachChatgptAccountId && refreshed.accountId) {
          headers.set("ChatGPT-Account-ID", refreshed.accountId)
        } else {
          headers.delete("ChatGPT-Account-ID")
        }
        upstream = await runUsageRequest(headers)
      } catch (error) {
        const refreshBlocked = detectRoutingBlockedAccount({
          error,
        })
        if (refreshBlocked.matched) {
          markAccountUnhealthy(account.id, refreshBlocked.reason, "usage")
          evictAccountModelsCache(account.id)
        }
        throw error
      }
    }

    const blocked = await detectRoutingBlockedUpstreamResponse(upstream)
    if (blocked.matched) {
      markAccountUnhealthy(account.id, blocked.reason, "usage")
      evictAccountModelsCache(account.id)
    } else if (upstream.ok) {
      markAccountHealthy(account.id, "usage")
    }

    const responseHeaders = finalizeResponsesUpstreamHeaders(auditSessionId, upstream.headers)
    const upstreamRequestId =
      upstream.headers.get("x-request-id") ||
      upstream.headers.get("x-oai-request-id") ||
      upstream.headers.get("openai-request-id") ||
      upstream.headers.get("cf-ray") ||
      null
    const responseBuffer = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
    const responseBytes = responseBuffer.byteLength

    writeAudit({
      providerId: auditProviderId,
      accountId: auditAccountId,
      virtualKeyId: auditKeyId,
      responseBytes,
      statusCode: upstream.status,
      latencyMs: Date.now() - startedAt,
      upstreamRequestId,
      clientTag,
    })

    return new Response(responseBuffer, {
      status: upstream.status,
      headers: responseHeaders,
    })
  } catch (error) {
    const normalizedCaughtFailure = normalizeCaughtCodexFailure({
      error,
      routingMode: auditRoutingMode,
    })
    if (normalizedCaughtFailure) {
      writeAudit({
        providerId: auditProviderId,
        accountId: auditAccountId,
        virtualKeyId: auditKeyId,
        statusCode: normalizedCaughtFailure.status,
        latencyMs: Date.now() - startedAt,
        error: errorMessage(error),
        clientTag,
      })
      return new Response(normalizedCaughtFailure.bodyText, {
        status: normalizedCaughtFailure.status,
        headers: normalizedCaughtFailure.headers,
      })
    }
    const finalStatus = getStatusErrorCode(error) ?? (isLikelyAuthError(error) ? 401 : 400)
    writeAudit({
      providerId: auditProviderId,
      accountId: auditAccountId,
      virtualKeyId: auditKeyId,
      statusCode: finalStatus,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
      clientTag,
    })
    return c.json({ error: errorMessage(error) }, finalStatus)
  }
}

app.get("/wham/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.get("/api/codex/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.get("/backend-api/wham/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.get("/backend-api/codex/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.post("/v1/responses", (c) => proxyVirtualKeyCodexRequest(c, "/responses"))
app.post("/v1/responses/compact", (c) => proxyVirtualKeyCodexRequest(c, "/responses/compact"))
app.post("/cursor/v1/chat/completions", (c) => proxyVirtualKeyCursorChatCompletions(c))

app.post("/api/chat", async (c) => {
  try {
    const raw = await c.req.json()
    const input = ChatSchema.parse(raw)
    const account = accountStore.get(input.accountId)
    if (!account) {
      return c.json({ error: "Account not found" }, 404)
    }
    const output = await runChatWithAccount({
      account,
      model: input.model,
      message: input.message,
      sessionId: input.sessionId,
      historyNamespace: `account:${account.id}`,
      behaviorSignal: resolveBehaviorSignal(c.req.raw.headers),
    })
    return c.json(output)
  } catch (error) {
    const behaviorFailure = getBehaviorAcquireFailure(error)
    if (behaviorFailure) {
      return toBehaviorAcquireResponse(behaviorFailure)
    }
    const statusCode = getStatusErrorCode(error)
    if (statusCode) {
      return new Response(JSON.stringify({ error: errorMessage(error) }), {
        status: statusCode,
        headers: {
          "Content-Type": "application/json",
        },
      })
    }
    return c.json({ error: errorMessage(error) }, isLikelyAuthError(error) ? 401 : 400)
  }
})

app.post("/api/chat/virtual-key", async (c) => {
  let auditRoutingMode = "single"
  try {
    const raw = await c.req.json()
    const input = VirtualKeyChatSchema.parse(raw)
    const keyRecord = accountStore.getVirtualApiKeyByID(input.keyId)
    if (!keyRecord) {
      return c.json({ error: "Virtual API key not found" }, 404)
    }
    auditRoutingMode = keyRecord.routingMode
    const keyOverrides = resolveVirtualKeyRequestOverrides(keyRecord)
    const effectiveModel = keyOverrides.fixedModel ?? input.model
    const effectiveReasoningEffort = keyOverrides.fixedReasoningEffort ?? null

    const keySecret = accountStore.revealVirtualApiKey(input.keyId)
    if (!keySecret) {
      return c.json({ error: "Virtual API key secret not found" }, 404)
    }
    if (String(keySecret).startsWith("encv1:")) {
      return c.json({ error: "Virtual API key cannot be decrypted. Please renew or issue a new key." }, 409)
    }

    if (keyRecord.clientMode === "cursor" || keyRecord.wireApi === "chat_completions") {
      const cursorUrl = new URL("/cursor/v1/chat/completions", c.req.url).toString()
      const cursorHeaders = new Headers({
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${keySecret}`,
      })
      const sessionRouteId = normalizeSessionRouteID(input.sessionId)
      if (sessionRouteId) {
        cursorHeaders.set("x-session-id", sessionRouteId)
        cursorHeaders.set("x-client-request-id", sessionRouteId)
      }
      const cursorResponse = await fetch(cursorUrl, {
        method: "POST",
        headers: cursorHeaders,
        body: JSON.stringify({
          model: effectiveModel,
          messages: [{ role: "user", content: input.message }],
          stream: false,
        }),
      })
      const cursorText = await cursorResponse.text().catch(() => "")
      const cursorPayload = cursorText ? tryParseJsonText(cursorText) : {}
      if (!cursorResponse.ok) {
        const message =
          extractOpenAICompatibleErrorMessage(cursorPayload) ||
          cursorText ||
          `Cursor compatibility request failed (${cursorResponse.status})`
        return new Response(JSON.stringify({ error: message }), {
          status: cursorResponse.status,
          headers: {
            "Content-Type": "application/json",
          },
        })
      }
      const payload = cursorPayload ?? {}
      return c.json({
        reply: extractCursorChatCompletionText(payload),
        usage: normalizeUsage(payload),
        model: effectiveModel,
        raw: payload,
        sessionId: sessionRouteId ?? null,
        key: accountStore.getVirtualApiKeyByID(input.keyId),
      })
    }

    const modeError = buildVirtualKeyModeError({
      key: keyRecord,
      expectedClientMode: "codex",
      expectedWireApi: "responses",
    })
    if (modeError) {
      return c.json({ error: modeError.error }, modeError.status)
    }

    const resolved = resolveVirtualApiKeyWithPoolFallback(keySecret, input.sessionId, {
      requestedModel: effectiveModel,
    })
    if (!resolved) {
      return c.json({ error: "Invalid, revoked, or expired virtual API key" }, 401)
    }
    const eligibleResolved = ensureResolvedPoolAccountEligible({
      resolved,
      sessionId: input.sessionId,
      requestedModel: effectiveModel,
    })
    if (!eligibleResolved) {
      const unavailable = resolveAutomaticAccountAvailability({ account: resolved.account })
      return c.json(
        {
          error:
            resolved.key.routingMode === "pool"
              ? "No healthy accounts available for pool routing"
              : unavailable.ok
                ? "Upstream account is unavailable"
                : unavailable.message,
        },
        503,
      )
    }
    const consistentResolved = await ensureResolvedPoolAccountConsistent({
      resolved: eligibleResolved,
      sessionId: input.sessionId,
      requestedModel: effectiveModel,
    })
    if (!consistentResolved.ok) {
      return c.json({ error: "No healthy accounts available for pool routing", code: "no_healthy_accounts" }, 503)
    }

    let activeAccount = consistentResolved.resolved.account
    const rerouteTriedAccounts = new Set<string>()
    while (true) {
      try {
        const output = await runChatWithAccount({
          account: activeAccount,
          model: effectiveModel,
          message: input.message,
          sessionId: input.sessionId,
          historyNamespace: `key:${input.keyId}`,
          keyId: input.keyId,
          behaviorSignal: resolveBehaviorSignal(c.req.raw.headers),
          reasoningEffort: effectiveReasoningEffort,
        })

        return c.json({
          ...output,
          key: accountStore.getVirtualApiKeyByID(input.keyId),
          routedAccountId: activeAccount.id,
        })
      } catch (error) {
        if (eligibleResolved.key.routingMode !== "pool") {
          const behaviorFailure = getBehaviorAcquireFailure(error)
          if (behaviorFailure) {
            return toBehaviorAcquireResponse(behaviorFailure)
          }
          throw error
        }

        const quotaSignal = await detectQuotaExhaustedChatError(error)
        const blockedSignal = detectRoutingBlockedChatError(error)
        const transientSignal = detectTransientUpstreamError(error)
        const behaviorFailure = getBehaviorAcquireFailure(error)
        if (!quotaSignal.matched && !blockedSignal.matched && !transientSignal.matched && !behaviorFailure) {
          throw error
        }

        const failedAccountId = activeAccount.id
        rerouteTriedAccounts.add(failedAccountId)
        if (blockedSignal.matched) {
          markAccountUnhealthy(failedAccountId, blockedSignal.reason, "chat")
          evictAccountModelsCache(failedAccountId)
        } else if (quotaSignal.matched) {
          markAccountQuotaExhausted(failedAccountId)
          handleBackgroundPromise(
            "refreshAndEmitAccountQuota:chat-usage-limit-reached",
            refreshAndEmitAccountQuota(failedAccountId, "chat-usage-limit-reached"),
          )
        } else if (!behaviorFailure && transientSignal.reason === "upstream_certificate_verification_error") {
          markAccountUnhealthy(failedAccountId, transientSignal.reason, "chat")
        }
        if (rerouteTriedAccounts.size >= POOL_REROUTE_MAX_ATTEMPTS) {
          const normalizedFailure = buildUpstreamAccountUnavailableFailure({
            routingMode: eligibleResolved.key.routingMode,
          })
          return new Response(normalizedFailure.bodyText, {
            status: normalizedFailure.status,
            headers: normalizedFailure.headers,
          })
        }

        const preferredPlanCohort = resolvePreferredPlanCohortForVirtualKey({
          key: eligibleResolved.key,
          requestedModel: effectiveModel,
          account: activeAccount,
        })
        const routingHints = buildProviderRoutingHintsForVirtualKey(eligibleResolved.key, effectiveModel, Date.now(), {
          preferredPlanCohort,
        })
        const excluded = new Set<string>([...routingHints.excludeAccountIds, ...rerouteTriedAccounts])

        let reRoutedAccount = input.sessionId
          ? accountStore.reassignVirtualKeySessionRoute({
              keyId: eligibleResolved.key.id,
              providerId: eligibleResolved.key.providerId,
              sessionId: input.sessionId,
              failedAccountId,
              accountScope: eligibleResolved.key.accountScope ?? "all",
              excludeAccountIds: [...excluded],
              deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
              headroomByAccountId: routingHints.headroomByAccountId,
              pressureScoreByAccountId: routingHints.pressureScoreByAccountId,
            })
        : accountStore.reassignVirtualKeyRoute({
            keyId: eligibleResolved.key.id,
            providerId: eligibleResolved.key.providerId,
            failedAccountId,
            accountScope: eligibleResolved.key.accountScope ?? "all",
            excludeAccountIds: [...excluded],
            deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
            headroomByAccountId: routingHints.headroomByAccountId,
            pressureScoreByAccountId: routingHints.pressureScoreByAccountId,
          })

        if (!reRoutedAccount) {
          const relaxedHints = buildRelaxedProviderRoutingHintsForVirtualKey(eligibleResolved.key, effectiveModel, Date.now(), {
            preferredPlanCohort,
          })
          const relaxedExcluded = new Set<string>([...relaxedHints.excludeAccountIds, ...rerouteTriedAccounts])
          reRoutedAccount = input.sessionId
            ? accountStore.reassignVirtualKeySessionRoute({
                keyId: eligibleResolved.key.id,
                providerId: eligibleResolved.key.providerId,
                sessionId: input.sessionId,
                failedAccountId,
                accountScope: eligibleResolved.key.accountScope ?? "all",
                excludeAccountIds: [...relaxedExcluded],
                deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
                headroomByAccountId: relaxedHints.headroomByAccountId,
                pressureScoreByAccountId: relaxedHints.pressureScoreByAccountId,
              })
          : accountStore.reassignVirtualKeyRoute({
              keyId: eligibleResolved.key.id,
              providerId: eligibleResolved.key.providerId,
              failedAccountId,
              accountScope: eligibleResolved.key.accountScope ?? "all",
              excludeAccountIds: [...relaxedExcluded],
              deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
              headroomByAccountId: relaxedHints.headroomByAccountId,
              pressureScoreByAccountId: relaxedHints.pressureScoreByAccountId,
            })
        }

        if (!reRoutedAccount || rerouteTriedAccounts.has(reRoutedAccount.id)) {
          const normalizedFailure = buildUpstreamAccountUnavailableFailure({
            routingMode: eligibleResolved.key.routingMode,
          })
          return new Response(normalizedFailure.bodyText, {
            status: normalizedFailure.status,
            headers: normalizedFailure.headers,
          })
        }

        emitServerEvent("virtual-key-failover", {
          type: "virtual-key-failover",
          at: Date.now(),
          keyId: eligibleResolved.key.id,
          sessionId: input.sessionId ?? null,
          fromAccountId: failedAccountId,
          toAccountId: reRoutedAccount.id,
          reason: blockedSignal.reason ?? quotaSignal.reason ?? transientSignal.reason ?? behaviorFailure?.code ?? "routing_excluded",
        })

        activeAccount = reRoutedAccount
      }
    }
  } catch (error) {
    const behaviorFailure = getBehaviorAcquireFailure(error)
    if (behaviorFailure) {
      return toBehaviorAcquireResponse(behaviorFailure)
    }
    const normalizedCaughtFailure = normalizeCaughtCodexFailure({
      error,
      routingMode: auditRoutingMode,
    })
    if (normalizedCaughtFailure) {
      return new Response(normalizedCaughtFailure.bodyText, {
        status: normalizedCaughtFailure.status,
        headers: normalizedCaughtFailure.headers,
      })
    }
    const statusCode = getStatusErrorCode(error)
    if (statusCode) {
      return new Response(JSON.stringify({ error: errorMessage(error) }), {
        status: statusCode,
        headers: {
          "Content-Type": "application/json",
        },
      })
    }
    return c.json({ error: errorMessage(error) }, isLikelyAuthError(error) ? 401 : 400)
  }
})

function handleProcessFailure(event: string, error: unknown) {
  if (fatalShutdown) return
  fatalShutdown = true
  console.error(`[oauth-multi-login] ${event}`, error)
  forwardProxy?.stop()?.catch(() => undefined)
  callbackServer.stop()?.catch(() => undefined)
  server?.stop()
  process.exit(1)
}

process.on("unhandledRejection", (reason) => handleProcessFailure("unhandledRejection", reason))
process.on("uncaughtException", (error) => handleProcessFailure("uncaughtException", error))

try {
  bootstrapEstimatedUsageCosts()
} catch (error) {
  console.warn(`[oauth-multi-login] estimated cost bootstrap failed: ${errorMessage(error)}`)
  syncExtendedUsageTotalsStateFromStore()
}

server = Bun.serve({
  hostname: AppConfig.host,
  port: AppConfig.port,
  idleTimeout: 120,
  fetch: app.fetch,
})

const appUrl = `http://${AppConfig.host}:${AppConfig.port}`
console.log(`[oauth-multi-login] running at ${appUrl}`)
console.log(`[oauth-multi-login] callback URL for browser PKCE: ${callbackServer.redirectUrl}`)

if (FORWARD_PROXY_ENABLED) {
  if (!Number.isInteger(FORWARD_PROXY_PORT) || FORWARD_PROXY_PORT < 1 || FORWARD_PROXY_PORT > 65535) {
    console.warn(`[oauth-multi-login] forward proxy disabled: invalid port ${String(FORWARD_PROXY_PORT)}`)
  } else if (FORWARD_PROXY_ALLOWED_HOSTS.length === 0) {
    console.warn("[oauth-multi-login] forward proxy disabled: no allowed hosts configured")
  } else {
    try {
      forwardProxy = new RestrictedForwardProxy({
        host: AppConfig.host,
        port: FORWARD_PROXY_PORT,
        allowedHosts: FORWARD_PROXY_ALLOWED_HOSTS,
        enforceAllowlist: FORWARD_PROXY_ENFORCE_ALLOWLIST,
        onLog: (line) => console.log(`[oauth-multi-login] ${line}`),
      })
      await forwardProxy.start()
    } catch (error) {
      forwardProxy = null
      console.warn(`[oauth-multi-login] forward proxy startup failed: ${errorMessage(error)}`)
    }
  }
}

process.on("SIGINT", async () => {
  await forwardProxy?.stop().catch(() => undefined)
  forwardProxy = null
  await callbackServer.stop()
  server.stop()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  await forwardProxy?.stop().catch(() => undefined)
  forwardProxy = null
  await callbackServer.stop()
  server.stop()
  process.exit(0)
})
