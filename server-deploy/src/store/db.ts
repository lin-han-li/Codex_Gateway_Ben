import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import type { LoginResult, StoredAccount } from "../types"
import { resolveAccountPlanCohort } from "../domain/accounts/quota"
import { isSecretEncryptionEnabled, openSecret, sealSecret } from "../security/secrets"
import {
  CREATE_REQUEST_AUDITS_TABLE_SQL,
  CREATE_REQUEST_TOKEN_STATS_TABLE_SQL,
  REBUILD_REQUEST_TOKEN_STATS_FROM_AUDITS_SQL,
  REQUEST_AUDIT_BILLABLE_TOKENS_SQL,
  REQUEST_AUDIT_ERROR_SQL,
  REQUEST_AUDIT_INDEX_SQL,
  REQUEST_AUDIT_SUCCESS_SQL,
  REQUEST_AUDIT_TOTAL_TOKENS_SQL,
  REQUEST_TOKEN_STATS_INDEX_SQL,
} from "./request-audit-schema"

type AccountRow = {
  id: string
  provider_id: string
  provider_name: string
  method_id: string
  display_name: string
  account_key: string
  email: string | null
  account_id: string | null
  enterprise_url: string
  access_token: string
  refresh_token: string | null
  id_token: string | null
  expires_at: number | null
  is_active: number
  metadata_json: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  created_at: number
  updated_at: number
}

type SaveAccountInput = LoginResult & { providerName: string }

export type VirtualKeyRoutingMode = "single" | "pool"
export type VirtualKeyClientMode = "codex" | "cursor"
export type VirtualKeyWireAPI = "responses" | "chat_completions"
export type VirtualKeyAccountScope = "all" | "member" | "free"

export type VirtualApiKeyRecord = {
  id: string
  accountId: string | null
  providerId: string
  routingMode: VirtualKeyRoutingMode
  accountScope: VirtualKeyAccountScope
  clientMode: VirtualKeyClientMode
  wireApi: VirtualKeyWireAPI
  name: string | null
  fixedModel: string | null
  fixedReasoningEffort: string | null
  keyPrefix: string
  isRevoked: boolean
  promptTokens: number
  completionTokens: number
  totalTokens: number
  expiresAt: number | null
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export type RequestAuditRecord = {
  id: string
  at: number
  route: string
  method: string
  providerId: string | null
  accountId: string | null
  virtualKeyId: string | null
  model: string | null
  sessionId: string | null
  requestHash: string
  requestBytes: number
  responseBytes: number
  statusCode: number
  latencyMs: number
  upstreamRequestId: string | null
  error: string | null
  clientTag: string | null
  clientMode: VirtualKeyClientMode | null
  wireApi: VirtualKeyWireAPI | null
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  billableTokens: number | null
  reasoningOutputTokens: number | null
  estimatedCostUsd: number | null
  reasoningEffort: string | null
}

export type RequestAuditListParams = {
  query?: string | null
  statusFilter?: string | null
  page?: number
  pageSize?: number
}

export type RequestAuditListResult = {
  items: RequestAuditRecord[]
  total: number
  page: number
  pageSize: number
}

export type RequestAuditFilterSummary = {
  totalCount: number
  filteredCount: number
  successCount: number
  errorCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  billableTokens: number
  pricedTokens: number
  reasoningOutputTokens: number
  estimatedCostUsd: number
  unpricedRequestCount: number
}

export type RequestTokenStatsDayRecord = {
  dayKey: string
  requestCount: number
  successCount: number
  errorCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  billableTokens: number
  pricedTokens: number
  reasoningOutputTokens: number
  estimatedCostUsd: number
  unpricedRequestCount: number
  updatedAt: number
}

export type RequestTokenStatsDaySummary = {
  stats: RequestTokenStatsDayRecord | null
  unpricedRequestCount: number
}

type VirtualApiKeyRow = {
  id: string
  account_id: string | null
  account_scope: string | null
  client_mode: string | null
  wire_api: string | null
  name: string | null
  fixed_model: string | null
  fixed_reasoning_effort: string | null
  key_hash: string
  key_secret: string | null
  key_prefix: string
  provider_id: string
  routing_mode: string
  is_revoked: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  expires_at: number | null
  last_used_at: number | null
  created_at: number
  updated_at: number
}

type RequestAuditRow = {
  id: string
  at: number
  route: string
  method: string
  provider_id: string | null
  account_id: string | null
  virtual_key_id: string | null
  model: string | null
  session_id: string | null
  request_hash: string
  request_bytes: number
  response_bytes: number
  status_code: number
  latency_ms: number
  upstream_request_id: string | null
  error_text: string | null
  client_tag: string | null
  client_mode: string | null
  wire_api: string | null
  input_tokens: number | null
  cached_input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  billable_tokens: number | null
  reasoning_output_tokens: number | null
  estimated_cost_usd: number | null
  reasoning_effort: string | null
}

type RequestAuditCostBackfillCandidate = {
  id: string
  at: number
  model: string | null
  input_tokens: number | null
  cached_input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
}

type RequestTokenStatsDayRow = {
  day_key: string
  request_count: number
  success_count: number
  error_count: number
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  total_tokens: number
  billable_tokens: number
  priced_tokens: number
  reasoning_output_tokens: number
  estimated_cost_usd: number
  unpriced_request_count: number
  updated_at: number
}

type VirtualKeyRouteRow = {
  account_id: string
  request_count: number
  last_used_at: number | null
}

type VirtualKeySessionRow = {
  key_id: string
  session_id: string
  account_id: string
  request_count: number
  last_used_at: number | null
  updated_at?: number | null
}

const VIRTUAL_KEY_SESSION_IDLE_TTL_MS = 45 * 60 * 1000
const VIRTUAL_KEY_SESSION_CLEANUP_INTERVAL_MS = 60 * 1000

type TableInfoRow = {
  name: string
  notnull: number
}

type GlobalUsageTotalsRow = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cached_input_tokens: number
  reasoning_output_tokens: number
  priced_tokens: number
  estimated_cost_usd: number
  updated_at: number
}

export type UsageTotals = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  pricedTokens: number
  estimatedCostUsd: number
  updatedAt: number
}

const ROUTING_DEBUG_ENABLED = String(process.env.OAUTH_DEBUG_ROUTING ?? "0").trim() === "1"

function safeJson(input: string) {
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return {}
  }
}

function toStoredAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    methodId: row.method_id,
    displayName: row.display_name,
    accountKey: row.account_key,
    email: row.email,
    accountId: row.account_id,
    enterpriseUrl: row.enterprise_url || null,
    accessToken: openSecret(row.access_token) ?? "",
    refreshToken: openSecret(row.refresh_token),
    idToken: openSecret(row.id_token),
    expiresAt: row.expires_at,
    isActive: row.is_active === 1,
    metadata: safeJson(row.metadata_json),
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toVirtualApiKeyRecord(row: VirtualApiKeyRow): VirtualApiKeyRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    providerId: row.provider_id,
    routingMode: row.routing_mode === "pool" ? "pool" : "single",
    accountScope: normalizeVirtualKeyAccountScope(row.account_scope),
    clientMode: row.client_mode === "cursor" ? "cursor" : "codex",
    wireApi: row.wire_api === "chat_completions" ? "chat_completions" : "responses",
    name: row.name,
    fixedModel: row.fixed_model ?? null,
    fixedReasoningEffort: row.fixed_reasoning_effort ?? null,
    keyPrefix: row.key_prefix,
    isRevoked: row.is_revoked === 1,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hashVirtualApiKey(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function hashRequestPayload(input: Uint8Array) {
  return createHash("sha256").update(input).digest("hex")
}

function generateVirtualApiKeySecret() {
  const token = randomBytes(32).toString("base64url")
  return `ocsk_live_${token}`
}

function normalizeSessionRouteID(value?: string | null) {
  const normalized = String(value ?? "").trim()
  if (!normalized) return undefined
  return normalized.slice(0, 240)
}

function normalizeVirtualKeyOverrideValue(value?: string | null) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!normalized) return null
  return normalized.slice(0, 120)
}

function normalizeVirtualKeyAccountScope(value: unknown): VirtualKeyAccountScope {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized === "free") return "free"
  if (normalized === "member" || normalized === "paid" || normalized === "paid_member") return "member"
  return "all"
}

function virtualKeyScopeMatchesAccount(account: StoredAccount, accountScope: VirtualKeyAccountScope) {
  if (accountScope === "all") return true
  const cohort = resolveAccountPlanCohort(account)
  if (accountScope === "free") return cohort === "free"
  return cohort === "paid" || cohort === "business"
}

function normalizeVirtualKeyDisplayName(value?: string | null) {
  const normalized = String(value ?? "").trim()
  if (!normalized) return null
  return normalized.slice(0, 120)
}

function buildVirtualKeyDefaultName(input: {
  name?: string | null
  clientMode?: VirtualKeyClientMode | null
  fixedModel?: string | null
  fixedReasoningEffort?: string | null
  accountScope?: VirtualKeyAccountScope | null
}) {
  const explicitName = normalizeVirtualKeyDisplayName(input.name)
  if (explicitName) return explicitName
  const scopeLabel = input.accountScope === "free" ? "Free" : input.accountScope === "member" ? "Member" : null
  const fixedModel = normalizeVirtualKeyOverrideValue(input.fixedModel)
  const fixedReasoningEffort = normalizeVirtualKeyOverrideValue(input.fixedReasoningEffort)
  const clientLabel = input.clientMode === "cursor" ? "Cursor" : "Codex"
  if (!fixedModel && !fixedReasoningEffort) {
    return scopeLabel ? normalizeVirtualKeyDisplayName(`${clientLabel} ${scopeLabel} key`) : null
  }
  const suffix = [fixedModel, fixedReasoningEffort].filter(Boolean).join(" ")
  return normalizeVirtualKeyDisplayName(`${clientLabel}${scopeLabel ? ` ${scopeLabel}` : ""} fixed ${suffix}`)
}

type RequestAuditSqlFilters = {
  whereClause: string
  params: Array<string | number>
}

function normalizeNonNegativeInteger(value: number | null | undefined) {
  if (value == null) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor(parsed))
}

function normalizeNonNegativeNumber(value: number | null | undefined) {
  if (value == null) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, parsed)
}

function normalizeAuditTimestamp(value: number | null | undefined) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now()
  return Math.max(0, Math.floor(parsed))
}

function resolveAuditTotalTokens(
  explicitTotalTokens: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
) {
  if (explicitTotalTokens !== null) return explicitTotalTokens
  if (inputTokens === null && outputTokens === null) return null
  return Math.max(0, (inputTokens ?? 0) + (outputTokens ?? 0))
}

function resolveAuditBillableTokens(
  explicitBillableTokens: number | null,
  inputTokens: number | null,
  cachedInputTokens: number | null,
  outputTokens: number | null,
) {
  if (explicitBillableTokens !== null) return explicitBillableTokens
  if (inputTokens === null && cachedInputTokens === null && outputTokens === null) return null
  return Math.max(0, (inputTokens ?? 0) - (cachedInputTokens ?? 0)) + Math.max(0, outputTokens ?? 0)
}

function toLocalDayKey(timestampMs: number) {
  const date = new Date(timestampMs)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function toLocalDayBounds(timestampMs: number) {
  const start = new Date(timestampMs)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1)
  return {
    startAt: start.getTime(),
    endAt: end.getTime(),
  }
}

function normalizeAuditPage(value: number | null | undefined, fallback: number) {
  const parsed = normalizeNonNegativeInteger(value)
  if (parsed === null || parsed < 1) return fallback
  return parsed
}

function normalizeAuditPageSize(value: number | null | undefined, fallback: number) {
  const parsed = normalizeNonNegativeInteger(value)
  if (parsed === null || parsed < 1) return fallback
  return Math.min(1000, parsed)
}

