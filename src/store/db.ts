import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import type { LoginResult, StoredAccount } from "../types"
import { isSecretEncryptionEnabled, openSecret, sealSecret } from "../security/secrets"

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

export type VirtualApiKeyRecord = {
  id: string
  accountId: string | null
  providerId: string
  routingMode: VirtualKeyRoutingMode
  name: string | null
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
}

type VirtualApiKeyRow = {
  id: string
  account_id: string | null
  name: string | null
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
}

type TableInfoRow = {
  name: string
  notnull: number
}

type GlobalUsageTotalsRow = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  updated_at: number
}

export type UsageTotals = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
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
    name: row.name,
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

export class AccountStore {
  private readonly db: Database

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
        name TEXT,
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

      CREATE TABLE IF NOT EXISTS request_audits (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        route TEXT NOT NULL,
        method TEXT NOT NULL,
        provider_id TEXT,
        account_id TEXT,
        virtual_key_id TEXT,
        model TEXT,
        session_id TEXT,
        request_hash TEXT NOT NULL,
        request_bytes INTEGER NOT NULL DEFAULT 0,
        response_bytes INTEGER NOT NULL DEFAULT 0,
        status_code INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        upstream_request_id TEXT,
        error_text TEXT,
        client_tag TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_audits_at ON request_audits(at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_audits_account ON request_audits(account_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_audits_key ON request_audits(virtual_key_id, at DESC);

      CREATE TABLE IF NOT EXISTS global_usage_totals (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
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
    this.ensureVirtualKeyColumn("prompt_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureVirtualKeyColumn("completion_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureVirtualKeyColumn("total_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.ensureVirtualKeyColumn("expires_at", "INTEGER")
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_virtual_api_keys_provider ON virtual_api_keys(provider_id);`)
    this.ensureGlobalUsageTotals()
    this.migrateSecretsToEncrypted()
  }

  private migrateSecretsToEncrypted() {
    if (!isSecretEncryptionEnabled()) return

    const accountRows = this.db
      .query<{ id: string; access_token: string; refresh_token: string | null }, []>(
        `SELECT id, access_token, refresh_token FROM accounts`,
      )
      .all()
    const updateAccount = this.db.query(`UPDATE accounts SET access_token = ?, refresh_token = ? WHERE id = ?`)
    for (const row of accountRows) {
      const accessToken = sealSecret(openSecret(row.access_token))
      const refreshToken = sealSecret(openSecret(row.refresh_token))
      updateAccount.run(accessToken, refreshToken, row.id)
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
    const columns = this.db.query<{ name: string }, []>(`PRAGMA table_info(accounts)`).all()
    if (columns.some((column) => column.name === name)) return
    this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${definition};`)
  }

  private ensureVirtualKeyColumn(name: string, definition: string) {
    const columns = this.db.query<{ name: string }, []>(`PRAGMA table_info(virtual_api_keys)`).all()
    if (columns.some((column) => column.name === name)) return
    this.db.exec(`ALTER TABLE virtual_api_keys ADD COLUMN ${name} ${definition};`)
  }

  private ensureVirtualKeysSchemaV2() {
    const columns = this.db.query<TableInfoRow, []>(`PRAGMA table_info(virtual_api_keys)`).all()
    if (!columns.length) return

    const accountColumn = columns.find((column) => column.name === "account_id")
    const hasProvider = columns.some((column) => column.name === "provider_id")
    const hasRouting = columns.some((column) => column.name === "routing_mode")
    const hasKeySecret = columns.some((column) => column.name === "key_secret")
    const hasPromptTokens = columns.some((column) => column.name === "prompt_tokens")
    const hasCompletionTokens = columns.some((column) => column.name === "completion_tokens")
    const hasTotalTokens = columns.some((column) => column.name === "total_tokens")
    const hasExpiresAt = columns.some((column) => column.name === "expires_at")
    const needsNullableAccount = accountColumn?.notnull === 1

    if (!needsNullableAccount && hasProvider && hasRouting && hasKeySecret && hasPromptTokens && hasCompletionTokens && hasTotalTokens && hasExpiresAt) return

    const providerExpr = hasProvider ? "COALESCE(provider_id, 'chatgpt')" : "'chatgpt'"
    const routingExpr = hasRouting ? "CASE WHEN routing_mode = 'pool' THEN 'pool' ELSE 'single' END" : "'single'"
    const keySecretExpr = hasKeySecret ? "key_secret" : "NULL"
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
        name TEXT,
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
        name,
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
        name,
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

    const now = Date.now()
    this.db
      .query(
        `
          INSERT INTO global_usage_totals (
            id,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            updated_at
          ) VALUES (1, ?, ?, ?, ?)
        `,
      )
      .run(
        Math.max(0, Math.floor(Number(baseline.prompt_tokens ?? 0))),
        Math.max(0, Math.floor(Number(baseline.completion_tokens ?? 0))),
        Math.max(0, Math.floor(Number(baseline.total_tokens ?? 0))),
        now,
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
              expires_at,
              metadata_json,
              created_at,
              updated_at,
              is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
      expiresAt: input.expiresAt ?? undefined,
      metadata: input.metadata,
    })
  }

  createVirtualApiKey(input: {
    accountId?: string | null
    name?: string | null
    providerId?: string
    routingMode?: VirtualKeyRoutingMode
    validityDays?: number | null
  }) {
    const providerId = input.providerId ?? "chatgpt"
    const routingMode = input.routingMode ?? "single"
    const accountId = input.accountId ?? null

    if (routingMode === "single") {
      if (!accountId) throw new Error("Account is required for single-route virtual key")
      const account = this.get(accountId)
      if (!account) throw new Error("Account not found")
      if (account.providerId !== providerId) {
        throw new Error("Account provider does not match virtual key provider")
      }
    } else {
      const accounts = this.getAvailableAccountsForProvider(providerId)
      if (accounts.length === 0) throw new Error("No available accounts for pool routing")
      if (accountId) {
        const account = this.get(accountId)
        if (!account) throw new Error("Account not found")
        if (account.providerId !== providerId) {
          throw new Error("Account provider does not match virtual key provider")
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
            name,
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, NULL, ?, ?)
        `,
      )
      .run(id, accountId, providerId, routingMode, input.name ?? null, hash, sealSecret(secret), keyPrefix, expiresAt, now, now)

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
      routeOptionsFactory?: (
        key: Pick<VirtualApiKeyRecord, "id" | "providerId" | "routingMode">,
      ) =>
        | {
            excludeAccountIds?: string[]
            deprioritizedAccountIds?: string[]
            headroomByAccountId?: Map<string, number>
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
    const routeOptions = {
      excludeAccountIds,
      deprioritizedAccountIds,
      headroomByAccountId,
    }
    const account =
      key.routingMode === "pool"
        ? this.pickPoolAccountForKey(key.id, key.providerId, sessionId, routeOptions)
        : this.getSingleRouteAccount(key.providerId, key.accountId)

    if (!account) return null
    return {
      key,
      account,
    }
  }

  private getSingleRouteAccount(providerId: string, accountID: string | null) {
    if (!accountID) return null
    const account = this.get(accountID)
    if (!account) return null
    if (account.providerId !== providerId) return null
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
    },
  ) {
    if (sessionId) {
      const sticky = this.pickSessionStickyAccount(keyID, providerId, sessionId)
      if (sticky) return sticky
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
    const row = this.db
      .query<VirtualKeySessionRow, [string, string]>(
        `
          SELECT key_id, session_id, account_id, request_count, last_used_at
          FROM virtual_key_sessions
          WHERE key_id = ? AND session_id = ?
          LIMIT 1
        `,
      )
      .get(keyID, sessionId)
    if (!row) return null

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
    },
  ) {
    const excluded = options?.excludeAccountIds ?? new Set<string>()
    const deprioritized = options?.deprioritizedAccountIds ?? new Set<string>()
    const headroomByAccountId = options?.headroomByAccountId ?? new Map<string, number>()
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
            return `${account.id}{deprioritized=${deprioritized.has(account.id)},headroom=${headroom ?? "-"},count=${
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
  }) {
    const sessionId = normalizeSessionRouteID(input.sessionId)
    if (!sessionId) return null

    const excluded = new Set<string>([input.failedAccountId, ...(input.excludeAccountIds ?? [])])
    const selected = this.pickPoolAccountCandidate(input.keyId, input.providerId, {
      excludeAccountIds: excluded,
      deprioritizedAccountIds: new Set(input.deprioritizedAccountIds ?? []),
      headroomByAccountId: input.headroomByAccountId,
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
  }) {
    const excluded = new Set<string>([input.failedAccountId, ...(input.excludeAccountIds ?? [])])
    const selected = this.pickPoolAccountCandidate(input.keyId, input.providerId, {
      excludeAccountIds: excluded,
      deprioritizedAccountIds: new Set(input.deprioritizedAccountIds ?? []),
      headroomByAccountId: input.headroomByAccountId,
    })
    if (!selected) return null

    this.touchVirtualKeyRoute(input.keyId, selected.id)
    return selected
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

  updateTokens(input: { id: string; accessToken: string; refreshToken?: string; expiresAt?: number; accountId?: string | null }) {
    const row = this.get(input.id)
    if (!row) throw new Error("Account not found")
    this.db
      .query(
        `
          UPDATE accounts
          SET
            access_token = ?,
            refresh_token = ?,
            expires_at = ?,
            account_id = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        sealSecret(input.accessToken),
        sealSecret(input.refreshToken ?? null),
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
          SELECT prompt_tokens, completion_tokens, total_tokens, updated_at
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
      updatedAt: Math.max(0, Math.floor(Number(row?.updated_at ?? 0))),
    }
  }

  private addGlobalUsageDelta(input: { promptTokens: number; completionTokens: number; totalTokens: number }, now = Date.now()) {
    if (input.promptTokens === 0 && input.completionTokens === 0 && input.totalTokens === 0) return
    this.ensureGlobalUsageTotals()
    this.db
      .query(
        `
          UPDATE global_usage_totals
          SET
            prompt_tokens = prompt_tokens + ?,
            completion_tokens = completion_tokens + ?,
            total_tokens = total_tokens + ?,
            updated_at = ?
          WHERE id = 1
        `,
      )
      .run(input.promptTokens, input.completionTokens, input.totalTokens, now)
  }

  addUsage(input: { id: string; promptTokens?: number; completionTokens?: number; totalTokens?: number }) {
    const row = this.get(input.id)
    if (!row) throw new Error("Account not found")
    const promptTokens = Math.max(0, Math.floor(input.promptTokens ?? 0))
    const completionTokens = Math.max(0, Math.floor(input.completionTokens ?? 0))
    const totalTokens = Math.max(0, Math.floor(input.totalTokens ?? promptTokens + completionTokens))
    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return
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
  }) {
    const id = crypto.randomUUID()
    const now = Date.now()
    const requestBytes = Math.max(0, Math.floor(input.requestBytes ?? input.requestBody?.byteLength ?? 0))
    const responseBytes = Math.max(0, Math.floor(input.responseBytes ?? 0))
    const statusCode = Math.max(0, Math.floor(input.statusCode ?? 0))
    const latencyMs = Math.max(0, Math.floor(input.latencyMs ?? 0))
    const requestHash = hashRequestPayload(input.requestBody ?? new Uint8Array(0))
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
            client_tag
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      )
    return id
  }

  listRequestAudits(limit = 200) {
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)))
    const rows = this.db
      .query<RequestAuditRow, [number]>(
        `
          SELECT *
          FROM request_audits
          ORDER BY at DESC
          LIMIT ?
        `,
      )
      .all(safeLimit)

    return rows.map((row): RequestAuditRecord => ({
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
    }))
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
