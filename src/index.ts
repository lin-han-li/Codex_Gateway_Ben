import { Hono } from "hono"
import { z } from "zod"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { AppConfig, ensureAppDirs } from "./config"
import { resolveCodexClientVersion } from "./codex-version"
import { buildCodexUserAgent } from "./codex-identity"
import { BehaviorController, resolveBehaviorSignal, type BehaviorConfig } from "./behavior/control"
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
import { AccountStore } from "./store/db"
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

type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  windowSeconds: number | null
  windowMinutes: number | null
  resetsAt: number | null
}

type AccountQuotaEntry = {
  limitId: string | null
  limitName: string | null
  primary: AccountQuotaWindow | null
  secondary: AccountQuotaWindow | null
}

type AccountQuotaSnapshot = {
  status: "ok" | "error" | "unavailable"
  fetchedAt: number
  planType: string | null
  primary: AccountQuotaEntry | null
  additional: AccountQuotaEntry[]
  error: string | null
}

type AccountHealthSnapshot = {
  status: "error"
  reason: string
  source: string
  updatedAt: number
  expiresAt: number | null
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

type ProviderRoutingHints = {
  excludeAccountIds: string[]
  deprioritizedAccountIds: string[]
  headroomByAccountId: Map<string, number>
}

type ProviderRoutingHintsOptions = {
  allowTransientUnhealthy?: boolean
}

const ACCOUNT_QUOTA_CACHE_TTL_MS = 90 * 1000
const ACCOUNT_QUOTA_POLL_INTERVAL_MS = 60 * 1000
const ACCOUNT_SOFT_DRAIN_REMAINING_PERCENT_THRESHOLD = 10
const ACCOUNT_TRANSIENT_HEALTH_COOLDOWN_MS = 60 * 1000
const accountQuotaCache = new Map<string, AccountQuotaSnapshot>()
const accountHealthCache = new Map<string, AccountHealthSnapshot>()
const accountQuotaRefreshInFlight = new Set<string>()
let accountQuotaPollInFlight = false

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

function getEffectiveManagementToken() {
  return String(AppConfig.adminToken ?? "").trim() || String(runtimeSettings.adminToken ?? "").trim()
}

function getEffectiveEncryptionKey() {
  return String(AppConfig.encryptionKey ?? "").trim() || String(runtimeSettings.encryptionKey ?? "").trim()
}

function isStrictUpstreamPrivacyEnabled() {
  return runtimeSettings.upstreamPrivacyStrict !== false
}

const STRICT_PRIVACY_SESSION_KEYS_LOWER = new Set([
  "session_id",
  "sessionid",
  "session-id",
  "x-session-id",
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

async function loadCodexInstructions() {
  const fallback = "You are Codex, a coding agent based on GPT-5."
  const candidates = [
    process.env.OAUTH_CODEX_PROMPT_FILE,
    path.resolve(process.cwd(), "codex-official/codex-rs/core/prompt.md"),
    path.resolve(process.cwd(), "codex-official/codex-rs/core/prompt_with_apply_patch_instructions.md"),
    path.resolve(process.cwd(), "../codex-official/codex-rs/core/prompt.md"),
    path.resolve(process.cwd(), "../codex-official/codex-rs/core/prompt_with_apply_patch_instructions.md"),
    path.resolve(import.meta.dir, "../../codex-official/codex-rs/core/prompt.md"),
    path.resolve(import.meta.dir, "../../codex-official/codex-rs/core/prompt_with_apply_patch_instructions.md"),
  ].filter((item): item is string => Boolean(item))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const content = (await readFile(candidate, "utf8")).trim()
      if (content.length > 0) return content
    } catch {
      // ignore and continue
    }
  }

  return fallback
}

const CHAT_INSTRUCTIONS = await loadCodexInstructions()
type CodexModelCatalogEntry = {
  id: string
  defaultReasoningLevel: string
  supportedReasoningLevels: string[]
}

type CodexOfficialModelsFile = {
  models?: Array<{
    slug?: string
    supported_in_api?: boolean
    default_reasoning_level?: string
    supported_reasoning_levels?: Array<{ effort?: string }>
  }>
}

const FALLBACK_MODEL_CATALOG: CodexModelCatalogEntry[] = [
  { id: "gpt-5.1-codex-max", defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex-mini", defaultReasoningLevel: "medium", supportedReasoningLevels: ["medium", "high"] },
  { id: "gpt-5.2", defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.3-codex", defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.2-codex", defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex", defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] },
]

async function loadCodexModelCatalog(): Promise<CodexModelCatalogEntry[]> {
  const candidates = [
    process.env.OAUTH_CODEX_MODELS_FILE,
    path.resolve(process.cwd(), "codex-official/codex-rs/core/models.json"),
    path.resolve(process.cwd(), "../codex-official/codex-rs/core/models.json"),
    path.resolve(import.meta.dir, "../../codex-official/codex-rs/core/models.json"),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const raw = await readFile(candidate, "utf8")
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
          return {
            id,
            defaultReasoningLevel,
            supportedReasoningLevels: normalizedSupported,
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

const CODEX_MODEL_CATALOG = await loadCodexModelCatalog()
const DEFAULT_CHAT_MODELS = CODEX_MODEL_CATALOG.map((item) => item.id)
const MODEL_REASONING_LEVELS: Record<string, string[]> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.supportedReasoningLevels]),
)
const MODEL_DEFAULT_REASONING_LEVELS: Record<string, string> = Object.fromEntries(
  CODEX_MODEL_CATALOG.map((item) => [item.id, item.defaultReasoningLevel]),
)

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
  name: z.string().trim().max(120).optional(),
  validityDays: z.number().int().min(1).max(3650).nullable().optional().default(30),
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

const SyncOAuthSchema = z.object({
  providerId: z.enum(["chatgpt", "openai"]).default("chatgpt"),
  providerName: z.string().trim().min(1).max(80).optional().default("ChatGPT"),
  methodId: z.string().trim().min(1).max(80).optional().default("codex-oauth"),
  displayName: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().email().optional(),
  accountId: z.string().trim().min(1).max(160).optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
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
})

const OpenExternalUrlSchema = z.object({
  url: z.string().trim().url().max(2048),
})

function isTokenExpired(account: StoredAccount) {
  if (!account.expiresAt) return false
  return account.expiresAt < Date.now()
}

function normalizeUsage(payload: unknown) {
  const usage = (payload as { usage?: Record<string, unknown> })?.usage ?? {}
  const promptTokens = Number((usage as Record<string, unknown>).input_tokens ?? (usage as Record<string, unknown>).prompt_tokens ?? 0)
  const completionTokens = Number(
    (usage as Record<string, unknown>).output_tokens ?? (usage as Record<string, unknown>).completion_tokens ?? 0,
  )
  const totalTokens = Number((usage as Record<string, unknown>).total_tokens ?? promptTokens + completionTokens)
  return {
    promptTokens: Number.isFinite(promptTokens) ? Math.max(0, Math.floor(promptTokens)) : 0,
    completionTokens: Number.isFinite(completionTokens) ? Math.max(0, Math.floor(completionTokens)) : 0,
    totalTokens: Number.isFinite(totalTokens) ? Math.max(0, Math.floor(totalTokens)) : 0,
  }
}

function extractUsageFromUnknown(payload: unknown) {
  const direct = normalizeUsage(payload)
  if (hasUsageDelta(direct)) return direct
  if (payload && typeof payload === "object") {
    const nested = normalizeUsage((payload as Record<string, unknown>).response)
    if (hasUsageDelta(nested)) return nested
  }
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
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
  let latestUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }

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

type UsageMetrics = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

function hasUsageDelta(usage: UsageMetrics) {
  return usage.totalTokens > 0 || usage.promptTokens > 0 || usage.completionTokens > 0
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
  const usageTotals = accountStore.getUsageTotals()
  const payload = {
    type: "usage-updated",
    at: Date.now(),
    source: input.source,
    accountId: input.accountId,
    keyId: input.keyId ?? null,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    usageTotals,
  }
  emitServerEvent("usage", payload)
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
  const snapshot = getActiveAccountHealthSnapshot(normalizedAccountId)
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

function normalizeAccountHealthReason(reason: string) {
  const normalized = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return "upstream_auth_error"
  return normalized.slice(0, 240)
}

function isStickyAccountHealthReason(reason: string) {
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

function isStickyAccountHealthSnapshot(snapshot?: AccountHealthSnapshot | null) {
  return Boolean(snapshot && isStickyAccountHealthReason(snapshot.reason))
}

function resolveAccountHealthExpiry(reason: string, now = Date.now()) {
  return isStickyAccountHealthReason(reason) ? null : now + ACCOUNT_TRANSIENT_HEALTH_COOLDOWN_MS
}

function getActiveAccountHealthSnapshot(accountId: string, now = Date.now()) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return null
  const snapshot = accountHealthCache.get(normalizedAccountId)
  if (!snapshot) return null
  if (snapshot.expiresAt !== null && snapshot.expiresAt <= now) {
    accountHealthCache.delete(normalizedAccountId)
    return null
  }
  return snapshot
}

function markAccountUnhealthy(accountId: string, reason: string, source: string) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return
  const normalizedReason = normalizeAccountHealthReason(reason)
  const now = Date.now()
  const expiresAt = resolveAccountHealthExpiry(normalizedReason, now)
  const current = getActiveAccountHealthSnapshot(normalizedAccountId, now)
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
  if (account) invalidatePoolConsistency(account.providerId)
  emitAccountHealthUpdated({
    accountId: normalizedAccountId,
    source,
  })
}

function markAccountHealthy(accountId: string, source: string) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return
  const deleted = accountHealthCache.delete(normalizedAccountId)
  if (!deleted) return
  const account = accountStore.get(normalizedAccountId)
  if (account) invalidatePoolConsistency(account.providerId)
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
  const accounts = accountStore.list().filter((account) => account.providerId === "chatgpt")
  if (accounts.length === 0) return

  accountQuotaPollInFlight = true
  try {
    await refreshAccountQuotaCache(accounts, { force: true })
    for (const account of accounts) {
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
        invalidatePoolConsistency(account.providerId)
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

function normalizeQuotaWindow(window: unknown): AccountQuotaWindow | null {
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

function normalizeQuotaEntry(rateLimit: unknown, limitId: string | null, limitName: string | null): AccountQuotaEntry | null {
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

function normalizeRateLimitUsagePayload(payload: unknown) {
  const root = asObjectRecord(payload) ?? {}
  const planTypeRaw = String(root.plan_type ?? "").trim()
  const planType = planTypeRaw.length > 0 ? planTypeRaw : null

  const allEntries: AccountQuotaEntry[] = []
  const codexEntry = normalizeQuotaEntry(root.rate_limit, "codex", null)
  if (codexEntry) allEntries.push(codexEntry)

  const additionalRaw = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : []
  for (const item of additionalRaw) {
    const row = asObjectRecord(item)
    if (!row) continue
    const meteredFeature = String(row.metered_feature ?? "").trim()
    const limitName = String(row.limit_name ?? "").trim()
    const limitId = meteredFeature.length > 0 ? meteredFeature : limitName.length > 0 ? limitName : null
    const entry = normalizeQuotaEntry(row.rate_limit, limitId, limitName || null)
    if (entry) allEntries.push(entry)
  }

  const primary = allEntries.find((item) => item.limitId === "codex") ?? allEntries[0] ?? null
  const additional = allEntries.filter((item) => item !== primary)
  return {
    planType,
    primary,
    additional,
  }
}

function makeUnavailableQuota(reason?: string): AccountQuotaSnapshot {
  return {
    status: "unavailable",
    fetchedAt: Date.now(),
    planType: null,
    primary: null,
    additional: [],
    error: reason ? String(reason) : null,
  }
}

function makeQuotaError(error: unknown): AccountQuotaSnapshot {
  return {
    status: "error",
    fetchedAt: Date.now(),
    planType: null,
    primary: null,
    additional: [],
    error: errorMessage(error),
  }
}

function isQuotaCacheFresh(snapshot: AccountQuotaSnapshot | undefined, now = Date.now()) {
  if (!snapshot) return false
  return now - Number(snapshot.fetchedAt || 0) <= ACCOUNT_QUOTA_CACHE_TTL_MS
}

function resolveQuotaEntryHeadroomPercent(entry: AccountQuotaEntry | null | undefined) {
  if (!entry) return null
  const values = [entry.primary?.remainingPercent, entry.secondary?.remainingPercent].filter((value) =>
    Number.isFinite(value),
  ) as number[]
  if (values.length === 0) return null
  return Math.max(0, Math.min(...values.map((value) => Math.round(value))))
}

function resolveQuotaSnapshotHeadroomPercent(snapshot: AccountQuotaSnapshot | null | undefined, now = Date.now()) {
  if (!snapshot || snapshot.status !== "ok" || !isQuotaCacheFresh(snapshot, now)) return null
  const values = [snapshot.primary, ...snapshot.additional]
    .map((entry) => resolveQuotaEntryHeadroomPercent(entry))
    .filter((value) => Number.isFinite(value)) as number[]
  if (values.length === 0) return null
  return Math.max(0, Math.min(...values))
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

function buildProviderRoutingHints(
  providerId: string,
  now = Date.now(),
  options?: ProviderRoutingHintsOptions,
): ProviderRoutingHints {
  const quotaHints = buildProviderQuotaRoutingHints(providerId, now)
  const consistencyExclusions = collectProviderConsistencyExclusions(providerId, now)
  const excluded = new Set([
    ...collectProviderQuotaExhaustedExclusions(providerId, now),
    ...collectProviderUnhealthyExclusions(providerId, {
      includeTransient: options?.allowTransientUnhealthy !== true,
    }),
    ...quotaHints.excludeAccountIds,
    ...consistencyExclusions,
  ])
  return {
    excludeAccountIds: [...excluded],
    deprioritizedAccountIds: quotaHints.deprioritizedAccountIds.filter((accountId) => !excluded.has(accountId)),
    headroomByAccountId: quotaHints.headroomByAccountId,
  }
}

function buildRelaxedProviderRoutingHints(providerId: string, now = Date.now()) {
  return buildProviderRoutingHints(providerId, now, {
    allowTransientUnhealthy: true,
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
  const unhealthy = getActiveAccountHealthSnapshot(normalizedAccountId, now)
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
    hasAccessToken: Boolean(account.accessToken),
    hasRefreshToken: Boolean(account.refreshToken),
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
    expiresAt: resolved.expiresAt,
    metadata: resolved.metadata,
  })
  markAccountHealthy(accountID, "codex-json-import")
  invalidatePoolConsistency("chatgpt")
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
    finalExpiresAt = refreshResult.expiresAt ?? finalExpiresAt
    finalResolved = resolvePortableOAuthTokenProfile({
      accessToken,
      idToken,
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
    expiresAt: finalExpiresAt,
    metadata: {
      source: "codex-refresh-token-import",
      importMode: accessTokenCandidate ? "refresh-token-with-access-token" : "refresh-token-refresh-first",
      importedAccountId,
      importedWorkspaceId,
      idTokenPresent: Boolean(idToken),
      organizationId: finalResolved.organizationId,
      projectId: finalResolved.projectId,
      chatgptPlanType: finalResolved.chatgptPlanType,
      chatgptUserId: finalResolved.chatgptUserId,
      completedPlatformOnboarding: finalResolved.completedPlatformOnboarding,
      isOrgOwner: finalResolved.isOrgOwner,
    },
  })
  markAccountHealthy(accountID, refreshed ? "refresh-token-import-refresh" : "refresh-token-import")
  invalidatePoolConsistency(input.providerId)
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

function runOpenCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    stdio: "pipe",
    encoding: "utf8",
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

function openExternalUrl(url: string) {
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are allowed")
  }

  const attempts: ReturnType<typeof runOpenCommand>[] = []
  const strategies: Array<{ command: string; args: string[] }> = []

  if (process.platform === "win32") {
    strategies.push({ command: "explorer", args: [url] })
    strategies.push({
      command: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$p = Start-Process -FilePath '${url}' -PassThru; if ($p) { Write-Output $p.Id }`,
      ],
    })
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
    const candidates = ["session_id", "sessionId", "prompt_cache_key", "promptCacheKey"]
    for (const key of candidates) {
      const normalized = normalizeSessionRouteID(url.searchParams.get(key))
      if (normalized) return normalized
    }
  } catch {
    // ignore malformed URL and continue
  }
  return undefined
}

function resolveSessionRouteID(input: { headers?: Headers; requestUrl?: string | null; bodySessionId?: string | null }) {
  return (
    normalizeSessionRouteID(input.bodySessionId) ??
    extractSessionRouteIDFromHeaders(input.headers) ??
    extractSessionRouteIDFromRequestUrl(input.requestUrl)
  )
}

function resolveVirtualKeyContext(c: any) {
  const bearer = extractBearerToken(c.req.header("authorization"))
  if (!bearer) return { error: "Missing Authorization Bearer token" as const, status: 401 as const }

  const sessionId = resolveSessionRouteID({
    headers: c.req.raw.headers,
    requestUrl: c.req.url,
  })
  const resolved = resolveVirtualApiKeyWithPoolFallback(bearer, sessionId)
  if (!resolved) return { error: "Invalid, revoked, or expired virtual API key" as const, status: 401 as const }

  const routed = ensureResolvedPoolAccountEligible({
    resolved,
    sessionId,
  })
  if (!routed) {
    return { error: "No healthy accounts available for pool routing" as const, status: 503 as const }
  }

  return { resolved: routed, sessionId }
}

function resolveVirtualApiKeyWithPoolFallback(secret: string, sessionId?: string | null) {
  const primary = accountStore.resolveVirtualApiKey(secret, {
    sessionId,
    routeOptionsFactory: (key) => (key.routingMode === "pool" ? buildProviderRoutingHints(key.providerId) : undefined),
  })
  if (primary) return primary
  return accountStore.resolveVirtualApiKey(secret, {
    sessionId,
    routeOptionsFactory: (key) => (key.routingMode === "pool" ? buildRelaxedProviderRoutingHints(key.providerId) : undefined),
  })
}

function rerouteResolvedPoolAccount(input: {
  resolved: {
    key: {
      id: string
      providerId: string
      routingMode: string
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
        excludeAccountIds: input.routingHints.excludeAccountIds,
        deprioritizedAccountIds: input.routingHints.deprioritizedAccountIds,
        headroomByAccountId: input.routingHints.headroomByAccountId,
      })
    : accountStore.reassignVirtualKeyRoute({
        keyId: input.resolved.key.id,
        providerId: input.resolved.key.providerId,
        failedAccountId,
        excludeAccountIds: input.routingHints.excludeAccountIds,
        deprioritizedAccountIds: input.routingHints.deprioritizedAccountIds,
        headroomByAccountId: input.routingHints.headroomByAccountId,
      })
}

function ensureResolvedPoolAccountEligible(input: {
  resolved: {
    key: {
      id: string
      providerId: string
      routingMode: string
    }
    account: StoredAccount
  }
  sessionId?: string | null
  routingHints?: ProviderRoutingHints
}) {
  if (input.resolved.key.routingMode !== "pool") {
    return input.resolved
  }

  const routingHints = input.routingHints ?? buildProviderRoutingHints(input.resolved.key.providerId)
  const excluded = new Set<string>(routingHints.excludeAccountIds)
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
    },
  })
  if (!reroutedAccount) {
    const relaxedHints = buildRelaxedProviderRoutingHints(input.resolved.key.providerId)
    const relaxedExcluded = new Set(relaxedHints.excludeAccountIds)
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
    }
    account: StoredAccount
  }
  sessionId?: string | null
}) {
  if (input.resolved.key.routingMode !== "pool") {
    return { ok: true as const, resolved: input.resolved }
  }
  const poolConsistency = await getProviderPoolConsistency(input.resolved.key.providerId)
  if (!poolConsistency.ok) {
    return { ok: false as const, type: "consistency" as const, poolConsistency }
  }
  const rerouted = ensureResolvedPoolAccountEligible({
    resolved: input.resolved,
    sessionId: input.sessionId,
    routingHints: buildProviderRoutingHints(input.resolved.key.providerId),
  })
  if (!rerouted) {
    return { ok: false as const, type: "noHealthy" as const }
  }
  return { ok: true as const, resolved: rerouted }
}

function parseAuditRequestFields(input: { body: Uint8Array; contentType?: string | null }) {
  const contentType = String(input.contentType ?? "").toLowerCase()
  if (!contentType.includes("application/json")) {
    return { model: null as string | null, sessionId: null as string | null }
  }

  try {
    const text = new TextDecoder().decode(input.body)
    const parsed = JSON.parse(text) as Record<string, unknown>
    const modelRaw = parsed.model
    const model = typeof modelRaw === "string" && modelRaw.trim().length > 0 ? modelRaw.trim() : null
    const sessionCandidates = [parsed.session_id, parsed.sessionId, parsed.prompt_cache_key]
    const sessionId =
      sessionCandidates.find((value) => typeof value === "string" && String(value).trim().length > 0)?.toString() ?? null
    return { model, sessionId }
  } catch {
    return { model: null as string | null, sessionId: null as string | null }
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
  let latestUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
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
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
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
}

type ModelsUpstreamPayload = {
  models?: Array<Record<string, unknown>>
  data?: Array<Record<string, unknown>>
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
const QUOTA_EXHAUSTED_ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000
const quotaExhaustedAccountCooldown = new Map<string, number>()

type PoolConsistencySuccess = {
  ok: true
  providerId: string
  checkedAt: number
  accountCount: number
  eligibleAccountIds: string[]
  excludedAccountIds: string[]
  warnings: string[]
}

type PoolConsistencyFailure = {
  ok: false
  providerId: string
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
    const fingerprint = `${input.providerId}:${details}`
    const cached = poolConsistencyObservationLogCache.get(input.providerId)
    if (cached && cached.fingerprint === fingerprint && now - cached.loggedAt < POOL_CONSISTENCY_OBSERVATION_LOG_TTL_MS) {
      return
    }
    poolConsistencyObservationLogCache.set(input.providerId, {
      fingerprint,
      loggedAt: now,
    })
    console.info(
      `[oauth-multi-login] pool consistency observe provider=${input.providerId} eligible=${input.eligibleCount}/${input.accountCount} details=${details}`,
    )
    return
  }

  poolConsistencyObservationLogCache.delete(input.providerId)
  console.warn(
    `[oauth-multi-login] pool consistency constrained provider=${input.providerId} eligible=${input.eligibleCount}/${input.accountCount} details=${details}`,
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

  return {
    object: "list",
    data: orderedIDs.map((id) => {
      const levels = MODEL_REASONING_LEVELS[id] ?? ["medium"]
      const defaultReasoningLevel = MODEL_DEFAULT_REASONING_LEVELS[id] ?? (levels.includes("medium") ? "medium" : levels[0])
      return {
        id,
        object: "model",
        created,
        owned_by: "openai",
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: levels.map((effort) => ({ effort })),
      }
    }),
  }
}

function resolveModelCatalogForCodexMode() {
  return buildModelCatalogPayload({
    ids: [...DEFAULT_CHAT_MODELS],
  })
}

function resolveChatModelList() {
  return [...DEFAULT_CHAT_MODELS]
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
    const levels = normalizeReasoningLevelsFromModelPayload(model)
    const defaultReasoningLevel =
      extractModelID(model.default_reasoning_level ?? model.defaultReasoningLevel) ??
      (levels.includes("medium") ? "medium" : levels[0] ?? "medium")
    data.push({
      id,
      object: "model",
      created,
      owned_by: "openai",
      default_reasoning_level: defaultReasoningLevel,
      supported_reasoning_levels: levels.length > 0 ? levels.map((effort) => ({ effort })) : [{ effort: "medium" }],
    })
  }

  if (data.length === 0) {
    return resolveModelCatalogForCodexMode()
  }

  return {
    object: "list",
    data,
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
  if (!requestUrl) return CODEX_CLIENT_VERSION
  try {
    const incoming = new URL(requestUrl)
    const queryVersion = String(incoming.searchParams.get("client_version") ?? "").trim()
    if (queryVersion.length > 0) return queryVersion
  } catch {
    // ignore malformed URL and fallback to server version
  }
  return CODEX_CLIENT_VERSION
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

function invalidatePoolConsistency(providerId?: string | null) {
  const normalizedProviderId = normalizeIdentity(providerId)?.toLowerCase()
  if (normalizedProviderId) {
    poolConsistencyCache.delete(normalizedProviderId)
    poolConsistencyRefreshInFlight.delete(normalizedProviderId)
    poolConsistencyObservationLogCache.delete(normalizedProviderId)
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

function getCachedPoolConsistencySuccess(providerId: string, now = Date.now()) {
  const normalizedProviderId = (normalizeIdentity(providerId) ?? "chatgpt").toLowerCase()
  const cached = poolConsistencyCache.get(normalizedProviderId)
  if (!cached?.ok) return null
  if (now - cached.checkedAt > POOL_CONSISTENCY_TTL_MS) return null
  return cached
}

function getCachedPoolConsistencyResult(providerId: string, now = Date.now()) {
  const normalizedProviderId = (normalizeIdentity(providerId) ?? "chatgpt").toLowerCase()
  const cached = poolConsistencyCache.get(normalizedProviderId)
  if (!cached) return null
  if (now - cached.checkedAt > POOL_CONSISTENCY_TTL_MS) return null
  return cached
}

async function evaluateProviderPoolConsistency(providerId: string): Promise<PoolConsistencyResult> {
  const normalizedProviderId = (normalizeIdentity(providerId) ?? "chatgpt").toLowerCase()
  const checkedAt = Date.now()
  const candidates = accountStore
    .list()
    .filter(
      (account) =>
        account.providerId.toLowerCase() === normalizedProviderId &&
        Boolean(account.accessToken) &&
        !isStickyAccountHealthSnapshot(getActiveAccountHealthSnapshot(account.id, checkedAt)),
    )

  if (candidates.length <= 1) {
    return {
      ok: true,
      providerId: normalizedProviderId,
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
    eligibleCount: eligibleAccounts.length,
    accountCount: candidates.length,
    excludedAccountIds: [...excludedAccountIds],
    warnings,
  })

  return {
    ok: true,
    providerId: normalizedProviderId,
    checkedAt,
    accountCount: candidates.length,
    eligibleAccountIds: eligibleAccounts.map((account) => account.id),
    excludedAccountIds: [...excludedAccountIds],
    warnings,
  }
}

async function getProviderPoolConsistency(providerId: string, options?: { force?: boolean }) {
  const normalizedProviderId = (normalizeIdentity(providerId) ?? "chatgpt").toLowerCase()
  const force = options?.force === true
  if (!force) {
    const cached = poolConsistencyCache.get(normalizedProviderId)
    if (cached && Date.now() - cached.checkedAt <= POOL_CONSISTENCY_TTL_MS) {
      return cached
    }
  }

  const inFlight = poolConsistencyRefreshInFlight.get(normalizedProviderId)
  if (inFlight) return inFlight

  const refreshTask = (async () => {
    const result = await evaluateProviderPoolConsistency(normalizedProviderId)
    poolConsistencyCache.set(normalizedProviderId, result)
    return result
  })()

  poolConsistencyRefreshInFlight.set(normalizedProviderId, refreshTask)
  try {
    return await refreshTask
  } finally {
    poolConsistencyRefreshInFlight.delete(normalizedProviderId)
  }
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
      const snapshot = getActiveAccountHealthSnapshot(accountId, now)
      if (!snapshot) continue
      if (!includeTransient && !isStickyAccountHealthSnapshot(snapshot)) continue
      excluded.push(accountId)
    }
  }
  return excluded
}

function collectProviderConsistencyExclusions(providerId: string, now = Date.now()) {
  const cached = getCachedPoolConsistencySuccess(providerId, now)
  return cached?.excludedAccountIds ?? []
}

function collectProviderRoutingExclusions(providerId: string, now = Date.now()) {
  return buildProviderRoutingHints(providerId, now).excludeAccountIds
}

function resolveAccountRoutingExclusionReason(accountId: string, now = Date.now()) {
  const normalizedAccountId = normalizeIdentity(accountId)
  if (!normalizedAccountId) return "routing_excluded"
  cleanupQuotaExhaustedCooldown(now)
  const unhealthy = getActiveAccountHealthSnapshot(normalizedAccountId, now)
  if (unhealthy) return unhealthy.reason || "account_unhealthy"
  if (quotaExhaustedAccountCooldown.has(normalizedAccountId)) return "quota_exhausted_cooldown"
  const account = accountStore.get(normalizedAccountId)
  if (account) {
    const consistency = getCachedPoolConsistencySuccess(account.providerId, now)
    if (consistency?.excludedAccountIds.includes(normalizedAccountId)) {
      return "pool_consistency_excluded"
    }
  }
  const headroom = resolveQuotaSnapshotHeadroomPercent(accountQuotaCache.get(normalizedAccountId), now)
  if (Number.isFinite(headroom) && Number(headroom) <= 0) return "quota_headroom_exhausted"
  return "routing_excluded"
}

async function detectQuotaExhaustedUpstreamResponse(response: Response) {
  const status = Number(response.status ?? 0)
  if (status !== 429 && status !== 403) {
    return { matched: false as const }
  }

  let code = ""
  let type = ""
  let message = ""
  let rawText = ""
  try {
    rawText = (await response.clone().text()).slice(0, 8192)
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
  if (!Number.isFinite(status) || (status !== 429 && status !== 403)) {
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
    text = (await response.clone().text()).slice(0, 8192)
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
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "prompt_cache_key",
  "promptCacheKey",
]
const STRICT_PRIVACY_METADATA_FIELD_PATTERN =
  /(^|_)(user|email|mail|phone|mobile|ip|account|workspace|org|organization|tenant|employee|device|machine|host|client)(_|$)/i

function sanitizeUpstreamJsonBody(input: {
  body?: Uint8Array
  contentType?: string | null
  strictPrivacy: boolean
  accountId?: string | null
}) {
  if (!input.body || (!input.strictPrivacy && !input.accountId)) return { body: input.body, strippedFields: [] as string[] }
  const contentType = String(input.contentType ?? "").toLowerCase()
  if (!contentType.includes("application/json")) return { body: input.body, strippedFields: [] as string[] }

  try {
    const payload = JSON.parse(new TextDecoder().decode(input.body)) as unknown
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
      const rewritten = rewriteClientIdentifierForUpstream({
        accountId: input.accountId,
        fieldKey: key,
        value: root[key],
        strictPrivacy: input.strictPrivacy,
      })
      if (!rewritten) continue
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
          const rewritten = rewriteClientIdentifierForUpstream({
            accountId: input.accountId,
            fieldKey: normalizedKey,
            value: metadata[key],
            strictPrivacy: input.strictPrivacy,
          })
          if (!rewritten) continue
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
  return STRICT_PRIVACY_DROPPED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

const STRICT_PRIVACY_SESSION_HEADER_NAMES = [
  "session_id",
  "session-id",
  "sessionid",
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
    CODEX_VERSION_PATTERN.test(incomingVersion) &&
    incomingUserAgent.startsWith(`${incomingOriginator}/${incomingVersion} `)
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
  attachChatgptAccountId?: boolean
  defaultAccept?: string
  organizationId?: string
  projectId?: string
  strictPrivacy?: boolean
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
  headers.set("version", identity.version)
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
  return headers
}

const PASSTHROUGH_CODEX_FAILURE_HEADERS = new Set([
  "content-type",
  "content-language",
  "retry-after",
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
}) {
  const policy: UpstreamRetryPolicy = {
    ...upstreamRetryPolicy,
    ...input.policyOverride,
  }
  return fetchWithUpstreamRetry({
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

  let auth = await resolveUpstreamAccountAuth(input.account)
  let response = await requestWithAuth(auth)
  if (response.status === 401 && profile.canRefreshOn401) {
    const latest = accountStore.get(input.account.id) ?? input.account
    auth = await resolveUpstreamAccountAuth(latest, { forceRefresh: true })
    response = await requestWithAuth(auth)
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
  const entries = extractModelsEntries(payload)
  const contentType = normalizeHeaderIdentityValue(response.headers.get("content-type")) ?? "application/json"
  const etag = normalizeHeaderIdentityValue(response.headers.get("etag")) ?? null
  markAccountHealthy(input.account.id, "models")
  return {
    accountId: input.account.id,
    clientVersion: input.clientVersion,
    fetchedAt: Date.now(),
    etag,
    contentType,
    payload: payload as ModelsUpstreamPayload,
    entries,
    body,
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

async function trackUsageFromStream(input: { accountId: string; keyId?: string; stream: ReadableStream<Uint8Array> }) {
  try {
    const { payload, usage: streamUsage } = await readCodexStream(new Response(input.stream))
    const usage = hasUsageDelta(streamUsage) ? streamUsage : normalizeUsage(payload)
    if (hasUsageDelta(usage)) {
      accountStore.addUsage({
        id: input.accountId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      })
      if (input.keyId) {
        accountStore.addVirtualKeyUsage({
          id: input.keyId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        })
      }
      emitUsageUpdated({
        accountId: input.accountId,
        keyId: input.keyId,
        usage,
        source: "proxy-stream",
      })
    }
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
}) {
  const modelConfig = getResponsesModelConfig(input.model)
  const requestBody: Record<string, unknown> = {
    model: input.model,
    input: input.payloadInput,
    store: false,
    instructions: CHAT_INSTRUCTIONS,
    prompt_cache_key: bindClientIdentifierToAccount({
      accountId: input.accountId,
      fieldKey: "prompt_cache_key",
      value: input.sessionId,
    }),
    stream: true,
  }

  if (modelConfig.requiredAutoTruncation) {
    requestBody.truncation = "auto"
  }

  if (modelConfig.isReasoningModel && !input.model.includes("gpt-5-pro")) {
    requestBody.reasoning = { effort: "medium", summary: "auto" }
  }

  if (input.model.includes("gpt-5.") && !input.model.includes("codex") && !input.model.includes("-chat")) {
    requestBody.text = { verbosity: "low" }
  }

  return requestBody
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

async function trackUsageFromJsonStream(input: { accountId: string; keyId?: string; stream: ReadableStream<Uint8Array> }) {
  try {
    const text = await new Response(input.stream).text()
    if (!text) return
    const parsed = await extractUsageFromStructuredResponseText(text)
    const usage = parsed.usage
    if (hasUsageDelta(usage)) {
      accountStore.addUsage({
        id: input.accountId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      })
      if (input.keyId) {
        accountStore.addVirtualKeyUsage({
          id: input.keyId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        })
      }
      emitUsageUpdated({
        accountId: input.accountId,
        keyId: input.keyId,
        usage,
        source: "proxy-json",
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
    expiresAt: refreshed.expiresAt ?? Date.now() + 3600 * 1000,
    accountId: refreshed.accountId ?? account.accountId ?? undefined,
  }
  accountStore.updateTokens({
    id: account.id,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
    accountId: next.accountId,
  })
  markAccountHealthy(account.id, "refresh")
  return next
}

async function runChatWithAccount(input: {
  account: StoredAccount
  model: string
  message: string
  sessionId?: string
  historyNamespace: string
  keyId?: string
}) {
  if (input.account.providerId !== "chatgpt") {
    throw new Error("Only ChatGPT OAuth accounts support this chat endpoint")
  }

  const sessionId = input.sessionId || crypto.randomUUID()
  const auth = await ensureChatgptAccountAccess(input.account)
  const accessToken = auth.accessToken
  const accountId = auth.accountId

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    authorization: `Bearer ${accessToken}`,
    originator: CODEX_ORIGINATOR,
    "User-Agent": CODEX_USER_AGENT,
    version: CODEX_CLIENT_VERSION,
    session_id: bindClientIdentifierToAccount({
      accountId: input.account.id,
      fieldKey: "session_id",
      value: sessionId,
    }),
  })

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
  })
  const requestBodyBytes = new TextEncoder().encode(JSON.stringify(requestBody))
  let chatResponse = (
    await requestUpstreamWithPolicy({
      url: CODEX_RESPONSES_ENDPOINT,
      method: "POST",
      headers,
      body: requestBodyBytes,
      accountId: input.account.id,
      routeTag: "/api/chat",
      policyOverride: input.keyId ? { retry5xx: false, retryTransport: false } : undefined,
    })
  ).response

  if (chatResponse.status === 401) {
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
        policyOverride: input.keyId ? { retry5xx: false, retryTransport: false } : undefined,
      })
    ).response
  }

  if (!chatResponse.ok) {
    const body = await chatResponse.text().catch(() => "")
    const blocked = detectRoutingBlockedAccount({
      statusCode: chatResponse.status,
      text: body,
    })
    if (blocked.matched) {
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
  if (hasUsageDelta(usage)) {
    accountStore.addUsage({
      id: input.account.id,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    })
    if (input.keyId) {
      accountStore.addVirtualKeyUsage({
        id: input.keyId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      })
    }
    emitUsageUpdated({
      accountId: input.account.id,
      keyId: input.keyId,
      usage,
      source: input.keyId ? "virtual-key-chat" : "chat",
    })
  }

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

app.get("/api/settings", (c) =>
  {
    const serviceInfo = getSafeServiceAddressInfo(AppConfig.host, AppConfig.port)
    return c.json({
      settings: {
        localServiceAddress: runtimeSettings.localServiceAddress,
        activeLocalServiceAddress: serviceInfo.activeLocalServiceAddress,
        bindServiceAddress: serviceInfo.bindServiceAddress,
        lanServiceAddresses: serviceInfo.lanServiceAddresses,
        preferredClientServiceAddress: serviceInfo.preferredClientServiceAddress,
        managementAuthEnabled: Boolean(getEffectiveManagementToken()),
        encryptionKeyConfigured: Boolean(getEffectiveEncryptionKey()),
        upstreamPrivacyStrict: isStrictUpstreamPrivacyEnabled(),
        restartRequired: true,
      },
    })
  },
)

app.post("/api/settings", async (c) => {
  try {
    const raw = await c.req.json()
    const input = UpdateSettingsSchema.parse(raw)
    const normalized = normalizeLocalServiceAddress(input.localServiceAddress)
    const nextAdminToken = input.adminToken === undefined ? String(runtimeSettings.adminToken ?? "").trim() : String(input.adminToken ?? "").trim()
    const nextEncryptionKey =
      input.encryptionKey === undefined ? String(runtimeSettings.encryptionKey ?? "").trim() : String(input.encryptionKey ?? "").trim()
    const nextUpstreamPrivacyStrict =
      input.upstreamPrivacyStrict === undefined ? runtimeSettings.upstreamPrivacyStrict !== false : Boolean(input.upstreamPrivacyStrict)
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
    await saveRuntimeSettings(runtimeSettings)
    const serviceInfo = getSafeServiceAddressInfo(AppConfig.host, AppConfig.port)
    return c.json({
      success: true,
      settings: {
        localServiceAddress: runtimeSettings.localServiceAddress,
        activeLocalServiceAddress: serviceInfo.activeLocalServiceAddress,
        bindServiceAddress: serviceInfo.bindServiceAddress,
        lanServiceAddresses: serviceInfo.lanServiceAddresses,
        preferredClientServiceAddress: serviceInfo.preferredClientServiceAddress,
        managementAuthEnabled: Boolean(getEffectiveManagementToken()),
        encryptionKeyConfigured: Boolean(getEffectiveEncryptionKey()),
        upstreamPrivacyStrict: isStrictUpstreamPrivacyEnabled(),
        restartRequired: true,
      },
      warnings,
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
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

app.get("/api/audits", (c) => {
  const limit = parseHeaderNumber(c.req.query("limit") ?? "200")
  const logs = accountStore.listRequestAudits(limit > 0 ? limit : 200)
  return c.json({ logs })
})

app.post("/api/audits/clear", (c) => {
  accountStore.clearRequestAudits()
  return c.json({ success: true })
})

app.get("/api/providers", () =>
  Response.json({
    providers: providers.listPublic(),
  }),
)

app.get("/api/chat/models", (c) => {
  const models = resolveChatModelList()
  return c.json({ models })
})

app.get("/v1/models", async (c) => {
  const context = resolveVirtualKeyContext(c)
  if ("error" in context) {
    return c.json({ error: context.error }, context.status ?? 401)
  }
  const consistentContext = await ensureResolvedPoolAccountConsistent({
    resolved: context.resolved,
    sessionId: context.sessionId,
  })
  if (!consistentContext.ok) {
    if (consistentContext.type === "consistency") {
      return toPoolConsistencyErrorResponse(consistentContext.poolConsistency)
    }
    return c.json({ error: "No healthy accounts available for pool routing" }, 503)
  }
  const resolvedContext = consistentContext.resolved

  const behaviorDecision = await behaviorController.acquire({
    accountId: resolvedContext.account.id,
    signal: resolveBehaviorSignal(c.req.raw.headers),
  })
  if (!behaviorDecision.ok) {
    const retryAfterSeconds = behaviorDecision.retryAfterMs ? Math.max(1, Math.ceil(behaviorDecision.retryAfterMs / 1000)) : undefined
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

  const profile = resolveUpstreamProfileForAccount(resolvedContext.account)

  try {
    if (profile.providerMode === "openai") {
      return await proxyOpenAIModelsRequest({
        account: resolvedContext.account,
        requestUrl: c.req.url,
        requestHeaders: c.req.raw.headers,
        routeTag: "/models",
      })
    }
    const snapshot = await getModelsSnapshot({
      account: resolvedContext.account,
      requestUrl: c.req.url,
      requestHeaders: c.req.raw.headers,
    })
    const headers = new Headers()
    headers.set("content-type", snapshot.contentType)
    if (snapshot.etag) headers.set("etag", snapshot.etag)
    headers.set("cache-control", "no-store")
    headers.delete("content-length")
    return new Response(new Uint8Array(snapshot.body), {
      status: 200,
      headers,
    })
  } catch (error) {
    const normalizedCaughtFailure = normalizeCaughtCodexFailure({
      error,
      routingMode: resolvedContext.key.routingMode,
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
    return c.json({ error: errorMessage(error) }, isLikelyAuthError(error) ? 401 : 502)
  } finally {
    behaviorDecision.release()
  }
})

app.get("/v1/models/:id", async (c) => {
  const context = resolveVirtualKeyContext(c)
  if ("error" in context) {
    return c.json({ error: context.error }, context.status ?? 401)
  }
  const consistentContext = await ensureResolvedPoolAccountConsistent({
    resolved: context.resolved,
    sessionId: context.sessionId,
  })
  if (!consistentContext.ok) {
    if (consistentContext.type === "consistency") {
      return toPoolConsistencyErrorResponse(consistentContext.poolConsistency)
    }
    return c.json({ error: "No healthy accounts available for pool routing" }, 503)
  }
  const resolvedContext = consistentContext.resolved
  const id = c.req.param("id")
  const profile = resolveUpstreamProfileForAccount(resolvedContext.account)

  const behaviorDecision = await behaviorController.acquire({
    accountId: resolvedContext.account.id,
    signal: resolveBehaviorSignal(c.req.raw.headers),
  })
  if (!behaviorDecision.ok) {
    const retryAfterSeconds = behaviorDecision.retryAfterMs ? Math.max(1, Math.ceil(behaviorDecision.retryAfterMs / 1000)) : undefined
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

  let snapshot: AccountModelsSnapshot
  try {
    if (profile.providerMode === "openai") {
      return await proxyOpenAIModelsRequest({
        account: resolvedContext.account,
        requestUrl: c.req.url,
        requestHeaders: c.req.raw.headers,
        routeTag: "/models/:id",
        modelId: id,
      })
    }
    snapshot = await getModelsSnapshot({
      account: resolvedContext.account,
      requestUrl: c.req.url,
      requestHeaders: c.req.raw.headers,
    })
  } catch (error) {
    const normalizedCaughtFailure = normalizeCaughtCodexFailure({
      error,
      routingMode: resolvedContext.key.routingMode,
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
    return c.json({ error: errorMessage(error) }, isLikelyAuthError(error) ? 401 : 502)
  } finally {
    behaviorDecision.release()
  }

  const model = snapshot.entries.find((item) => extractModelEntryID(item) === id)
  if (!model) return c.json({ error: `Model not found: ${id}` }, 404)
  const headers = new Headers()
  headers.set("content-type", snapshot.contentType || "application/json")
  if (snapshot.etag) headers.set("etag", snapshot.etag)
  headers.set("cache-control", "no-store")
  headers.delete("content-length")
  return new Response(JSON.stringify(model), {
    status: 200,
    headers,
  })
})

app.get("/api/accounts", async (c) => {
  const refreshQuota = String(c.req.query("refreshQuota") ?? "").trim() === "1"
  const forceQuota = String(c.req.query("forceQuota") ?? "").trim() === "1"
  const targetAccountID = String(c.req.query("accountId") ?? "").trim() || null
  const accounts = accountStore.list()
  if (refreshQuota) {
    await refreshAccountQuotaCache(accounts, {
      force: forceQuota,
      targetAccountID,
    })
  }
  return c.json({
    accounts: accounts.map((account) => toPublicAccount(account, accountQuotaCache.get(account.id) ?? null)),
    usageTotals: accountStore.getUsageTotals(),
  })
})

app.get("/api/accounts/:id/refresh-token", (c) => {
  if (!hasSensitiveActionConfirmation(c)) {
    return c.json({ error: "Sensitive action confirmation required" }, 400)
  }
  const account = accountStore.get(c.req.param("id"))
  if (!account) return c.json({ error: "Account not found" }, 404)
  return c.json({
    refreshToken: account.refreshToken ?? "",
    hasRefreshToken: Boolean(account.refreshToken),
  })
})

app.post("/api/accounts/bulk-delete", async (c) => {
  try {
    const raw = await c.req.json()
    const input = BulkDeleteAccountsSchema.parse(raw)
    const uniqueIds = [
      ...new Set([...input.ids, ...input.accountIds].map((item) => String(item || "").trim()).filter(Boolean)),
    ]
    const skipped: Array<{ id: string; reason: string }> = []
    const deletableAccounts: StoredAccount[] = []

    for (const id of uniqueIds) {
      const account = accountStore.get(id)
      if (!account) {
        skipped.push({ id, reason: "account_not_found" })
        continue
      }
      const derived = resolvePublicAccountDerivedState(account.id, accountQuotaCache.get(account.id) ?? null)
      if (!derived.abnormalState?.deleteEligible) {
        skipped.push({ id, reason: derived.abnormalState?.reason || "not_delete_eligible" })
        continue
      }
      deletableAccounts.push(account)
    }

    const { deletedVirtualKeyCount } = deleteAccountsWithSingleRouteKeys(deletableAccounts)
    return c.json({
      requestedCount: uniqueIds.length,
      deletedAccountCount: deletableAccounts.length,
      deletedVirtualKeyCount,
      skipped,
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/accounts/api-key", async (c) => {
  try {
    const raw = await c.req.json()
    const input = AddApiKeyAccountSchema.parse(raw)
    const keyIdentity = buildApiKeyIdentity(input.apiKey)
    const keySuffix = input.apiKey.slice(-4)
    const displayName = input.displayName || `OpenAI API Key (${keySuffix})`
    const accountID = accountStore.saveBridgeOAuth({
      providerId: input.providerId,
      providerName: input.providerName,
      methodId: input.methodId,
      displayName,
      accountKey: keyIdentity,
      accessToken: input.apiKey,
      refreshToken: undefined,
      expiresAt: undefined,
      metadata: {
        source: "manual-api-key",
        organizationId: normalizeIdentity(input.organizationId),
        projectId: normalizeIdentity(input.projectId),
      },
    })
    invalidatePoolConsistency(input.providerId)
    return c.json({
      success: true,
      account: accountStore.get(accountID),
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/accounts/export-json", async (c) => {
  if (!hasSensitiveActionConfirmation(c)) {
    return c.json({ error: "Sensitive action confirmation required" }, 400)
  }
  try {
    const raw = await c.req.json().catch(() => ({}))
    const input = ExportAccountsSchema.parse(raw)
    const selectedIds = new Set((input.ids ?? []).map((item) => String(item).trim()).filter(Boolean))
    const accounts = accountStore
      .list()
      .filter((account) => account.providerId === "chatgpt" && account.methodId !== "api-key" && Boolean(account.accessToken))
      .filter((account) => selectedIds.size === 0 || selectedIds.has(account.id))

    const records = accounts.map((account) => exportStoredOAuthAccount(account))
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+$/, "")
      .replace("T", "_")

    return c.json({
      exportedCount: records.length,
      records,
      filename: `accounts_${stamp}.json`,
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/accounts/import-json", async (c) => {
  try {
    const raw = await c.req.json()
    const entries = Array.isArray(raw) ? raw : [raw]
    if (entries.length === 0) {
      return c.json({ error: "At least one JSON account record is required" }, 400)
    }
    if (entries.length > 500) {
      return c.json({ error: "Too many JSON account records (max 500)" }, 400)
    }
    const results: Array<{
      index: number
      success: boolean
      account?: ReturnType<typeof toPublicAccount> | null
      virtualKey?: { key: string; record: unknown }
      error?: string
    }> = []

    for (const [index, input] of entries.entries()) {
      try {
        const parsed = ImportJsonAccountSchema.parse(input)
        const imported = importJsonOAuthAccount(parsed)
        results.push({
          index,
          success: true,
          account: imported.account,
          virtualKey: imported.virtualKey,
        })
      } catch (error) {
        results.push({
          index,
          success: false,
          error: errorMessage(error),
        })
      }
    }

    const imported = results.filter((item) => item.success)
    const failed = results.length - imported.length
    const firstImported = imported[0]

    return c.json({
      success: failed === 0,
      importedCount: imported.length,
      failedCount: failed,
      account: firstImported?.account ?? null,
      virtualKey: firstImported?.virtualKey,
      results,
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.get("/api/virtual-keys", (c) => {
  const accountId = c.req.query("accountId")
  const keys = accountStore.listVirtualApiKeys(accountId)
  const accounts = accountStore.list()
  const accountMap = new Map(accounts.map((item) => [item.id, item]))
  const rows = keys.map((item) => {
    const account = item.accountId ? accountMap.get(item.accountId) : undefined
    return {
      ...item,
      account: account
        ? {
            id: account.id,
            providerId: account.providerId,
            providerName: account.providerName,
            displayName: account.displayName,
            email: account.email,
            accountId: account.accountId,
          }
        : null,
    }
  })

  return c.json({ keys: rows })
})

app.post("/api/virtual-keys/issue", async (c) => {
  try {
    const raw = await c.req.json()
    const input = IssueVirtualKeySchema.parse(raw)
    if (input.routingMode === "pool") {
      const cachedPoolConsistency = getCachedPoolConsistencyResult(input.providerId)
      if (cachedPoolConsistency && !cachedPoolConsistency.ok) {
        return c.json(
          {
            error: cachedPoolConsistency.message,
            code: cachedPoolConsistency.code,
            details: cachedPoolConsistency.details,
          },
          409,
        )
      }
    }
    const result = accountStore.createVirtualApiKey({
      accountId: input.accountId,
      providerId: input.providerId,
      routingMode: input.routingMode,
      name: input.name,
      validityDays: input.validityDays,
    })
    return c.json({
      key: result.key,
      record: result.record,
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/virtual-keys/:id/name", async (c) => {
  try {
    const raw = await c.req.json()
    const input = RenameVirtualKeySchema.parse(raw)
    const record = accountStore.renameVirtualApiKey(c.req.param("id"), input.name)
    return c.json({ success: true, record })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/virtual-keys/:id/renew", async (c) => {
  try {
    const raw = await c.req.json()
    const input = RenewVirtualKeySchema.parse(raw)
    const record = accountStore.renewVirtualApiKey(c.req.param("id"), input.validityDays)
    return c.json({ success: true, record })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/virtual-keys/:id/revoke", (c) => {
  try {
    accountStore.revokeVirtualApiKey(c.req.param("id"))
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/virtual-keys/:id/restore", (c) => {
  try {
    accountStore.restoreVirtualApiKey(c.req.param("id"))
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/virtual-keys/:id/reveal", (c) => {
  if (!hasSensitiveActionConfirmation(c)) {
    return c.json({ error: "Sensitive action confirmation required" }, 400)
  }
  try {
    const id = c.req.param("id")
    const key = accountStore.revealVirtualApiKey(id)
    if (!key) return c.json({ error: "Virtual API key not found" }, 404)
    if (String(key).startsWith("encv1:")) {
      return c.json({ error: "Virtual API key cannot be decrypted. Please renew or issue a new key." }, 409)
    }
    return c.json({ key })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.delete("/api/virtual-keys/:id", (c) => {
  try {
    accountStore.deleteVirtualApiKey(c.req.param("id"))
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/accounts/import-rt", async (c) => {
  try {
    const raw = await c.req.json()
    const entries = Array.isArray(raw) ? raw : [raw]
    if (entries.length === 0) {
      return c.json({ error: "At least one refresh-token account record is required" }, 400)
    }
    if (entries.length > 500) {
      return c.json({ error: "Too many refresh-token account records (max 500)" }, 400)
    }

    const results: Array<{
      index: number
      success: boolean
      account?: ReturnType<typeof toPublicAccount> | null
      virtualKey?: { key: string; record: unknown }
      refreshed?: boolean
      error?: string
    }> = []

    let importedCount = 0
    let failedCount = 0
    let refreshedCount = 0

    for (const [index, entry] of entries.entries()) {
      try {
        const parsed = ImportRtAccountSchema.parse(entry)
        const imported = await importRefreshTokenOAuthAccount(parsed)
        importedCount += 1
        if (imported.refreshed) refreshedCount += 1
        results.push({
          index,
          success: true,
          account: imported.account,
          virtualKey: imported.virtualKey,
          refreshed: imported.refreshed,
        })
      } catch (error) {
        failedCount += 1
        results.push({
          index,
          success: false,
          error: errorMessage(error),
        })
      }
    }

    return c.json({
      importedCount,
      failedCount,
      refreshedCount,
      results,
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/bridge/oauth/sync", async (c) => {
  try {
    const raw = await c.req.json()
    const input = SyncOAuthSchema.parse(raw)
    const accessTokenClaims = parseJwtAuthClaims(input.accessToken)
    const resolvedAccountId =
      normalizeIdentity(input.accountId) || normalizeIdentity(accessTokenClaims?.chatgpt_account_id)
    const resolvedOrganizationId =
      normalizeIdentity(input.organizationId) || normalizeIdentity(accessTokenClaims?.organization_id)
    const resolvedProjectId = normalizeIdentity(input.projectId) || normalizeIdentity(accessTokenClaims?.project_id)
    const resolvedChatgptPlanType =
      normalizeIdentity(input.chatgptPlanType) || normalizeIdentity(accessTokenClaims?.chatgpt_plan_type)
    const resolvedChatgptUserId =
      normalizeIdentity(input.chatgptUserId) ||
      normalizeIdentity(accessTokenClaims?.chatgpt_user_id) ||
      normalizeIdentity(accessTokenClaims?.user_id)
    const resolvedCompletedPlatformOnboarding =
      typeof input.completedPlatformOnboarding === "boolean"
        ? input.completedPlatformOnboarding
        : typeof accessTokenClaims?.completed_platform_onboarding === "boolean"
          ? accessTokenClaims.completed_platform_onboarding
          : undefined
    const resolvedIsOrgOwner =
      typeof input.isOrgOwner === "boolean"
        ? input.isOrgOwner
        : typeof accessTokenClaims?.is_org_owner === "boolean"
          ? accessTokenClaims.is_org_owner
          : undefined

    if (input.providerId === "chatgpt") {
      ensureForcedWorkspaceAllowed(resolvedAccountId)
    }
    const identity = buildOAuthIdentity({
      email: input.email,
      accountId: resolvedAccountId,
    })
    const displayName = input.displayName || input.email || resolvedAccountId || "Codex OAuth Account"
    const accountID = accountStore.saveBridgeOAuth({
      providerId: input.providerId,
      providerName: input.providerName,
      methodId: input.methodId,
      displayName,
      accountKey: identity,
      email: input.email,
      accountId: resolvedAccountId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      metadata: {
        source: "codex-oauth-sync",
        organizationId: resolvedOrganizationId,
        projectId: resolvedProjectId,
        chatgptPlanType: resolvedChatgptPlanType,
        chatgptUserId: resolvedChatgptUserId,
        completedPlatformOnboarding: resolvedCompletedPlatformOnboarding,
        isOrgOwner: resolvedIsOrgOwner,
      },
    })
    invalidatePoolConsistency(input.providerId)
    handleBackgroundPromise(
      "refreshAndEmitAccountQuota:bridge-oauth-sync",
      refreshAndEmitAccountQuota(accountID, "bridge-oauth-sync"),
    )
    const account = accountStore.get(accountID)
    let virtualKey: { key: string; record: unknown } | undefined
    if (input.issueVirtualKey) {
      const issued = accountStore.createVirtualApiKey({
        accountId: accountID,
        providerId: input.providerId,
        routingMode: "single",
        name: input.keyName || "Codex Bridge Key",
      })
      virtualKey = {
        key: issued.key,
        record: issued.record,
      }
    }
    return c.json({
      account,
      virtualKey,
      baseURL: `${new URL(c.req.url).origin}/v1`,
    })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/login/start", async (c) => {
  try {
    const raw = await c.req.json()
    const input = StartLoginSchema.parse(raw)
    const session = await loginSessions.start(input)
    return c.json({ session })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.get("/api/login/sessions/:id", async (c) => {
  const id = c.req.param("id")
  const session = loginSessions.get(id)
  if (!session) {
    return c.json({ error: "Login session not found" }, 404)
  }
  return c.json({ session })
})

app.post("/api/login/sessions/:id/code", async (c) => {
  const id = c.req.param("id")
  try {
    const raw = await c.req.json()
    const input = CodeSchema.parse(raw)
    const session = await loginSessions.submitCode(id, input.code)
    return c.json({ session })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/accounts/:id/activate", (c) => {
  try {
    accountStore.activate(c.req.param("id"))
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.post("/api/accounts/:id/refresh", async (c) => {
  const accountID = c.req.param("id")
  try {
    const account = accountStore.get(accountID)
    if (!account) return c.json({ error: "Account not found" }, 404)

    const provider = providers.getProvider(account.providerId)
    if (!provider?.refresh) {
      return c.json({ error: `Provider ${account.providerId} does not support refresh in this flow` }, 400)
    }

    const result = await provider.refresh(account)
    if (!result) {
      markAccountUnhealthy(accountID, "refresh_token_missing", "account-refresh")
      return c.json({ error: "No refresh token available for this account" }, 400)
    }

    accountStore.updateTokens({
      id: accountID,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      accountId: result.accountId ?? account.accountId,
    })
    markAccountHealthy(accountID, "account-refresh")
    invalidatePoolConsistency(account.providerId)
    handleBackgroundPromise(
      "refreshAndEmitAccountQuota:account-refresh",
      refreshAndEmitAccountQuota(accountID, "account-refresh"),
    )

    return c.json({
      success: true,
      account: accountStore.get(accountID),
    })
  } catch (error) {
    const blocked = detectRoutingBlockedAccount({
      error,
    })
    if (blocked.matched) {
      markAccountUnhealthy(accountID, blocked.reason, "account-refresh")
    }
    return c.json({ error: errorMessage(error) }, 400)
  }
})

app.delete("/api/accounts/:id", (c) => {
  const accountID = c.req.param("id")
  const account = accountStore.get(accountID)
  if (account) {
    const { deletedVirtualKeyCount } = deleteAccountsWithSingleRouteKeys([account])
    return c.json({ success: true, deletedVirtualKeyCount })
  }
  accountStore.delete(accountID)
  accountQuotaCache.delete(accountID)
  accountHealthCache.delete(accountID)
  evictAccountModelsCache(accountID)
  return c.json({ success: true, deletedVirtualKeyCount: 0 })
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
  let outgoingBody: Uint8Array | undefined = undefined
  let behaviorRelease: (() => void) | null = null
  let auditRoutingMode = "single"

  try {
    const bearer = extractBearerToken(c.req.header("authorization"))
    if (!bearer) {
      accountStore.addRequestAudit({
        route,
        method,
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: "Missing Authorization Bearer token",
        clientTag,
      })
      return c.json({ error: "Missing Authorization Bearer token" }, 401)
    }

    const outgoingBytes = await c.req.arrayBuffer()
    outgoingBody = outgoingBytes.byteLength > 0 ? new Uint8Array(outgoingBytes) : undefined
    const auditFields = parseAuditRequestFields({
      body: outgoingBody ?? new Uint8Array(0),
      contentType: c.req.header("content-type"),
    })
    auditModel = auditFields.model
    const sessionRouteId = resolveSessionRouteID({
      headers: c.req.raw.headers,
      requestUrl: c.req.url,
      bodySessionId: auditFields.sessionId,
    })
    auditSessionId = sessionRouteId ?? null

    const resolved = resolveVirtualApiKeyWithPoolFallback(bearer, sessionRouteId)
    if (!resolved) {
      accountStore.addRequestAudit({
        route,
        method,
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: "Invalid, revoked, or expired virtual API key",
        clientTag,
      })
      return c.json({ error: "Invalid, revoked, or expired virtual API key" }, 401)
    }

    const eligibleResolved = ensureResolvedPoolAccountEligible({
      resolved,
      sessionId: sessionRouteId,
    })
    if (!eligibleResolved) {
      accountStore.addRequestAudit({
        route,
        method,
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
      if (consistentResolved.type === "consistency") {
        accountStore.addRequestAudit({
          route,
          method,
          providerId: auditProviderId,
          accountId: auditAccountId,
          virtualKeyId: auditKeyId,
          model: auditModel,
          sessionId: auditSessionId,
          requestBytes: outgoingBody?.byteLength ?? 0,
          requestBody: outgoingBody,
          statusCode: 409,
          latencyMs: Date.now() - startedAt,
          error: `${consistentResolved.poolConsistency.code}: ${consistentResolved.poolConsistency.message}`,
          clientTag,
        })
        return toPoolConsistencyErrorResponse(consistentResolved.poolConsistency)
      }
      accountStore.addRequestAudit({
        route,
        method,
        virtualKeyId: eligibleResolved.key.id,
        providerId: eligibleResolved.key.providerId,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }

    const key = consistentResolved.resolved.key
    auditRoutingMode = key.routingMode
    let account = consistentResolved.resolved.account
    let profile = resolveUpstreamProfileForAccount(account)
    auditKeyId = key.id
    auditAccountId = account.id
    auditProviderId = account.providerId

    const behaviorDecision = await behaviorController.acquire({
      accountId: account.id,
      signal: behaviorSignal,
    })
    if (!behaviorDecision.ok) {
      const retryAfterSeconds = behaviorDecision.retryAfterMs ? Math.max(1, Math.ceil(behaviorDecision.retryAfterMs / 1000)) : undefined
      accountStore.addRequestAudit({
        route,
        method,
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

    const buildHeadersForCurrentAccount = (auth: { accessToken: string; accountId?: string }) => {
      const openAIHeaders = profile.providerMode === "openai" ? resolveAccountOpenAIHeaders(account) : null
      return buildUpstreamForwardHeaders({
        incoming: c.req.raw.headers,
        accessToken: auth.accessToken,
        accountId: auth.accountId,
        boundAccountId: account.id,
        attachChatgptAccountId: profile.attachChatgptAccountId,
        organizationId: openAIHeaders?.organizationId,
        projectId: openAIHeaders?.projectId,
      })
    }

    const rerouteTriedAccounts = new Set<string>()
    const buildPoolUnavailableResponse = () => {
      const normalizedFailure = buildUpstreamAccountUnavailableFailure({
        routingMode: key.routingMode,
      })
      accountStore.addRequestAudit({
        route,
        method,
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
      const routingHints = buildProviderRoutingHints(key.providerId)
      const excluded = new Set<string>([...routingHints.excludeAccountIds, ...rerouteTriedAccounts])

      let reRoutedAccount = sessionRouteId
        ? accountStore.reassignVirtualKeySessionRoute({
            keyId: key.id,
            providerId: key.providerId,
            sessionId: sessionRouteId,
            failedAccountId,
            excludeAccountIds: [...excluded],
            deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
            headroomByAccountId: routingHints.headroomByAccountId,
          })
        : accountStore.reassignVirtualKeyRoute({
            keyId: key.id,
            providerId: key.providerId,
            failedAccountId,
            excludeAccountIds: [...excluded],
            deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
            headroomByAccountId: routingHints.headroomByAccountId,
          })

      if (!reRoutedAccount) {
        const relaxedHints = buildRelaxedProviderRoutingHints(key.providerId)
        const relaxedExcluded = new Set<string>([...relaxedHints.excludeAccountIds, ...rerouteTriedAccounts])
        reRoutedAccount = sessionRouteId
          ? accountStore.reassignVirtualKeySessionRoute({
              keyId: key.id,
              providerId: key.providerId,
              sessionId: sessionRouteId,
              failedAccountId,
              excludeAccountIds: [...relaxedExcluded],
              deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
              headroomByAccountId: relaxedHints.headroomByAccountId,
            })
          : accountStore.reassignVirtualKeyRoute({
              keyId: key.id,
              providerId: key.providerId,
              failedAccountId,
              excludeAccountIds: [...relaxedExcluded],
              deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
              headroomByAccountId: relaxedHints.headroomByAccountId,
            })
      }

      if (!reRoutedAccount || rerouteTriedAccounts.has(reRoutedAccount.id)) {
        return null
      }
      return reRoutedAccount
    }

    let auth: { accessToken: string; accountId?: string } = { accessToken: "" }
    let headers = new Headers()
    let upstreamRequestBody: Uint8Array | undefined
    if (outgoingBody) {
      const bodyCopy = new Uint8Array(outgoingBody.byteLength)
      bodyCopy.set(outgoingBody)
      upstreamRequestBody = bodyCopy
    }
    const bodySanitized = sanitizeUpstreamJsonBody({
      body: upstreamRequestBody,
      contentType: c.req.header("content-type"),
      strictPrivacy: isStrictUpstreamPrivacyEnabled(),
      accountId: account.id,
    })
    upstreamRequestBody = bodySanitized.body
    if (bodySanitized.strippedFields.length > 0) {
      console.log(
        `[oauth-multi-login] strict-privacy sanitized request fields route=${route} key=${auditKeyId ?? "-"} fields=${bodySanitized.strippedFields.join(",")}`,
      )
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
          policyOverride: key.routingMode === "pool" ? { retry5xx: false, retryTransport: false } : undefined,
        })
      ).response

    const attemptUpstreamForCurrentAccount = async () => {
      auth = await resolveUpstreamAccountAuth(account)
      headers = buildHeadersForCurrentAccount(auth)
      let currentUpstream = await runUpstreamRequest(headers)

      if (currentUpstream.status === 401 && profile.canRefreshOn401) {
        const latest = accountStore.get(account.id) ?? account
        auth = await resolveUpstreamAccountAuth(latest, { forceRefresh: true })
        headers = buildHeadersForCurrentAccount(auth)
        currentUpstream = await runUpstreamRequest(headers)
      }

      return currentUpstream
    }

    let upstream: Response
    while (true) {
      try {
        upstream = await attemptUpstreamForCurrentAccount()
        break
      } catch (error) {
        const blocked = detectRoutingBlockedAccount({
          error,
        })
        const transient = detectTransientUpstreamError(error)
        if (!(key.routingMode === "pool" && (blocked.matched || transient.matched))) {
          throw error
        }

        const failedAccountId = account.id
        rerouteTriedAccounts.add(failedAccountId)
        if (blocked.matched) {
          markAccountUnhealthy(failedAccountId, blocked.reason, "responses")
          evictAccountModelsCache(failedAccountId)
        } else {
          markAccountUnhealthy(failedAccountId, transient.reason ?? "upstream_transport_error", "responses")
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
          reason: blocked.reason ?? transient.reason ?? "routing_excluded",
        })
      }
    }

    if (key.routingMode === "pool") {
      while (true) {
        const blockedSignal = await detectRoutingBlockedUpstreamResponse(upstream)
        const quotaSignal = await detectQuotaExhaustedUpstreamResponse(upstream)
        const transientSignal = await detectTransientUpstreamResponse(upstream)
        if (!blockedSignal.matched && !quotaSignal.matched && !transientSignal.matched) break

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
        } else {
          markAccountUnhealthy(failedAccountId, transientSignal.reason ?? "upstream_http_502", "responses")
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

          auth = await resolveUpstreamAccountAuth(account)
          headers = buildHeadersForCurrentAccount(auth)
          let reRoutedResponse = await runUpstreamRequest(headers)
          if (reRoutedResponse.status === 401 && profile.canRefreshOn401) {
            const latest = accountStore.get(account.id) ?? account
            auth = await resolveUpstreamAccountAuth(latest, { forceRefresh: true })
            headers = buildHeadersForCurrentAccount(auth)
            reRoutedResponse = await runUpstreamRequest(headers)
          }
          upstream = reRoutedResponse
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
            markAccountUnhealthy(reRoutedAccount.id, reroutedTransient.reason, "responses")
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
      upstream.headers.get("x-request-id") || upstream.headers.get("openai-request-id") || upstream.headers.get("cf-ray") || null

    if (!upstream.ok) {
      const responseBuffer = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
      const normalizedFailure = await normalizeCodexFailureResponse({
        status: upstream.status,
        headers: upstream.headers,
        bodyBytes: new Uint8Array(responseBuffer),
        routingMode: key.routingMode,
      })
      accountStore.addRequestAudit({
        route,
        method,
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
        clientTag,
      })
      return new Response(normalizedFailure.bodyText, {
        status: normalizedFailure.status,
        headers: normalizedFailure.headers,
      })
    }

    const responseHeaders = new Headers(upstream.headers)

    if (!upstream.body) {
      const text = await upstream.text().catch(() => "")
      const responseBytes = new TextEncoder().encode(text).byteLength
      try {
        const usage = (await extractUsageFromStructuredResponseText(text)).usage
        if (hasUsageDelta(usage)) {
          accountStore.addUsage({
            id: account.id,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          })
          accountStore.addVirtualKeyUsage({
            id: key.id,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          })
          emitUsageUpdated({
            accountId: account.id,
            keyId: key.id,
            usage,
            source: "proxy-single",
          })
        }
      } catch {
        // ignore usage parse errors
      }
      accountStore.addRequestAudit({
        route,
        method,
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
      })
      return new Response(text, {
        status: upstream.status,
        headers: responseHeaders,
      })
    }

    const [clientStream, usageStream] = upstream.body.tee()
    if (isEventStreamContentType(upstream.headers.get("content-type"))) {
      handleBackgroundPromise(
        "trackUsageFromStream:responses",
        trackUsageFromStream({
          accountId: account.id,
          keyId: key.id,
          stream: usageStream,
        }),
      )
    } else {
      handleBackgroundPromise(
        "trackUsageFromJsonStream:responses",
        trackUsageFromJsonStream({
          accountId: account.id,
          keyId: key.id,
          stream: usageStream,
        }),
      )
    }

    accountStore.addRequestAudit({
      route,
      method,
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
      accountStore.addRequestAudit({
        route,
        method,
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
    accountStore.addRequestAudit({
      route,
      method,
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
    behaviorRelease?.()
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
  let behaviorRelease: (() => void) | null = null
  let auditRoutingMode = "single"

  try {
    const bearer = extractBearerToken(c.req.header("authorization"))
    if (!bearer) {
      accountStore.addRequestAudit({
        route,
        method,
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
    const resolved = resolveVirtualApiKeyWithPoolFallback(bearer, sessionRouteId)
    if (!resolved) {
      accountStore.addRequestAudit({
        route,
        method,
        statusCode: 401,
        latencyMs: Date.now() - startedAt,
        error: "Invalid, revoked, or expired virtual API key",
        clientTag,
      })
      return c.json({ error: "Invalid, revoked, or expired virtual API key" }, 401)
    }

    const eligibleResolved = ensureResolvedPoolAccountEligible({
      resolved,
      sessionId: sessionRouteId,
    })
    if (!eligibleResolved) {
      accountStore.addRequestAudit({
        route,
        method,
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
      if (consistentResolved.type === "consistency") {
        accountStore.addRequestAudit({
          route,
          method,
          providerId: auditProviderId,
          accountId: auditAccountId,
          virtualKeyId: auditKeyId,
          sessionId: sessionRouteId ?? null,
          statusCode: 409,
          latencyMs: Date.now() - startedAt,
          error: `${consistentResolved.poolConsistency.code}: ${consistentResolved.poolConsistency.message}`,
          clientTag,
        })
        return toPoolConsistencyErrorResponse(consistentResolved.poolConsistency)
      }
      accountStore.addRequestAudit({
        route,
        method,
        virtualKeyId: eligibleResolved.key.id,
        providerId: eligibleResolved.key.providerId,
        statusCode: 503,
        latencyMs: Date.now() - startedAt,
        error: "No healthy accounts available for pool routing",
        clientTag,
      })
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }

    const key = consistentResolved.resolved.key
    auditRoutingMode = key.routingMode
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
      accountStore.addRequestAudit({
        route,
        method,
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
      accountStore.addRequestAudit({
        route,
        method,
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

    const openAIHeaders = profile.providerMode === "openai" ? resolveAccountOpenAIHeaders(account) : null
    const headers = buildUpstreamForwardHeaders({
      incoming: c.req.raw.headers,
      accessToken,
      accountId,
      boundAccountId: account.id,
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

    const responseHeaders = new Headers(upstream.headers)
    const upstreamRequestId =
      upstream.headers.get("x-request-id") || upstream.headers.get("openai-request-id") || upstream.headers.get("cf-ray") || null
    const responseBuffer = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
    const responseBytes = responseBuffer.byteLength

    accountStore.addRequestAudit({
      route,
      method,
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
      accountStore.addRequestAudit({
        route,
        method,
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
    accountStore.addRequestAudit({
      route,
      method,
      providerId: auditProviderId,
      accountId: auditAccountId,
      virtualKeyId: auditKeyId,
      statusCode: finalStatus,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
      clientTag,
    })
    return c.json({ error: errorMessage(error) }, finalStatus)
  } finally {
    behaviorRelease?.()
  }
}

app.get("/wham/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.get("/api/codex/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.get("/backend-api/wham/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.get("/backend-api/codex/usage", (c) => proxyVirtualKeyRateLimitUsage(c))
app.post("/v1/responses", (c) => proxyVirtualKeyCodexRequest(c, "/responses"))
app.post("/v1/responses/compact", (c) => proxyVirtualKeyCodexRequest(c, "/responses/compact"))

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
    })
    return c.json(output)
  } catch (error) {
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

    const keySecret = accountStore.revealVirtualApiKey(input.keyId)
    if (!keySecret) {
      return c.json({ error: "Virtual API key secret not found" }, 404)
    }
    if (String(keySecret).startsWith("encv1:")) {
      return c.json({ error: "Virtual API key cannot be decrypted. Please renew or issue a new key." }, 409)
    }

    const resolved = resolveVirtualApiKeyWithPoolFallback(keySecret, input.sessionId)
    if (!resolved) {
      return c.json({ error: "Invalid, revoked, or expired virtual API key" }, 401)
    }
    const eligibleResolved = ensureResolvedPoolAccountEligible({
      resolved,
      sessionId: input.sessionId,
    })
    if (!eligibleResolved) {
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }
    const consistentResolved = await ensureResolvedPoolAccountConsistent({
      resolved: eligibleResolved,
      sessionId: input.sessionId,
    })
    if (!consistentResolved.ok) {
      if (consistentResolved.type === "consistency") {
        return c.json(
          {
            error: consistentResolved.poolConsistency.message,
            code: consistentResolved.poolConsistency.code,
            details: consistentResolved.poolConsistency.details,
          },
          409,
        )
      }
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }

    let activeAccount = consistentResolved.resolved.account
    const rerouteTriedAccounts = new Set<string>()
    while (true) {
      try {
        const output = await runChatWithAccount({
          account: activeAccount,
          model: input.model,
          message: input.message,
          sessionId: input.sessionId,
          historyNamespace: `key:${input.keyId}`,
          keyId: input.keyId,
        })

        return c.json({
          ...output,
          key: accountStore.getVirtualApiKeyByID(input.keyId),
          routedAccountId: activeAccount.id,
        })
      } catch (error) {
        if (eligibleResolved.key.routingMode !== "pool") {
          throw error
        }

        const quotaSignal = await detectQuotaExhaustedChatError(error)
        const blockedSignal = detectRoutingBlockedChatError(error)
        const transientSignal = detectTransientUpstreamError(error)
        if (!quotaSignal.matched && !blockedSignal.matched && !transientSignal.matched) {
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
        } else {
          markAccountUnhealthy(failedAccountId, transientSignal.reason ?? "upstream_http_502", "chat")
        }

        const routingHints = buildProviderRoutingHints(eligibleResolved.key.providerId)
        const excluded = new Set<string>([...routingHints.excludeAccountIds, ...rerouteTriedAccounts])

        let reRoutedAccount = input.sessionId
          ? accountStore.reassignVirtualKeySessionRoute({
              keyId: eligibleResolved.key.id,
              providerId: eligibleResolved.key.providerId,
              sessionId: input.sessionId,
              failedAccountId,
              excludeAccountIds: [...excluded],
              deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
              headroomByAccountId: routingHints.headroomByAccountId,
            })
          : accountStore.reassignVirtualKeyRoute({
              keyId: eligibleResolved.key.id,
              providerId: eligibleResolved.key.providerId,
              failedAccountId,
              excludeAccountIds: [...excluded],
              deprioritizedAccountIds: routingHints.deprioritizedAccountIds,
              headroomByAccountId: routingHints.headroomByAccountId,
            })

        if (!reRoutedAccount) {
          const relaxedHints = buildRelaxedProviderRoutingHints(eligibleResolved.key.providerId)
          const relaxedExcluded = new Set<string>([...relaxedHints.excludeAccountIds, ...rerouteTriedAccounts])
          reRoutedAccount = input.sessionId
            ? accountStore.reassignVirtualKeySessionRoute({
                keyId: eligibleResolved.key.id,
                providerId: eligibleResolved.key.providerId,
                sessionId: input.sessionId,
                failedAccountId,
                excludeAccountIds: [...relaxedExcluded],
                deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
                headroomByAccountId: relaxedHints.headroomByAccountId,
              })
            : accountStore.reassignVirtualKeyRoute({
                keyId: eligibleResolved.key.id,
                providerId: eligibleResolved.key.providerId,
                failedAccountId,
                excludeAccountIds: [...relaxedExcluded],
                deprioritizedAccountIds: relaxedHints.deprioritizedAccountIds,
                headroomByAccountId: relaxedHints.headroomByAccountId,
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
          reason: blockedSignal.reason ?? quotaSignal.reason ?? transientSignal.reason ?? "routing_excluded",
        })

        activeAccount = reRoutedAccount
      }
    }
  } catch (error) {
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