function buildRequestAuditFilters(query?: string | null, statusFilter?: string | null): RequestAuditSqlFilters {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const terms = String(query ?? "")
    .trim()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8)

  for (const term of terms) {
    const pattern = `%${term}%`
    clauses.push(`(
      route LIKE ?
      OR method LIKE ?
      OR IFNULL(provider_id, '') LIKE ?
      OR IFNULL(account_id, '') LIKE ?
      OR IFNULL(virtual_key_id, '') LIKE ?
      OR IFNULL(model, '') LIKE ?
      OR IFNULL(session_id, '') LIKE ?
      OR IFNULL(request_hash, '') LIKE ?
      OR IFNULL(upstream_request_id, '') LIKE ?
      OR IFNULL(error_text, '') LIKE ?
      OR IFNULL(client_tag, '') LIKE ?
      OR IFNULL(CAST(status_code AS TEXT), '') LIKE ?
      OR IFNULL(CAST(input_tokens AS TEXT), '') LIKE ?
      OR IFNULL(CAST(cached_input_tokens AS TEXT), '') LIKE ?
      OR IFNULL(CAST(output_tokens AS TEXT), '') LIKE ?
      OR IFNULL(CAST(total_tokens AS TEXT), '') LIKE ?
      OR IFNULL(CAST(billable_tokens AS TEXT), '') LIKE ?
      OR IFNULL(CAST(reasoning_output_tokens AS TEXT), '') LIKE ?
      OR IFNULL(CAST(estimated_cost_usd AS TEXT), '') LIKE ?
      OR IFNULL(reasoning_effort, '') LIKE ?
    )`)
    for (let index = 0; index < 20; index += 1) {
      params.push(pattern)
    }
  }

  switch (String(statusFilter ?? "").trim().toLowerCase()) {
    case "":
    case "all":
      break
    case "success":
    case "2xx":
      clauses.push("status_code >= ? AND status_code <= ?")
      params.push(200, 299)
      break
    case "4xx":
      clauses.push("status_code >= ? AND status_code <= ?")
      params.push(400, 499)
      break
    case "5xx":
      clauses.push("status_code >= ?")
      params.push(500)
      break
    case "error":
      clauses.push("(status_code >= ? OR TRIM(IFNULL(error_text, '')) <> '')")
      params.push(400)
      break
    default:
      break
  }

  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  }
}

function mapRequestAuditRow(row: RequestAuditRow): RequestAuditRecord {
  return {
    id: row.id,
    at: row.at,
    route: row.route,
    method: row.method,
    providerId: row.provider_id,
    accountId: row.account_id,
    virtualKeyId: row.virtual_key_id,
    model: row.model,
    sessionId: row.session_id,
    requestHash: row.request_hash,
    requestBytes: row.request_bytes ?? 0,
    responseBytes: row.response_bytes ?? 0,
    statusCode: row.status_code ?? 0,
    latencyMs: row.latency_ms ?? 0,
    upstreamRequestId: row.upstream_request_id,
    error: row.error_text,
    clientTag: row.client_tag,
    clientMode: row.client_mode === "cursor" ? "cursor" : row.client_mode === "codex" ? "codex" : null,
    wireApi:
      row.wire_api === "chat_completions"
        ? "chat_completions"
        : row.wire_api === "responses"
          ? "responses"
          : null,
    inputTokens: row.input_tokens ?? null,
    cachedInputTokens: row.cached_input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    totalTokens: row.total_tokens ?? null,
    billableTokens: row.billable_tokens ?? null,
    reasoningOutputTokens: row.reasoning_output_tokens ?? null,
    estimatedCostUsd: row.estimated_cost_usd ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
  }
}

function mapRequestTokenStatsDayRow(row?: RequestTokenStatsDayRow | null): RequestTokenStatsDayRecord | null {
  if (!row) return null
  return {
    dayKey: row.day_key,
    requestCount: Math.max(0, Math.floor(Number(row.request_count ?? 0))),
    successCount: Math.max(0, Math.floor(Number(row.success_count ?? 0))),
    errorCount: Math.max(0, Math.floor(Number(row.error_count ?? 0))),
    inputTokens: Math.max(0, Math.floor(Number(row.input_tokens ?? 0))),
    cachedInputTokens: Math.max(0, Math.floor(Number(row.cached_input_tokens ?? 0))),
    outputTokens: Math.max(0, Math.floor(Number(row.output_tokens ?? 0))),
    totalTokens: Math.max(0, Math.floor(Number(row.total_tokens ?? 0))),
    billableTokens: Math.max(0, Math.floor(Number(row.billable_tokens ?? 0))),
    pricedTokens: Math.max(0, Math.floor(Number(row.priced_tokens ?? 0))),
    reasoningOutputTokens: Math.max(0, Math.floor(Number(row.reasoning_output_tokens ?? 0))),
    estimatedCostUsd: Math.max(0, Number(row.estimated_cost_usd ?? 0)),
    unpricedRequestCount: Math.max(0, Math.floor(Number(row.unpriced_request_count ?? 0))),
    updatedAt: Math.max(0, Math.floor(Number(row.updated_at ?? 0))),
  }
}

export class AccountStore {
  private readonly db: Database
  private lastVirtualKeySessionCleanupAt = 0

  constructor(file: string) {
    this.db = new Database(file, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec("PRAGMA foreign_keys = ON;")
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        method_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        account_key TEXT NOT NULL,
        email TEXT,
        account_id TEXT,
        enterprise_url TEXT NOT NULL DEFAULT '',
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        id_token TEXT,
        expires_at INTEGER,
        is_active INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(provider_id, account_key, enterprise_url)
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(provider_id, is_active);

      CREATE TABLE IF NOT EXISTS virtual_api_keys (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        provider_id TEXT NOT NULL DEFAULT 'chatgpt',
        routing_mode TEXT NOT NULL DEFAULT 'single',
        account_scope TEXT NOT NULL DEFAULT 'all',
        client_mode TEXT NOT NULL DEFAULT 'codex',
        wire_api TEXT NOT NULL DEFAULT 'responses',
        name TEXT,
        fixed_model TEXT,
        fixed_reasoning_effort TEXT,
        key_hash TEXT NOT NULL UNIQUE,
        key_secret TEXT,
        key_prefix TEXT NOT NULL,
        is_revoked INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_virtual_api_keys_account ON virtual_api_keys(account_id);
      CREATE INDEX IF NOT EXISTS idx_virtual_api_keys_prefix ON virtual_api_keys(key_prefix);

      CREATE TABLE IF NOT EXISTS virtual_key_routes (
        key_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(key_id, account_id),
        FOREIGN KEY(key_id) REFERENCES virtual_api_keys(id) ON DELETE CASCADE,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_virtual_key_routes_key ON virtual_key_routes(key_id);
      CREATE INDEX IF NOT EXISTS idx_virtual_key_routes_account ON virtual_key_routes(account_id);

      CREATE TABLE IF NOT EXISTS virtual_key_sessions (
        key_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(key_id, session_id),
        FOREIGN KEY(key_id) REFERENCES virtual_api_keys(id) ON DELETE CASCADE,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_virtual_key_sessions_key ON virtual_key_sessions(key_id);
      CREATE INDEX IF NOT EXISTS idx_virtual_key_sessions_account ON virtual_key_sessions(account_id);

      ${CREATE_REQUEST_AUDITS_TABLE_SQL}
      ${REQUEST_AUDIT_INDEX_SQL.join("\n")}
      ${CREATE_REQUEST_TOKEN_STATS_TABLE_SQL}
      ${REQUEST_TOKEN_STATS_INDEX_SQL.join("\n")}

      CREATE TABLE IF NOT EXISTS global_usage_totals (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        priced_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `)
    this.ensureColumn("prompt_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("completion_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("total_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureVirtualKeysSchemaV2()
    this.ensureVirtualKeyColumn("key_secret", "TEXT")
    this.ensureVirtualKeyColumn("provider_id", "TEXT NOT NULL DEFAULT 'chatgpt'")
    this.ensureVirtualKeyColumn("routing_mode", "TEXT NOT NULL DEFAULT 'single'")
    this.ensureVirtualKeyColumn("account_scope", "TEXT NOT NULL DEFAULT 'all'")
    this.ensureVirtualKeyColumn("client_mode", "TEXT NOT NULL DEFAULT 'codex'")
    this.ensureVirtualKeyColumn("wire_api", "TEXT NOT NULL DEFAULT 'responses'")
    this.ensureVirtualKeyColumn("fixed_model", "TEXT")
    this.ensureVirtualKeyColumn("fixed_reasoning_effort", "TEXT")
    this.ensureVirtualKeyColumn("prompt_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureVirtualKeyColumn("completion_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureVirtualKeyColumn("total_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureVirtualKeyColumn("expires_at", "INTEGER")
    this.ensureColumn("id_token", "TEXT")
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_virtual_api_keys_provider ON virtual_api_keys(provider_id);`)
    this.ensureRequestAuditsSchema()
    this.ensureRequestTokenStatsSchema()
    this.ensureTableColumn("global_usage_totals", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("global_usage_totals", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("global_usage_totals", "priced_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("global_usage_totals", "estimated_cost_usd", "REAL NOT NULL DEFAULT 0")
    this.ensureGlobalUsageTotals()
    this.reconcileGlobalUsageTotals()
    this.migrateSecretsToEncrypted()
  }

  private rebuildRequestTokenStatsFromAudits() {
    this.db.exec(REBUILD_REQUEST_TOKEN_STATS_FROM_AUDITS_SQL)
  }

  rebuildRequestTokenStats() {
    this.rebuildRequestTokenStatsFromAudits()
  }

  private migrateSecretsToEncrypted() {
    if (!isSecretEncryptionEnabled()) return

    const accountRows = this.db
      .query<{ id: string; access_token: string; refresh_token: string | null; id_token: string | null }, []>(
        `SELECT id, access_token, refresh_token, id_token FROM accounts`,
      )
      .all()
    const updateAccount = this.db.query(`UPDATE accounts SET access_token = ?, refresh_token = ?, id_token = ? WHERE id = ?`)
    for (const row of accountRows) {
      const accessToken = sealSecret(openSecret(row.access_token))
      const refreshToken = sealSecret(openSecret(row.refresh_token))
      const idToken = sealSecret(openSecret(row.id_token))
      updateAccount.run(accessToken, refreshToken, idToken, row.id)
    }

    const keyRows = this.db
      .query<{ id: string; key_secret: string | null }, []>(`SELECT id, key_secret FROM virtual_api_keys`)
      .all()
    const updateKey = this.db.query(`UPDATE virtual_api_keys SET key_secret = ? WHERE id = ?`)
    for (const row of keyRows) {
      const keySecret = sealSecret(openSecret(row.key_secret))
      updateKey.run(keySecret, row.id)
    }
  }

  private ensureColumn(name: string, definition: string) {
    this.ensureTableColumn("accounts", name, definition)
  }

  private ensureVirtualKeyColumn(name: string, definition: string) {
    this.ensureTableColumn("virtual_api_keys", name, definition)
  }

  private listTableColumns(table: string) {
    return this.db.query<TableInfoRow, []>(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all()
  }

  private ensureTableColumn(table: string, name: string, definition: string) {
    const columns = this.listTableColumns(table)
    if (columns.some((column) => column.name === name)) return
    const tableName = table.replaceAll('"', '""')
    const columnName = name.replaceAll('"', '""')
    this.db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition};`)
  }

  private ensureRequestAuditsSchema() {
    this.ensureTableColumn("request_audits", "client_mode", "TEXT")
    this.ensureTableColumn("request_audits", "wire_api", "TEXT")
    this.ensureTableColumn("request_audits", "input_tokens", "INTEGER")
    this.ensureTableColumn("request_audits", "cached_input_tokens", "INTEGER")
    this.ensureTableColumn("request_audits", "output_tokens", "INTEGER")
    this.ensureTableColumn("request_audits", "total_tokens", "INTEGER")
    this.ensureTableColumn("request_audits", "billable_tokens", "INTEGER")
    this.ensureTableColumn("request_audits", "reasoning_output_tokens", "INTEGER")
    this.ensureTableColumn("request_audits", "estimated_cost_usd", "REAL")
    this.ensureTableColumn("request_audits", "reasoning_effort", "TEXT")
    this.db.exec(REQUEST_AUDIT_INDEX_SQL.join("\n"))
  }

  private ensureRequestTokenStatsSchema() {
    this.db.exec(`${CREATE_REQUEST_TOKEN_STATS_TABLE_SQL}\n${REQUEST_TOKEN_STATS_INDEX_SQL.join("\n")}`)
    this.ensureTableColumn("request_token_stats", "request_count", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "success_count", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "error_count", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "input_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "output_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "total_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "billable_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "priced_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "estimated_cost_usd", "REAL NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "unpriced_request_count", "INTEGER NOT NULL DEFAULT 0")
    this.ensureTableColumn("request_token_stats", "updated_at", "INTEGER NOT NULL DEFAULT 0")
    this.db.exec(`
      INSERT OR IGNORE INTO request_token_stats (
        day_key,
        request_count,
        success_count,
        error_count,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        total_tokens,
        billable_tokens,
        priced_tokens,
        reasoning_output_tokens,
        estimated_cost_usd,
        unpriced_request_count,
        updated_at
      )
      SELECT
        strftime('%Y-%m-%d', at / 1000.0, 'unixepoch', 'localtime') AS day_key,
        COUNT(*) AS request_count,
        COALESCE(SUM(${REQUEST_AUDIT_SUCCESS_SQL}), 0) AS success_count,
        COALESCE(SUM(${REQUEST_AUDIT_ERROR_SQL}), 0) AS error_count,
        COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND input_tokens > 0 THEN input_tokens ELSE 0 END), 0) AS input_tokens,
        COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL AND cached_input_tokens > 0 THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
        COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL AND output_tokens > 0 THEN output_tokens ELSE 0 END), 0) AS output_tokens,
        COALESCE(SUM(${REQUEST_AUDIT_TOTAL_TOKENS_SQL}), 0) AS total_tokens,
        COALESCE(SUM(${REQUEST_AUDIT_BILLABLE_TOKENS_SQL}), 0) AS billable_tokens,
        COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL AND estimated_cost_usd > 0 AND ${REQUEST_AUDIT_TOTAL_TOKENS_SQL} > 0 THEN ${REQUEST_AUDIT_TOTAL_TOKENS_SQL} ELSE 0 END), 0) AS priced_tokens,
        COALESCE(SUM(CASE WHEN reasoning_output_tokens IS NOT NULL AND reasoning_output_tokens > 0 THEN reasoning_output_tokens ELSE 0 END), 0) AS reasoning_output_tokens,
        COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL AND estimated_cost_usd > 0 THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd,
        COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL AND total_tokens > 0 AND estimated_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_request_count,
        COALESCE(MAX(at), 0) AS updated_at
      FROM request_audits
      GROUP BY strftime('%Y-%m-%d', at / 1000.0, 'unixepoch', 'localtime');
    `)
    this.db.exec(`
      UPDATE request_token_stats
      SET priced_tokens = COALESCE(
        (
          SELECT
            COALESCE(
              SUM(
                CASE
                  WHEN estimated_cost_usd IS NOT NULL AND estimated_cost_usd > 0 AND ${REQUEST_AUDIT_TOTAL_TOKENS_SQL} > 0
                    THEN ${REQUEST_AUDIT_TOTAL_TOKENS_SQL}
                  ELSE 0
                END
              ),
              0
            )
          FROM request_audits
          WHERE strftime('%Y-%m-%d', at / 1000.0, 'unixepoch', 'localtime') = request_token_stats.day_key
        ),
        0
      )
      WHERE COALESCE(priced_tokens, 0) = 0;
    `)
  }

  private ensureVirtualKeysSchemaV2() {
    const columns = this.db.query<TableInfoRow, []>(`PRAGMA table_info(virtual_api_keys)`).all()
    if (!columns.length) return

    const accountColumn = columns.find((column) => column.name === "account_id")
    const hasProvider = columns.some((column) => column.name === "provider_id")
    const hasRouting = columns.some((column) => column.name === "routing_mode")
    const hasAccountScope = columns.some((column) => column.name === "account_scope")
    const hasClientMode = columns.some((column) => column.name === "client_mode")
    const hasWireApi = columns.some((column) => column.name === "wire_api")
    const hasFixedModel = columns.some((column) => column.name === "fixed_model")
    const hasFixedReasoningEffort = columns.some((column) => column.name === "fixed_reasoning_effort")
    const hasKeySecret = columns.some((column) => column.name === "key_secret")
    const hasPromptTokens = columns.some((column) => column.name === "prompt_tokens")
    const hasCompletionTokens = columns.some((column) => column.name === "completion_tokens")
    const hasTotalTokens = columns.some((column) => column.name === "total_tokens")
    const hasExpiresAt = columns.some((column) => column.name === "expires_at")
    const needsNullableAccount = accountColumn?.notnull === 1

    if (
      !needsNullableAccount &&
      hasProvider &&
      hasRouting &&
      hasAccountScope &&
      hasClientMode &&
      hasWireApi &&
      hasKeySecret &&
      hasPromptTokens &&
      hasCompletionTokens &&
      hasTotalTokens &&
      hasExpiresAt
    )
      return

    const providerExpr = hasProvider ? "COALESCE(provider_id, 'chatgpt')" : "'chatgpt'"
    const routingExpr = hasRouting ? "CASE WHEN routing_mode = 'pool' THEN 'pool' ELSE 'single' END" : "'single'"
    const accountScopeExpr = hasAccountScope
      ? "CASE WHEN account_scope = 'free' THEN 'free' WHEN account_scope IN ('member', 'paid', 'paid_member') THEN 'member' ELSE 'all' END"
      : "'all'"
    const clientModeExpr = hasClientMode ? "CASE WHEN client_mode = 'cursor' THEN 'cursor' ELSE 'codex' END" : "'codex'"
    const wireApiExpr =
      hasWireApi ? "CASE WHEN wire_api = 'chat_completions' THEN 'chat_completions' ELSE 'responses' END" : "'responses'"
    const keySecretExpr = hasKeySecret ? "key_secret" : "NULL"
    const fixedModelExpr = hasFixedModel ? "fixed_model" : "NULL"
    const fixedReasoningEffortExpr = hasFixedReasoningEffort ? "fixed_reasoning_effort" : "NULL"
    const promptTokensExpr = hasPromptTokens ? "COALESCE(prompt_tokens, 0)" : "0"
    const completionTokensExpr = hasCompletionTokens ? "COALESCE(completion_tokens, 0)" : "0"
    const totalTokensExpr = hasTotalTokens ? "COALESCE(total_tokens, 0)" : "0"
    const expiresAtExpr = hasExpiresAt ? "expires_at" : "NULL"

    this.db.exec("PRAGMA foreign_keys = OFF;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_api_keys_v2 (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        provider_id TEXT NOT NULL DEFAULT 'chatgpt',
        routing_mode TEXT NOT NULL DEFAULT 'single',
        account_scope TEXT NOT NULL DEFAULT 'all',
        client_mode TEXT NOT NULL DEFAULT 'codex',
        wire_api TEXT NOT NULL DEFAULT 'responses',
        name TEXT,
        fixed_model TEXT,
        fixed_reasoning_effort TEXT,
        key_hash TEXT NOT NULL UNIQUE,
        key_secret TEXT,
        key_prefix TEXT NOT NULL,
        is_revoked INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );
    `)
    this.db.exec(`
      INSERT INTO virtual_api_keys_v2 (
        id,
        account_id,
        provider_id,
        routing_mode,
        account_scope,
        client_mode,
        wire_api,
        name,
        fixed_model,
        fixed_reasoning_effort,
        key_hash,
        key_secret,
        key_prefix,
        is_revoked,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        expires_at,
        last_used_at,
        created_at,
        updated_at
      )
      SELECT
        id,
        account_id,
        ${providerExpr},
        ${routingExpr},
        ${accountScopeExpr},
        ${clientModeExpr},
        ${wireApiExpr},
        name,
        ${fixedModelExpr},
        ${fixedReasoningEffortExpr},
        key_hash,
        ${keySecretExpr},
        key_prefix,
        is_revoked,
        ${promptTokensExpr},
        ${completionTokensExpr},
        ${totalTokensExpr},
        ${expiresAtExpr},
        last_used_at,
        created_at,
        updated_at
      FROM virtual_api_keys;
    `)
    this.db.exec(`DROP TABLE virtual_api_keys;`)
    this.db.exec(`ALTER TABLE virtual_api_keys_v2 RENAME TO virtual_api_keys;`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_virtual_api_keys_account ON virtual_api_keys(account_id);`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_virtual_api_keys_provider ON virtual_api_keys(provider_id);`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_virtual_api_keys_prefix ON virtual_api_keys(key_prefix);`)
    this.db.exec("PRAGMA foreign_keys = ON;")
  }

  private ensureGlobalUsageTotals() {
    const existing = this.db.query<{ id: number }, []>(`SELECT id FROM global_usage_totals WHERE id = 1 LIMIT 1`).get()
    if (existing) return

    const baseline =
      this.db
        .query<Pick<GlobalUsageTotalsRow, "prompt_tokens" | "completion_tokens" | "total_tokens">, []>(
          `
            SELECT
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
            FROM accounts
          `,
        )
        .get() ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }
    const requestStatsTotals = this.getRequestTokenStatsTotals()

    const now = Date.now()
    this.db
      .query(
        `
          INSERT INTO global_usage_totals (
            id,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cached_input_tokens,
            reasoning_output_tokens,
            priced_tokens,
            estimated_cost_usd,
            updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        Math.max(0, Math.floor(Number(baseline.prompt_tokens ?? 0))),
        Math.max(0, Math.floor(Number(baseline.completion_tokens ?? 0))),
        Math.max(0, Math.floor(Number(baseline.total_tokens ?? 0))),
        requestStatsTotals.cachedInputTokens,
        requestStatsTotals.reasoningOutputTokens,
        requestStatsTotals.pricedTokens,
        requestStatsTotals.estimatedCostUsd,
        now,
      )
  }

  private getRequestTokenStatsTotals() {
    const row =
      this.db
        .query<
          {
            cached_input_tokens: number
            reasoning_output_tokens: number
            priced_tokens: number
            estimated_cost_usd: number
            updated_at: number
          },
          []
        >(
          `
            SELECT
              COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
              COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
              COALESCE(SUM(priced_tokens), 0) AS priced_tokens,
              COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL AND estimated_cost_usd > 0 THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd,
              COALESCE(MAX(updated_at), 0) AS updated_at
            FROM request_token_stats
          `,
        )
        .get() ?? {
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
        priced_tokens: 0,
        estimated_cost_usd: 0,
        updated_at: 0,
      }

    return {
      cachedInputTokens: Math.max(0, Math.floor(Number(row.cached_input_tokens ?? 0))),
      reasoningOutputTokens: Math.max(0, Math.floor(Number(row.reasoning_output_tokens ?? 0))),
      pricedTokens: Math.max(0, Math.floor(Number(row.priced_tokens ?? 0))),
      estimatedCostUsd: Math.max(0, Number(row.estimated_cost_usd ?? 0)),
      updatedAt: Math.max(0, Math.floor(Number(row.updated_at ?? 0))),
    }
  }

  reconcileGlobalUsageTotals(now = Date.now()) {
    const current =
      this.db
        .query<GlobalUsageTotalsRow, []>(
          `
            SELECT
              prompt_tokens,
              completion_tokens,
              total_tokens,
              cached_input_tokens,
              reasoning_output_tokens,
              priced_tokens,
              estimated_cost_usd,
              updated_at
            FROM global_usage_totals
            WHERE id = 1
            LIMIT 1
          `,
        )
        .get() ?? null
    if (!current) return

    const requestStatsTotals = this.getRequestTokenStatsTotals()
    const nextCachedInputTokens = Math.max(
      0,
      Math.max(
        Math.floor(Number(current.cached_input_tokens ?? 0)),
        requestStatsTotals.cachedInputTokens,
      ),
    )
    const nextReasoningOutputTokens = Math.max(
      0,
      Math.max(
        Math.floor(Number(current.reasoning_output_tokens ?? 0)),
        requestStatsTotals.reasoningOutputTokens,
      ),
    )
    const nextPricedTokens = Math.max(
      0,
      Math.max(
        Math.floor(Number(current.priced_tokens ?? 0)),
        requestStatsTotals.pricedTokens,
      ),
    )
    const nextEstimatedCostUsd = Math.max(
      0,
      Math.max(Number(current.estimated_cost_usd ?? 0), requestStatsTotals.estimatedCostUsd),
    )
    const currentUpdatedAt = Math.max(0, Math.floor(Number(current.updated_at ?? 0)))
    const nextUpdatedAt = Math.max(currentUpdatedAt, requestStatsTotals.updatedAt, now)

    if (
      nextCachedInputTokens === Math.max(0, Math.floor(Number(current.cached_input_tokens ?? 0))) &&
      nextReasoningOutputTokens === Math.max(0, Math.floor(Number(current.reasoning_output_tokens ?? 0))) &&
      nextPricedTokens === Math.max(0, Math.floor(Number(current.priced_tokens ?? 0))) &&
      nextEstimatedCostUsd === Math.max(0, Number(current.estimated_cost_usd ?? 0))
    ) {
      return
    }

    this.db
      .query(
        `
          UPDATE global_usage_totals
          SET
            cached_input_tokens = ?,
            reasoning_output_tokens = ?,
            priced_tokens = ?,
            estimated_cost_usd = ?,
            updated_at = ?
          WHERE id = 1
        `,
      )
      .run(
        nextCachedInputTokens,
        nextReasoningOutputTokens,
        nextPricedTokens,
        nextEstimatedCostUsd,
        nextUpdatedAt,
      )
  }

  list() {
    const rows = this.db
      .query<AccountRow, []>(
        `
          SELECT *
          FROM accounts
          ORDER BY provider_id ASC, is_active DESC, updated_at DESC
        `,
      )
      .all()
    return rows.map(toStoredAccount)
  }

  get(id: string) {
    const row = this.db.query<AccountRow, [string]>(`SELECT * FROM accounts WHERE id = ?`).get(id)
    if (!row) return null
    return toStoredAccount(row)
  }

  save(input: SaveAccountInput) {
    const now = Date.now()
    const enterpriseUrl = input.enterpriseUrl ?? ""
    const accountKey = input.accountKey || input.accountId || input.email || crypto.randomUUID()
    const metadata = JSON.stringify(input.metadata ?? {})

    const tx = this.db.transaction(() => {
      const existing = this.db
        .query<{ id: string }, [string, string, string]>(
          `
            SELECT id
            FROM accounts
            WHERE provider_id = ? AND account_key = ? AND enterprise_url = ?
          `,
        )
        .get(input.providerId, accountKey, enterpriseUrl)

      if (existing) {
        this.db
          .query(
            `
              UPDATE accounts
              SET
                provider_name = ?,
                method_id = ?,
                display_name = ?,
                email = ?,
                account_id = ?,
                access_token = ?,
                refresh_token = ?,
                id_token = ?,
                expires_at = ?,
                metadata_json = ?,
                updated_at = ?
              WHERE id = ?
            `,
          )
          .run(
            input.providerName,
            input.methodId,
            input.displayName,
            input.email ?? null,
            input.accountId ?? null,
            sealSecret(input.accessToken),
            sealSecret(input.refreshToken ?? null),
            sealSecret(input.idToken ?? null),
            input.expiresAt ?? null,
            metadata,
            now,
            existing.id,
          )

        this.setActiveById(existing.id)
        return existing.id
      }

      const id = crypto.randomUUID()
      this.db
        .query(
          `
            INSERT INTO accounts (
              id,
              provider_id,
              provider_name,
              method_id,
              display_name,
              account_key,
              email,
              account_id,
              enterprise_url,
              access_token,
              refresh_token,
              id_token,
              expires_at,
              metadata_json,
              created_at,
              updated_at,
              is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `,
        )
        .run(
          id,
          input.providerId,
          input.providerName,
          input.methodId,
          input.displayName,
          accountKey,
          input.email ?? null,
          input.accountId ?? null,
          enterpriseUrl,
          sealSecret(input.accessToken),
          sealSecret(input.refreshToken ?? null),
          sealSecret(input.idToken ?? null),
          input.expiresAt ?? null,
          metadata,
          now,
          now,
        )

      this.setActiveById(id)
      return id
    })

    return tx()
  }

  saveBridgeOAuth(input: {
    providerId: string
    providerName: string
    methodId: string
    displayName: string
    accountKey: string
    email?: string | null
    accountId?: string | null
    accessToken: string
    refreshToken?: string | null
    idToken?: string | null
    expiresAt?: number | null
    metadata?: Record<string, unknown>
  }) {
    return this.save({
      providerId: input.providerId,
      providerName: input.providerName,
      methodId: input.methodId,
      displayName: input.displayName,
      accountKey: input.accountKey,
      email: input.email ?? undefined,
      accountId: input.accountId ?? undefined,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? undefined,
      idToken: input.idToken ?? undefined,
      expiresAt: input.expiresAt ?? undefined,
      metadata: input.metadata,
    })
  }

  createVirtualApiKey(input: {
    accountId?: string | null
    name?: string | null
    providerId?: string
    routingMode?: VirtualKeyRoutingMode
    accountScope?: VirtualKeyAccountScope | string | null
    clientMode?: VirtualKeyClientMode
    wireApi?: VirtualKeyWireAPI
    fixedModel?: string | null
    fixedReasoningEffort?: string | null
    validityDays?: number | null
  }) {
    const providerId = input.providerId ?? "chatgpt"
    const routingMode = input.routingMode ?? "single"
    const accountScope = normalizeVirtualKeyAccountScope(input.accountScope)
    const clientMode = input.clientMode === "cursor" ? "cursor" : "codex"
    const wireApi =
      input.wireApi === "chat_completions" ? "chat_completions" : clientMode === "cursor" ? "chat_completions" : "responses"
    const accountId = input.accountId ?? null
    const fixedModel = normalizeVirtualKeyOverrideValue(input.fixedModel)
    const fixedReasoningEffort = normalizeVirtualKeyOverrideValue(input.fixedReasoningEffort)
    const resolvedName = buildVirtualKeyDefaultName({
      name: input.name,
      clientMode,
      fixedModel,
      fixedReasoningEffort,
      accountScope,
    })
    if (routingMode === "single") {
      if (!accountId) throw new Error("Account is required for single-route virtual key")
      const account = this.get(accountId)
      if (!account) throw new Error("Account not found")
      if (account.providerId !== providerId) {
        throw new Error("Account provider does not match virtual key provider")
      }
      if (!virtualKeyScopeMatchesAccount(account, accountScope)) {
        throw new Error(`Selected account does not match ${accountScope} virtual key scope`)
      }
    } else {
      const accounts = this.getAvailableAccountsForProvider(providerId).filter((account) =>
        virtualKeyScopeMatchesAccount(account, accountScope),
      )
      if (accounts.length === 0) throw new Error("No available accounts for pool routing")
      if (accountId) {
        const account = this.get(accountId)
        if (!account) throw new Error("Account not found")
        if (account.providerId !== providerId) {
          throw new Error("Account provider does not match virtual key provider")
        }
        if (!virtualKeyScopeMatchesAccount(account, accountScope)) {
          throw new Error(`Selected account does not match ${accountScope} virtual key scope`)
        }
      }
    }

    const now = Date.now()
    const validityDays = input.validityDays === null ? null : Math.max(1, Math.floor(input.validityDays ?? 30))
    const expiresAt = validityDays === null ? null : now + validityDays * 24 * 60 * 60 * 1000
    const id = crypto.randomUUID()
    const secret = generateVirtualApiKeySecret()
    const hash = hashVirtualApiKey(secret)
    const keyPrefix = secret.slice(0, Math.min(secret.length, 24))

    this.db
      .query(
        `
          INSERT INTO virtual_api_keys (
            id,
            account_id,
            provider_id,
            routing_mode,
            account_scope,
            client_mode,
            wire_api,
            name,
            fixed_model,
            fixed_reasoning_effort,
            key_hash,
            key_secret,
            key_prefix,
            is_revoked,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            expires_at,
            last_used_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, NULL, ?, ?)
        `,
      )
      .run(
        id,
        accountId,
        providerId,
        routingMode,
        accountScope,
        clientMode,
        wireApi,
        resolvedName,
        fixedModel,
        fixedReasoningEffort,
        hash,
        sealSecret(secret),
        keyPrefix,
        expiresAt,
        now,
        now,
      )

    return {
      key: secret,
      record: this.getVirtualApiKeyByID(id),
    }
  }

  listVirtualApiKeys(accountId?: string) {
    const rows = accountId
      ? this.db
          .query<VirtualApiKeyRow, [string]>(
            `
              SELECT *
              FROM virtual_api_keys
              WHERE account_id = ?
              ORDER BY created_at DESC
            `,
          )
          .all(accountId)
      : this.db
          .query<VirtualApiKeyRow, []>(
            `
              SELECT *
              FROM virtual_api_keys
              ORDER BY created_at DESC
            `,
          )
          .all()
    return rows.map(toVirtualApiKeyRecord)
  }

  revokeVirtualApiKey(id: string) {
    this.db
      .query(
        `
          UPDATE virtual_api_keys
          SET is_revoked = 1, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(Date.now(), id)
  }

  restoreVirtualApiKey(id: string) {
    this.db
      .query(
        `
          UPDATE virtual_api_keys
          SET is_revoked = 0, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(Date.now(), id)
  }

  renameVirtualApiKey(id: string, name: string | null) {
    const row = this.getVirtualApiKeyByID(id)
    if (!row) throw new Error("Virtual API key not found")
    const normalized = name === null ? null : String(name).trim()
    this.db
      .query(
        `
          UPDATE virtual_api_keys
          SET name = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(normalized && normalized.length > 0 ? normalized : null, Date.now(), id)
    return this.getVirtualApiKeyByID(id)
  }

  renewVirtualApiKey(id: string, validityDays: number | null) {
    const row = this.getVirtualApiKeyByID(id)
    if (!row) throw new Error("Virtual API key not found")
    const now = Date.now()

    let expiresAt: number | null = null
    if (validityDays !== null) {
      const days = Math.max(1, Math.floor(validityDays))
      const baseTime = Math.max(now, Number(row.expiresAt ?? now))
      expiresAt = baseTime + days * 24 * 60 * 60 * 1000
    }

    this.db
      .query(
        `
          UPDATE virtual_api_keys
          SET expires_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(expiresAt, now, id)
    return this.getVirtualApiKeyByID(id)
  }

  deleteVirtualApiKey(id: string) {
    this.db.query(`DELETE FROM virtual_api_keys WHERE id = ?`).run(id)
  }

  getVirtualApiKeyByID(id: string) {
    const row = this.db.query<VirtualApiKeyRow, [string]>(`SELECT * FROM virtual_api_keys WHERE id = ?`).get(id)
    if (!row) return null
    return toVirtualApiKeyRecord(row)
  }

  revealVirtualApiKey(id: string) {
    const row = this.db
      .query<{ key_secret: string | null }, [string]>(`SELECT key_secret FROM virtual_api_keys WHERE id = ?`)
      .get(id)
    return openSecret(row?.key_secret) ?? null
  }

  resolveVirtualApiKey(
    secret: string,
    options?: {
      sessionId?: string | null
      excludeAccountIds?: string[]
      deprioritizedAccountIds?: string[]
      headroomByAccountId?: Map<string, number>
      pressureScoreByAccountId?: Map<string, number>
      routeOptionsFactory?: (
        key: Pick<VirtualApiKeyRecord, "id" | "providerId" | "routingMode" | "accountScope">,
      ) =>
        | {
            excludeAccountIds?: string[]
            deprioritizedAccountIds?: string[]
            headroomByAccountId?: Map<string, number>
            pressureScoreByAccountId?: Map<string, number>
          }
        | null
        | undefined
    },
  ) {
    if (!secret || !secret.startsWith("ocsk_")) return null
    const keyHash = hashVirtualApiKey(secret)
    const now = Date.now()
    const row = this.db
      .query<VirtualApiKeyRow, [string, number]>(
        `
          SELECT *
          FROM virtual_api_keys
          WHERE key_hash = ? AND is_revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
          LIMIT 1
        `,
      )
      .get(keyHash, now)
    if (!row) return null

    this.db
      .query(
        `
          UPDATE virtual_api_keys
          SET last_used_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(now, now, row.id)

    const key = toVirtualApiKeyRecord(row)
    const sessionId = normalizeSessionRouteID(options?.sessionId)
    const derivedRouteOptions = options?.routeOptionsFactory?.(key)
    const excludeAccountIds = new Set([
      ...(options?.excludeAccountIds ?? []),
      ...(derivedRouteOptions?.excludeAccountIds ?? []),
    ])
    const deprioritizedAccountIds = new Set([
      ...(options?.deprioritizedAccountIds ?? []),
      ...(derivedRouteOptions?.deprioritizedAccountIds ?? []),
    ])
    const headroomByAccountId = new Map<string, number>()
    for (const [accountId, headroom] of options?.headroomByAccountId ?? []) {
      headroomByAccountId.set(accountId, headroom)
    }
    for (const [accountId, headroom] of derivedRouteOptions?.headroomByAccountId ?? []) {
      headroomByAccountId.set(accountId, headroom)
    }
    const pressureScoreByAccountId = new Map<string, number>()
    for (const [accountId, score] of options?.pressureScoreByAccountId ?? []) {
      pressureScoreByAccountId.set(accountId, score)
    }
    for (const [accountId, score] of derivedRouteOptions?.pressureScoreByAccountId ?? []) {
      pressureScoreByAccountId.set(accountId, score)
    }
    const routeOptions = {
      excludeAccountIds,
      deprioritizedAccountIds,
      headroomByAccountId,
      pressureScoreByAccountId,
    }
    const account =
      key.routingMode === "pool"
        ? this.pickPoolAccountForKey(key.id, key.providerId, sessionId, routeOptions)
        : this.getSingleRouteAccount(key.providerId, key.accountId, key.accountScope)

    if (!account) return null
    return {
      key,
      account,
    }
  }

  resolveVirtualApiKeyByID(
    id: string,
    options?: {
      sessionId?: string | null
      excludeAccountIds?: string[]
      deprioritizedAccountIds?: string[]
      headroomByAccountId?: Map<string, number>
      pressureScoreByAccountId?: Map<string, number>
      routeOptionsFactory?: (
        key: Pick<VirtualApiKeyRecord, "id" | "providerId" | "routingMode" | "accountScope">,
      ) =>
        | {
            excludeAccountIds?: string[]
            deprioritizedAccountIds?: string[]
            headroomByAccountId?: Map<string, number>
            pressureScoreByAccountId?: Map<string, number>
          }
        | null
        | undefined
    },
  ) {
    const normalizedId = String(id ?? "").trim()
    if (!normalizedId) return null
    const now = Date.now()
    const row = this.db
      .query<VirtualApiKeyRow, [string, number]>(
        `
          SELECT *
          FROM virtual_api_keys
          WHERE id = ? AND is_revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
          LIMIT 1
        `,
      )
      .get(normalizedId, now)
    if (!row) return null

    this.db
      .query(
        `
          UPDATE virtual_api_keys
          SET last_used_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(now, now, row.id)

    const key = toVirtualApiKeyRecord(row)
    const sessionId = normalizeSessionRouteID(options?.sessionId)
    const derivedRouteOptions = options?.routeOptionsFactory?.(key)
    const excludeAccountIds = new Set([
      ...(options?.excludeAccountIds ?? []),
      ...(derivedRouteOptions?.excludeAccountIds ?? []),
    ])
    const deprioritizedAccountIds = new Set([
      ...(options?.deprioritizedAccountIds ?? []),
      ...(derivedRouteOptions?.deprioritizedAccountIds ?? []),
    ])
    const headroomByAccountId = new Map<string, number>()
    for (const [accountId, headroom] of options?.headroomByAccountId ?? []) {
      headroomByAccountId.set(accountId, headroom)
    }
    for (const [accountId, headroom] of derivedRouteOptions?.headroomByAccountId ?? []) {
      headroomByAccountId.set(accountId, headroom)
    }
    const pressureScoreByAccountId = new Map<string, number>()
    for (const [accountId, score] of options?.pressureScoreByAccountId ?? []) {
      pressureScoreByAccountId.set(accountId, score)
    }
    for (const [accountId, score] of derivedRouteOptions?.pressureScoreByAccountId ?? []) {
      pressureScoreByAccountId.set(accountId, score)
    }
    const routeOptions = {
      excludeAccountIds,
      deprioritizedAccountIds,
      headroomByAccountId,
      pressureScoreByAccountId,
    }
    const account =
      key.routingMode === "pool"
        ? this.pickPoolAccountForKey(key.id, key.providerId, sessionId, routeOptions)
        : this.getSingleRouteAccount(key.providerId, key.accountId, key.accountScope)

    if (!account) return null
    return {
      key,
      account,
    }
  }

  private getSingleRouteAccount(providerId: string, accountID: string | null, accountScope: VirtualKeyAccountScope = "all") {
    if (!accountID) return null
    const account = this.get(accountID)
    if (!account) return null
    if (account.providerId !== providerId) return null
    if (!virtualKeyScopeMatchesAccount(account, accountScope)) return null
    return account
  }

  private getAvailableAccountsForProvider(providerId: string) {
    return this.list().filter((account) => account.providerId === providerId && Boolean(account.accessToken))
  }

  private pickPoolAccountForKey(
    keyID: string,
    providerId: string,
    sessionId?: string,
    options?: {
      excludeAccountIds?: Set<string>
      deprioritizedAccountIds?: Set<string>
      headroomByAccountId?: Map<string, number>
      pressureScoreByAccountId?: Map<string, number>
    },
  ) {
    this.pruneExpiredVirtualKeySessions()
    if (sessionId) {
      const sticky = this.pickSessionStickyAccount(keyID, providerId, sessionId)
      if (
        sticky &&
        !options?.excludeAccountIds?.has(sticky.id) &&
        !options?.deprioritizedAccountIds?.has(sticky.id)
      ) {
        return sticky
      }
    }

    const selected = this.pickPoolAccountCandidate(keyID, providerId, options)

    if (!selected) return null
    this.touchVirtualKeyRoute(keyID, selected.id)
    if (sessionId) {
      this.touchVirtualKeySessionRoute(keyID, sessionId, selected.id)
    }
    return selected
  }

  private pickSessionStickyAccount(keyID: string, providerId: string, sessionId: string) {
    this.pruneExpiredVirtualKeySessions()
    const row = this.db
      .query<VirtualKeySessionRow, [string, string]>(
        `
          SELECT key_id, session_id, account_id, request_count, last_used_at, updated_at
          FROM virtual_key_sessions
          WHERE key_id = ? AND session_id = ?
          LIMIT 1
        `,
      )
      .get(keyID, sessionId)
    if (!row) return null
    if (!this.isVirtualKeySessionFresh(row)) {
      this.deleteVirtualKeySessionRoute(keyID, sessionId)
      return null
    }

    const account = this.getSingleRouteAccount(providerId, row.account_id)
    if (!account) return null

    this.touchVirtualKeyRoute(keyID, account.id)
    this.touchVirtualKeySessionRoute(keyID, sessionId, account.id)
    return account
  }

  private pickPoolAccountCandidate(
    keyID: string,
    providerId: string,
    options?: {
      excludeAccountIds?: Set<string>
      deprioritizedAccountIds?: Set<string>
      headroomByAccountId?: Map<string, number>
      pressureScoreByAccountId?: Map<string, number>
    },
  ) {
    const excluded = options?.excludeAccountIds ?? new Set<string>()
    const deprioritized = options?.deprioritizedAccountIds ?? new Set<string>()
    const headroomByAccountId = options?.headroomByAccountId ?? new Map<string, number>()
    const pressureScoreByAccountId = options?.pressureScoreByAccountId ?? new Map<string, number>()
    const candidates = this.getAvailableAccountsForProvider(providerId).filter((account) => !excluded.has(account.id))
    if (candidates.length === 0) return null

    const routeRows = this.db
      .query<VirtualKeyRouteRow, [string]>(
        `
          SELECT account_id, request_count, last_used_at
          FROM virtual_key_routes
          WHERE key_id = ?
        `,
      )
      .all(keyID)

    const routeMap = new Map(routeRows.map((row) => [row.account_id, row]))
    const sorted = [...candidates].sort((a, b) => {
      const deprioritizedA = deprioritized.has(a.id) ? 1 : 0
      const deprioritizedB = deprioritized.has(b.id) ? 1 : 0
      if (deprioritizedA !== deprioritizedB) return deprioritizedA - deprioritizedB

      const pressureA = pressureScoreByAccountId.get(a.id)
      const pressureB = pressureScoreByAccountId.get(b.id)
      const hasPressureA = Number.isFinite(pressureA)
      const hasPressureB = Number.isFinite(pressureB)
      if (hasPressureA !== hasPressureB) return hasPressureA ? -1 : 1
      if (hasPressureA && hasPressureB && pressureA !== pressureB) return Number(pressureA) - Number(pressureB)

      const headroomA = headroomByAccountId.get(a.id)
      const headroomB = headroomByAccountId.get(b.id)
      const hasHeadroomA = Number.isFinite(headroomA)
      const hasHeadroomB = Number.isFinite(headroomB)
      if (hasHeadroomA !== hasHeadroomB) return hasHeadroomA ? -1 : 1
      if (hasHeadroomA && hasHeadroomB && headroomA !== headroomB) return Number(headroomB) - Number(headroomA)


      const routeA = routeMap.get(a.id)
      const routeB = routeMap.get(b.id)
      const countA = routeA?.request_count ?? 0
      const countB = routeB?.request_count ?? 0
      if (countA !== countB) return countA - countB

      const lastA = routeA?.last_used_at ?? 0
      const lastB = routeB?.last_used_at ?? 0
      if (lastA !== lastB) return lastA - lastB

      return a.id.localeCompare(b.id)
    })

    if (ROUTING_DEBUG_ENABLED) {
      console.log(
        `[oauth-multi-login] route-candidates key=${keyID} provider=${providerId} candidates=${sorted
          .map((account) => {
            const route = routeMap.get(account.id)
            const headroom = headroomByAccountId.get(account.id)
            const pressure = pressureScoreByAccountId.get(account.id)
            return `${account.id}{deprioritized=${deprioritized.has(account.id)},pressure=${pressure ?? "-"},headroom=${headroom ?? "-"},count=${
              route?.request_count ?? 0
            },last=${route?.last_used_at ?? 0}}`
          })
          .join(",")}`,
      )
    }

    return sorted[0]
  }

  reassignVirtualKeySessionRoute(input: {
    keyId: string
    providerId: string
    sessionId: string
    failedAccountId: string
    excludeAccountIds?: string[]
    deprioritizedAccountIds?: string[]
    headroomByAccountId?: Map<string, number>
    pressureScoreByAccountId?: Map<string, number>
  }) {
    const sessionId = normalizeSessionRouteID(input.sessionId)
    if (!sessionId) return null
    this.pruneExpiredVirtualKeySessions()

    const excluded = new Set<string>([input.failedAccountId, ...(input.excludeAccountIds ?? [])])
    const selected = this.pickPoolAccountCandidate(input.keyId, input.providerId, {
      excludeAccountIds: excluded,
      deprioritizedAccountIds: new Set(input.deprioritizedAccountIds ?? []),
      headroomByAccountId: input.headroomByAccountId,
      pressureScoreByAccountId: input.pressureScoreByAccountId,
    })
    if (!selected) return null

    this.touchVirtualKeyRoute(input.keyId, selected.id)
    this.touchVirtualKeySessionRoute(input.keyId, sessionId, selected.id)
    return selected
  }

  reassignVirtualKeyRoute(input: {
    keyId: string
    providerId: string
    failedAccountId: string
    excludeAccountIds?: string[]
    deprioritizedAccountIds?: string[]
    headroomByAccountId?: Map<string, number>
    pressureScoreByAccountId?: Map<string, number>
  }) {
    const excluded = new Set<string>([input.failedAccountId, ...(input.excludeAccountIds ?? [])])
    const selected = this.pickPoolAccountCandidate(input.keyId, input.providerId, {
      excludeAccountIds: excluded,
      deprioritizedAccountIds: new Set(input.deprioritizedAccountIds ?? []),
      headroomByAccountId: input.headroomByAccountId,
      pressureScoreByAccountId: input.pressureScoreByAccountId,
    })
    if (!selected) return null

    this.touchVirtualKeyRoute(input.keyId, selected.id)
    return selected
  }

  hasEstablishedVirtualKeySessionRoute(input: {
    keyId: string
    sessionId?: string | null
    accountId?: string | null
  }) {
    const sessionId = normalizeSessionRouteID(input.sessionId)
    const accountId = String(input.accountId ?? "").trim()
    if (!sessionId || !accountId) return false
    this.pruneExpiredVirtualKeySessions()

    const row = this.db
      .query<{ request_count: number; last_used_at: number | null; updated_at: number | null }, [string, string, string]>(
        `
          SELECT request_count, last_used_at, updated_at
          FROM virtual_key_sessions
          WHERE key_id = ? AND session_id = ? AND account_id = ?
          LIMIT 1
        `,
      )
      .get(input.keyId, sessionId, accountId)
    if (row && !this.isVirtualKeySessionFresh(row)) {
      this.deleteVirtualKeySessionRoute(input.keyId, sessionId)
      return false
    }

    return Number(row?.request_count ?? 0) > 1
  }

  private touchVirtualKeyRoute(keyID: string, accountID: string) {
    const now = Date.now()
    this.db
      .query(
        `
          INSERT INTO virtual_key_routes (
            key_id,
            account_id,
            request_count,
            last_used_at,
            updated_at
          ) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(key_id, account_id) DO UPDATE SET
            request_count = request_count + 1,
            last_used_at = excluded.last_used_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(keyID, accountID, now, now)
  }

  private touchVirtualKeySessionRoute(keyID: string, sessionId: string, accountID: string) {
    this.pruneExpiredVirtualKeySessions()
    const now = Date.now()
    this.db
      .query(
        `
          INSERT INTO virtual_key_sessions (
            key_id,
            session_id,
            account_id,
            request_count,
            last_used_at,
            updated_at
          ) VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(key_id, session_id) DO UPDATE SET
            account_id = excluded.account_id,
            request_count = request_count + 1,
            last_used_at = excluded.last_used_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(keyID, sessionId, accountID, now, now)
  }

  private pruneExpiredVirtualKeySessions(now = Date.now()) {
    if (now - this.lastVirtualKeySessionCleanupAt < VIRTUAL_KEY_SESSION_CLEANUP_INTERVAL_MS) {
      return
    }
    this.lastVirtualKeySessionCleanupAt = now
    const oldestAllowed = now - VIRTUAL_KEY_SESSION_IDLE_TTL_MS
    this.db
      .query(
        `
          DELETE FROM virtual_key_sessions
          WHERE COALESCE(last_used_at, updated_at, 0) > 0
            AND COALESCE(last_used_at, updated_at, 0) < ?
        `,
      )
      .run(oldestAllowed)
  }

  private isVirtualKeySessionFresh(row?: { last_used_at?: number | null; updated_at?: number | null } | null, now = Date.now()) {
    const touchedAt = Number(row?.last_used_at ?? row?.updated_at ?? 0)
    if (!Number.isFinite(touchedAt) || touchedAt <= 0) return false
    return now - touchedAt <= VIRTUAL_KEY_SESSION_IDLE_TTL_MS
  }

  private deleteVirtualKeySessionRoute(keyID: string, sessionId: string) {
    this.db
      .query(
        `
          DELETE FROM virtual_key_sessions
          WHERE key_id = ? AND session_id = ?
        `,
      )
      .run(keyID, sessionId)
  }

  activate(id: string) {
    const row = this.db.query<{ provider_id: string }, [string]>(`SELECT provider_id FROM accounts WHERE id = ?`).get(id)
    if (!row) {
      throw new Error("Account not found")
    }
    const tx = this.db.transaction(() => {
      this.db.query(`UPDATE accounts SET is_active = 0 WHERE provider_id = ?`).run(row.provider_id)
      this.db.query(`UPDATE accounts SET is_active = 1, updated_at = ? WHERE id = ?`).run(Date.now(), id)
    })
    tx()
  }

  delete(id: string) {
    this.db.query(`DELETE FROM accounts WHERE id = ?`).run(id)
  }

  updateTokens(input: {
    id: string
    accessToken: string
    refreshToken?: string
    idToken?: string | null
    expiresAt?: number
    accountId?: string | null
  }) {
    const row = this.get(input.id)
    if (!row) throw new Error("Account not found")
    const nextIdToken = input.idToken === undefined ? row.idToken : input.idToken
    this.db
      .query(
        `
          UPDATE accounts
          SET
            access_token = ?,
            refresh_token = ?,
            id_token = ?,
            expires_at = ?,
            account_id = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        sealSecret(input.accessToken),
        sealSecret(input.refreshToken ?? null),
        sealSecret(nextIdToken ?? null),
        input.expiresAt ?? null,
        input.accountId ?? row.accountId ?? null,
        Date.now(),
        input.id,
      )
  }

  getUsageTotals(): UsageTotals {
    this.ensureGlobalUsageTotals()
    const row = this.db
      .query<GlobalUsageTotalsRow, []>(
        `
          SELECT
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cached_input_tokens,
            reasoning_output_tokens,
            priced_tokens,
            estimated_cost_usd,
            updated_at
          FROM global_usage_totals
          WHERE id = 1
          LIMIT 1
        `,
      )
      .get()
    return {
      promptTokens: Math.max(0, Math.floor(Number(row?.prompt_tokens ?? 0))),
      completionTokens: Math.max(0, Math.floor(Number(row?.completion_tokens ?? 0))),
      totalTokens: Math.max(0, Math.floor(Number(row?.total_tokens ?? 0))),
      cachedInputTokens: Math.max(0, Math.floor(Number(row?.cached_input_tokens ?? 0))),
      reasoningOutputTokens: Math.max(0, Math.floor(Number(row?.reasoning_output_tokens ?? 0))),
      pricedTokens: Math.max(0, Math.floor(Number(row?.priced_tokens ?? 0))),
      estimatedCostUsd: Math.max(0, Number(row?.estimated_cost_usd ?? 0)),
      updatedAt: Math.max(0, Math.floor(Number(row?.updated_at ?? 0))),
    }
  }

  private addGlobalUsageDelta(
    input: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
      cachedInputTokens?: number
      reasoningOutputTokens?: number
      pricedTokens?: number
      estimatedCostUsd?: number
    },
    now = Date.now(),
  ) {
    const promptTokens = Math.trunc(Number(input.promptTokens ?? 0))
    const completionTokens = Math.trunc(Number(input.completionTokens ?? 0))
    const totalTokens = Math.trunc(Number(input.totalTokens ?? 0))
    const cachedInputTokens = Math.trunc(Number(input.cachedInputTokens ?? 0))
    const reasoningOutputTokens = Math.trunc(Number(input.reasoningOutputTokens ?? 0))
    const pricedTokens = Math.trunc(Number(input.pricedTokens ?? 0))
    const estimatedCostUsd = Number(input.estimatedCostUsd ?? 0)
    if (
      promptTokens === 0 &&
      completionTokens === 0 &&
      totalTokens === 0 &&
      cachedInputTokens === 0 &&
      reasoningOutputTokens === 0 &&
      pricedTokens === 0 &&
      estimatedCostUsd === 0
    ) {
      return
    }
    this.ensureGlobalUsageTotals()
    this.db
      .query(
        `
          UPDATE global_usage_totals
          SET
            prompt_tokens = MAX(0, prompt_tokens + ?),
            completion_tokens = MAX(0, completion_tokens + ?),
            total_tokens = MAX(0, total_tokens + ?),
            cached_input_tokens = MAX(0, cached_input_tokens + ?),
            reasoning_output_tokens = MAX(0, reasoning_output_tokens + ?),
            priced_tokens = MAX(0, priced_tokens + ?),
            estimated_cost_usd = MAX(0, estimated_cost_usd + ?),
            updated_at = ?
          WHERE id = 1
        `,
      )
      .run(
        promptTokens,
        completionTokens,
        totalTokens,
        cachedInputTokens,
        reasoningOutputTokens,
        pricedTokens,
        estimatedCostUsd,
        now,
      )
  }

  addUsage(input: {
    id: string
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedInputTokens?: number | null
    reasoningOutputTokens?: number | null
    estimatedCostUsd?: number | null
  }) {
    const row = this.get(input.id)
    if (!row) throw new Error("Account not found")
    const promptTokens = Math.max(0, Math.floor(input.promptTokens ?? 0))
    const completionTokens = Math.max(0, Math.floor(input.completionTokens ?? 0))
    const totalTokens = Math.max(0, Math.floor(input.totalTokens ?? promptTokens + completionTokens))
    const cachedInputTokens = Math.max(0, Math.floor(Number(input.cachedInputTokens ?? 0)))
    const reasoningOutputTokens = Math.max(0, Math.floor(Number(input.reasoningOutputTokens ?? 0)))
    const estimatedCostUsd = input.estimatedCostUsd == null ? null : Math.max(0, Number(input.estimatedCostUsd ?? 0))
    const pricedTokens = estimatedCostUsd !== null && totalTokens > 0 ? totalTokens : 0
    if (
      promptTokens === 0 &&
      completionTokens === 0 &&
      totalTokens === 0 &&
      cachedInputTokens === 0 &&
      reasoningOutputTokens === 0 &&
      estimatedCostUsd === null
    ) {
      return
    }
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `
            UPDATE accounts
            SET
              prompt_tokens = prompt_tokens + ?,
              completion_tokens = completion_tokens + ?,
              total_tokens = total_tokens + ?,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(promptTokens, completionTokens, totalTokens, now, input.id)
      this.addGlobalUsageDelta(
        {
          promptTokens,
          completionTokens,
          totalTokens,
          cachedInputTokens,
          reasoningOutputTokens,
          pricedTokens,
          estimatedCostUsd: estimatedCostUsd ?? 0,
        },
        now,
      )
    })
    tx()
  }

  addVirtualKeyUsage(input: { id: string; promptTokens?: number; completionTokens?: number; totalTokens?: number }) {
    const promptTokens = Math.max(0, Math.floor(input.promptTokens ?? 0))
    const completionTokens = Math.max(0, Math.floor(input.completionTokens ?? 0))
    const totalTokens = Math.max(0, Math.floor(input.totalTokens ?? promptTokens + completionTokens))
    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return
    this.db
      .query(
        `
          UPDATE virtual_api_keys
          SET
            prompt_tokens = prompt_tokens + ?,
            completion_tokens = completion_tokens + ?,
            total_tokens = total_tokens + ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(promptTokens, completionTokens, totalTokens, Date.now(), input.id)
  }

  addRequestAudit(input: {
    route: string
    method: string
    providerId?: string | null
    accountId?: string | null
    virtualKeyId?: string | null
    clientMode?: VirtualKeyClientMode | null
    wireApi?: VirtualKeyWireAPI | null
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
    promptTokens?: number | null
    at?: number | null
    inputTokens?: number | null
    cachedInputTokens?: number | null
    completionTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    billableTokens?: number | null
    reasoningOutputTokens?: number | null
    estimatedCostUsd?: number | null
    reasoningEffort?: string | null
  }) {
    const id = crypto.randomUUID()
    const now = normalizeAuditTimestamp(input.at)
    const requestBytes = Math.max(0, Math.floor(input.requestBytes ?? input.requestBody?.byteLength ?? 0))
    const responseBytes = Math.max(0, Math.floor(input.responseBytes ?? 0))
    const statusCode = Math.max(0, Math.floor(input.statusCode ?? 0))
    const latencyMs = Math.max(0, Math.floor(input.latencyMs ?? 0))
    const inputTokens = normalizeNonNegativeInteger(input.inputTokens ?? input.promptTokens)
    const cachedInputTokens = normalizeNonNegativeInteger(input.cachedInputTokens)
    const outputTokens = normalizeNonNegativeInteger(input.outputTokens ?? input.completionTokens)
    const totalTokens = resolveAuditTotalTokens(normalizeNonNegativeInteger(input.totalTokens), inputTokens, outputTokens)
    const billableTokens = resolveAuditBillableTokens(
      normalizeNonNegativeInteger(input.billableTokens),
      inputTokens,
      cachedInputTokens,
      outputTokens,
    )
    const reasoningOutputTokens = normalizeNonNegativeInteger(input.reasoningOutputTokens)
    const estimatedCostUsd = normalizeNonNegativeNumber(input.estimatedCostUsd)
    const pricedTokens = estimatedCostUsd != null && totalTokens != null && totalTokens > 0 ? totalTokens : 0
    const reasoningEffort = String(input.reasoningEffort ?? "").trim() || null
    const requestHash = hashRequestPayload(input.requestBody ?? new Uint8Array(0))
    const successCount = statusCode >= 200 && statusCode <= 299 ? 1 : 0
    const errorCount = statusCode >= 400 || String(input.error ?? "").trim() ? 1 : 0
    const unpricedRequestCount = totalTokens != null && totalTokens > 0 && estimatedCostUsd == null ? 1 : 0
    const dayKey = toLocalDayKey(now)
    const tx = this.db.transaction(() => {
      this.db
        .query(
        `
          INSERT INTO request_audits (
            id,
            at,
            route,
            method,
            provider_id,
            account_id,
            virtual_key_id,
            model,
            session_id,
            request_hash,
            request_bytes,
            response_bytes,
            status_code,
            latency_ms,
            upstream_request_id,
            error_text,
            client_tag,
            client_mode,
            wire_api,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            total_tokens,
            billable_tokens,
            reasoning_output_tokens,
            estimated_cost_usd,
            reasoning_effort
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          now,
          input.route,
          input.method,
          input.providerId ?? null,
          input.accountId ?? null,
          input.virtualKeyId ?? null,
          input.model ?? null,
          input.sessionId ?? null,
          requestHash,
          requestBytes,
          responseBytes,
          statusCode,
          latencyMs,
          input.upstreamRequestId ?? null,
          input.error ?? null,
          input.clientTag ?? null,
          input.clientMode ?? null,
          input.wireApi ?? null,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens,
          billableTokens,
          reasoningOutputTokens,
          estimatedCostUsd,
          reasoningEffort,
        )
      this.db
        .query(
          `
            INSERT INTO request_token_stats (
              day_key,
              request_count,
              success_count,
              error_count,
              input_tokens,
              cached_input_tokens,
              output_tokens,
              total_tokens,
              billable_tokens,
              priced_tokens,
              reasoning_output_tokens,
              estimated_cost_usd,
              unpriced_request_count,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(day_key) DO UPDATE SET
              request_count = request_token_stats.request_count + excluded.request_count,
              success_count = request_token_stats.success_count + excluded.success_count,
              error_count = request_token_stats.error_count + excluded.error_count,
              input_tokens = request_token_stats.input_tokens + excluded.input_tokens,
              cached_input_tokens = request_token_stats.cached_input_tokens + excluded.cached_input_tokens,
              output_tokens = request_token_stats.output_tokens + excluded.output_tokens,
              total_tokens = request_token_stats.total_tokens + excluded.total_tokens,
              billable_tokens = request_token_stats.billable_tokens + excluded.billable_tokens,
              priced_tokens = request_token_stats.priced_tokens + excluded.priced_tokens,
              reasoning_output_tokens = request_token_stats.reasoning_output_tokens + excluded.reasoning_output_tokens,
              estimated_cost_usd = request_token_stats.estimated_cost_usd + excluded.estimated_cost_usd,
              unpriced_request_count = request_token_stats.unpriced_request_count + excluded.unpriced_request_count,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          dayKey,
          1,
          successCount,
          errorCount,
          inputTokens ?? 0,
          cachedInputTokens ?? 0,
          outputTokens ?? 0,
          totalTokens ?? 0,
          billableTokens ?? 0,
          pricedTokens,
          reasoningOutputTokens ?? 0,
          estimatedCostUsd ?? 0,
          unpricedRequestCount,
          Date.now(),
        )
      this.addGlobalUsageDelta(
        {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedInputTokens: cachedInputTokens ?? 0,
          reasoningOutputTokens: reasoningOutputTokens ?? 0,
          pricedTokens,
          estimatedCostUsd: estimatedCostUsd ?? 0,
        },
        now,
      )
    })
    tx()
    return id
  }

  updateRequestAuditUsage(input: {
    auditId: string
    inputTokens?: number | null
    promptTokens?: number | null
    cachedInputTokens?: number | null
    outputTokens?: number | null
    completionTokens?: number | null
    totalTokens?: number | null
    billableTokens?: number | null
    reasoningOutputTokens?: number | null
    estimatedCostUsd?: number | null
    reasoningEffort?: string | null
  }) {
    const auditId = String(input.auditId ?? "").trim()
    if (!auditId) return
    const existing = this.db
      .query<RequestAuditRow, [string]>(
        `
          SELECT *
          FROM request_audits
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(auditId)
    if (!existing) return

    const nextInputTokens = normalizeNonNegativeInteger(input.inputTokens ?? input.promptTokens)
    const nextCachedInputTokens = normalizeNonNegativeInteger(input.cachedInputTokens)
    const nextOutputTokens = normalizeNonNegativeInteger(input.outputTokens ?? input.completionTokens)
    const resolvedInputTokens = nextInputTokens ?? existing.input_tokens ?? null
    const resolvedCachedInputTokens = nextCachedInputTokens ?? existing.cached_input_tokens ?? null
    const resolvedOutputTokens = nextOutputTokens ?? existing.output_tokens ?? null
    const resolvedTotalTokens = resolveAuditTotalTokens(
      normalizeNonNegativeInteger(input.totalTokens) ?? existing.total_tokens ?? null,
      resolvedInputTokens,
      resolvedOutputTokens,
    )
    const explicitBillableTokens = normalizeNonNegativeInteger(input.billableTokens)
    const preservedExistingBillableTokens =
      existing.billable_tokens != null && existing.billable_tokens > 0 ? existing.billable_tokens : null
    const resolvedBillableTokens = resolveAuditBillableTokens(
      explicitBillableTokens ?? preservedExistingBillableTokens,
      resolvedInputTokens,
      resolvedCachedInputTokens,
      resolvedOutputTokens,
    )
    const resolvedReasoningOutputTokens =
      normalizeNonNegativeInteger(input.reasoningOutputTokens) ?? existing.reasoning_output_tokens ?? null
    const resolvedEstimatedCostUsd =
      normalizeNonNegativeNumber(input.estimatedCostUsd) ?? normalizeNonNegativeNumber(existing.estimated_cost_usd)
    const resolvedReasoningEffort = String(input.reasoningEffort ?? existing.reasoning_effort ?? "").trim() || null

    const currentInputTokens = existing.input_tokens ?? null
    const currentCachedInputTokens = existing.cached_input_tokens ?? null
    const currentOutputTokens = existing.output_tokens ?? null
    const currentTotalTokens = existing.total_tokens ?? null
    const currentBillableTokens = existing.billable_tokens ?? null
    const currentReasoningOutputTokens = existing.reasoning_output_tokens ?? null
    const currentEstimatedCostUsd = normalizeNonNegativeNumber(existing.estimated_cost_usd)
    const currentReasoningEffort = String(existing.reasoning_effort ?? "").trim() || null

    const nothingChanged =
      resolvedInputTokens === currentInputTokens &&
      resolvedCachedInputTokens === currentCachedInputTokens &&
      resolvedOutputTokens === currentOutputTokens &&
      resolvedTotalTokens === currentTotalTokens &&
      resolvedBillableTokens === currentBillableTokens &&
      resolvedReasoningOutputTokens === currentReasoningOutputTokens &&
      resolvedEstimatedCostUsd === currentEstimatedCostUsd &&
      resolvedReasoningEffort === currentReasoningEffort

    if (nothingChanged) return

    const deltaInputTokens = (resolvedInputTokens ?? 0) - (currentInputTokens ?? 0)
    const deltaCachedInputTokens = (resolvedCachedInputTokens ?? 0) - (currentCachedInputTokens ?? 0)
    const deltaOutputTokens = (resolvedOutputTokens ?? 0) - (currentOutputTokens ?? 0)
    const deltaTotalTokens = (resolvedTotalTokens ?? 0) - (currentTotalTokens ?? 0)
    const deltaBillableTokens = (resolvedBillableTokens ?? 0) - (currentBillableTokens ?? 0)
    const deltaReasoningOutputTokens = (resolvedReasoningOutputTokens ?? 0) - (currentReasoningOutputTokens ?? 0)
    const deltaEstimatedCostUsd = (resolvedEstimatedCostUsd ?? 0) - (currentEstimatedCostUsd ?? 0)
    const deltaPricedTokens =
      (resolvedEstimatedCostUsd != null && (resolvedTotalTokens ?? 0) > 0 ? resolvedTotalTokens ?? 0 : 0) -
      (currentEstimatedCostUsd != null && (currentTotalTokens ?? 0) > 0 ? currentTotalTokens ?? 0 : 0)
    const deltaUnpricedRequestCount =
      (resolvedTotalTokens != null && resolvedTotalTokens > 0 && resolvedEstimatedCostUsd == null ? 1 : 0) -
      (currentTotalTokens != null && currentTotalTokens > 0 && currentEstimatedCostUsd == null ? 1 : 0)
    const dayKey = toLocalDayKey(existing.at)
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `
            UPDATE request_audits
            SET
              input_tokens = ?,
              cached_input_tokens = ?,
              output_tokens = ?,
              total_tokens = ?,
              billable_tokens = ?,
              reasoning_output_tokens = ?,
              estimated_cost_usd = ?,
              reasoning_effort = ?
            WHERE id = ?
          `,
        )
        .run(
          resolvedInputTokens,
          resolvedCachedInputTokens,
          resolvedOutputTokens,
          resolvedTotalTokens,
          resolvedBillableTokens,
          resolvedReasoningOutputTokens,
          resolvedEstimatedCostUsd,
          resolvedReasoningEffort,
          auditId,
        )
      this.db
        .query(
          `
            UPDATE request_token_stats
            SET
              input_tokens = input_tokens + ?,
              cached_input_tokens = cached_input_tokens + ?,
              output_tokens = output_tokens + ?,
              total_tokens = total_tokens + ?,
              billable_tokens = billable_tokens + ?,
              priced_tokens = MAX(0, priced_tokens + ?),
              reasoning_output_tokens = reasoning_output_tokens + ?,
              estimated_cost_usd = MAX(0, estimated_cost_usd + ?),
              unpriced_request_count = MAX(0, unpriced_request_count + ?),
              updated_at = ?
            WHERE day_key = ?
          `,
        )
        .run(
          deltaInputTokens,
          deltaCachedInputTokens,
          deltaOutputTokens,
          deltaTotalTokens,
          deltaBillableTokens,
          deltaPricedTokens,
          deltaReasoningOutputTokens,
          deltaEstimatedCostUsd,
          deltaUnpricedRequestCount,
          now,
          dayKey,
        )
      this.addGlobalUsageDelta(
        {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedInputTokens: deltaCachedInputTokens,
          reasoningOutputTokens: deltaReasoningOutputTokens,
          pricedTokens: deltaPricedTokens,
          estimatedCostUsd: deltaEstimatedCostUsd,
        },
        now,
      )
    })
    tx()
  }

  backfillRequestAuditEstimatedCosts(
    estimateCostUsd: (audit: {
      id: string
      model: string | null
      inputTokens: number | null
      cachedInputTokens: number | null
      outputTokens: number | null
      totalTokens: number | null
    }) => number | null,
  ) {
    const rows = this.db
      .query<RequestAuditCostBackfillCandidate, []>(
        `
          SELECT
            id,
            at,
            model,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            total_tokens
          FROM request_audits
          WHERE estimated_cost_usd IS NULL
            AND total_tokens IS NOT NULL
            AND total_tokens > 0
        `,
      )
      .all()
    if (rows.length === 0) {
      return {
        scannedCount: 0,
        updatedCount: 0,
      }
    }

    let updatedCount = 0
    const dayDeltas = new Map<string, { pricedTokens: number; estimatedCostUsd: number; unpricedRequestCount: number }>()
    const tx = this.db.transaction(() => {
      const updateStatement = this.db.query(`UPDATE request_audits SET estimated_cost_usd = ? WHERE id = ?`)
      const updateDayStatement = this.db.query(
        `
          UPDATE request_token_stats
          SET
            priced_tokens = MAX(0, priced_tokens + ?),
            estimated_cost_usd = MAX(0, estimated_cost_usd + ?),
            unpriced_request_count = MAX(0, unpriced_request_count + ?),
            updated_at = ?
          WHERE day_key = ?
        `,
      )
      for (const row of rows) {
        const estimatedCostUsd = normalizeNonNegativeNumber(
          estimateCostUsd({
            id: row.id,
            model: row.model ?? null,
            inputTokens: row.input_tokens ?? null,
            cachedInputTokens: row.cached_input_tokens ?? null,
            outputTokens: row.output_tokens ?? null,
            totalTokens: row.total_tokens ?? null,
          }),
        )
        if (estimatedCostUsd == null) continue
        updateStatement.run(estimatedCostUsd, row.id)
        const dayKey = toLocalDayKey(row.at)
        const current = dayDeltas.get(dayKey) ?? { pricedTokens: 0, estimatedCostUsd: 0, unpricedRequestCount: 0 }
        current.pricedTokens += Math.max(0, Math.floor(Number(row.total_tokens ?? 0)))
        current.estimatedCostUsd += estimatedCostUsd
        current.unpricedRequestCount -= row.total_tokens != null && row.total_tokens > 0 ? 1 : 0
        dayDeltas.set(dayKey, current)
        updatedCount += 1
      }
      if (updatedCount > 0) {
        const now = Date.now()
        for (const [dayKey, delta] of dayDeltas.entries()) {
          updateDayStatement.run(
            delta.pricedTokens,
            delta.estimatedCostUsd,
            delta.unpricedRequestCount,
            now,
            dayKey,
          )
        }
      }
    })
    tx()
    return {
      scannedCount: rows.length,
      updatedCount,
    }
  }

  listRequestAudits(limit = 200) {
    return this.listRequestAuditsPaginated({ page: 1, pageSize: limit }).items
  }

  listRequestAuditsPaginated(params: RequestAuditListParams = {}): RequestAuditListResult {
    const page = normalizeAuditPage(params.page, 1)
    const pageSize = normalizeAuditPageSize(params.pageSize, 200)
    const offset = (page - 1) * pageSize
    const filters = buildRequestAuditFilters(params.query, params.statusFilter)
    const countRow =
      (this.db
        .query(
          `
            SELECT COUNT(*) AS total
            FROM request_audits
            ${filters.whereClause}
          `,
        )
        .get(...filters.params) as { total: number } | null) ?? { total: 0 }
    const rows = this.db
      .query(
        `
          SELECT *
          FROM request_audits
          ${filters.whereClause}
          ORDER BY at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...filters.params, pageSize, offset) as RequestAuditRow[]

    return {
      items: rows.map(mapRequestAuditRow),
      total: Math.max(0, Math.floor(Number(countRow.total ?? 0))),
      page,
      pageSize,
    }
  }

  summarizeRequestAudits(params: Pick<RequestAuditListParams, "query" | "statusFilter"> = {}): RequestAuditFilterSummary {
    const filters = buildRequestAuditFilters(params.query, params.statusFilter)
    const totalCountRow =
      (this.db
        .query(`SELECT COUNT(*) AS total FROM request_audits`)
        .get() as { total: number } | null) ?? { total: 0 }
    const summaryRow =
      (this.db
        .query(
          `
            SELECT
              COUNT(*) AS filtered_count,
              COALESCE(SUM(${REQUEST_AUDIT_SUCCESS_SQL}), 0) AS success_count,
              COALESCE(SUM(${REQUEST_AUDIT_ERROR_SQL}), 0) AS error_count,
              COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND input_tokens > 0 THEN input_tokens ELSE 0 END), 0) AS input_tokens,
              COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL AND cached_input_tokens > 0 THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
              COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL AND output_tokens > 0 THEN output_tokens ELSE 0 END), 0) AS output_tokens,
              COALESCE(SUM(${REQUEST_AUDIT_TOTAL_TOKENS_SQL}), 0) AS total_tokens,
              COALESCE(SUM(${REQUEST_AUDIT_BILLABLE_TOKENS_SQL}), 0) AS billable_tokens,
              COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL AND ${REQUEST_AUDIT_TOTAL_TOKENS_SQL} > 0 THEN ${REQUEST_AUDIT_TOTAL_TOKENS_SQL} ELSE 0 END), 0) AS priced_tokens,
              COALESCE(SUM(CASE WHEN reasoning_output_tokens IS NOT NULL AND reasoning_output_tokens > 0 THEN reasoning_output_tokens ELSE 0 END), 0) AS reasoning_output_tokens,
              COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL AND estimated_cost_usd > 0 THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd,
              COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL AND total_tokens > 0 AND estimated_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_request_count
            FROM request_audits
            ${filters.whereClause}
          `,
        )
        .get(...filters.params) as
        | {
            filtered_count: number
            success_count: number
            error_count: number
            input_tokens: number
            cached_input_tokens: number
            output_tokens: number
            total_tokens: number
            billable_tokens: number
            priced_tokens: number
            reasoning_output_tokens: number
            estimated_cost_usd: number
            unpriced_request_count: number
          }
        | null) ?? {
        filtered_count: 0,
        success_count: 0,
        error_count: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        billable_tokens: 0,
        priced_tokens: 0,
        reasoning_output_tokens: 0,
        estimated_cost_usd: 0,
        unpriced_request_count: 0,
      }

    return {
      totalCount: Math.max(0, Math.floor(Number(totalCountRow.total ?? 0))),
      filteredCount: Math.max(0, Math.floor(Number(summaryRow.filtered_count ?? 0))),
      successCount: Math.max(0, Math.floor(Number(summaryRow.success_count ?? 0))),
      errorCount: Math.max(0, Math.floor(Number(summaryRow.error_count ?? 0))),
      inputTokens: Math.max(0, Math.floor(Number(summaryRow.input_tokens ?? 0))),
      cachedInputTokens: Math.max(0, Math.floor(Number(summaryRow.cached_input_tokens ?? 0))),
      outputTokens: Math.max(0, Math.floor(Number(summaryRow.output_tokens ?? 0))),
      totalTokens: Math.max(0, Math.floor(Number(summaryRow.total_tokens ?? 0))),
      billableTokens: Math.max(0, Math.floor(Number(summaryRow.billable_tokens ?? 0))),
      pricedTokens: Math.max(0, Math.floor(Number(summaryRow.priced_tokens ?? 0))),
      reasoningOutputTokens: Math.max(0, Math.floor(Number(summaryRow.reasoning_output_tokens ?? 0))),
      estimatedCostUsd: Math.max(0, Number(summaryRow.estimated_cost_usd ?? 0)),
      unpricedRequestCount: Math.max(0, Math.floor(Number(summaryRow.unpriced_request_count ?? 0))),
    }
  }

  getRequestTokenStatsDay(dayKey: string) {
    const normalizedDayKey = String(dayKey ?? "").trim()
    if (!normalizedDayKey) return null
    const row = this.db
      .query<RequestTokenStatsDayRow, [string]>(
        `
          SELECT *
          FROM request_token_stats
          WHERE day_key = ?
          LIMIT 1
        `,
      )
      .get(normalizedDayKey)
    return mapRequestTokenStatsDayRow(row)
  }

  getTodayRequestTokenStats(now = Date.now()) {
    return this.getRequestTokenStatsDay(toLocalDayKey(normalizeAuditTimestamp(now)))
  }

  getTodayRequestTokenStatsSummary(now = Date.now()): RequestTokenStatsDaySummary {
    const timestamp = normalizeAuditTimestamp(now)
    const stats = this.getTodayRequestTokenStats(timestamp)
    return {
      stats,
      unpricedRequestCount: Math.max(0, Math.floor(Number(stats?.unpricedRequestCount ?? 0))),
    }
  }

  listRequestTokenStatsDays(limit = 30) {
    const safeLimit = normalizeAuditPageSize(limit, 30)
    const rows = this.db
      .query<RequestTokenStatsDayRow, [number]>(
        `
          SELECT *
          FROM request_token_stats
          ORDER BY day_key DESC
          LIMIT ?
        `,
      )
      .all(safeLimit)
    return rows.flatMap((row) => {
      const record = mapRequestTokenStatsDayRow(row)
      return record ? [record] : []
    })
  }

  clearRequestAudits() {
    this.db.query(`DELETE FROM request_audits`).run()
  }

  private setActiveById(id: string) {
    const row = this.db.query<{ provider_id: string }, [string]>(`SELECT provider_id FROM accounts WHERE id = ?`).get(id)
    if (!row) return
    this.db.query(`UPDATE accounts SET is_active = 0 WHERE provider_id = ?`).run(row.provider_id)
    this.db.query(`UPDATE accounts SET is_active = 1 WHERE id = ?`).run(id)
  }
}
