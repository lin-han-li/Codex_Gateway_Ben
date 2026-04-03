import type { Hono } from "hono"
import type { StoredAccount } from "../types"

type AccountStoreLike = {
  list: () => StoredAccount[]
  get: (id: string) => StoredAccount | null
  delete: (id: string) => void
  activate: (id: string) => void
  updateTokens: (input: {
    id: string
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    accountId?: string | null
  }) => void
  saveBridgeOAuth: (input: {
    providerId: string
    providerName: string
    methodId: string
    displayName: string
    accountKey: string
    email?: string
    accountId?: string | null
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    metadata?: Record<string, unknown>
  }) => string
  createVirtualApiKey: (input: {
    accountId?: string
    providerId?: string
    routingMode?: "single" | "pool"
    clientMode?: "codex" | "cursor"
    wireApi?: "responses" | "chat_completions"
    name?: string | null
    validityDays?: number | null
  }) => {
    key: string
    record: unknown
  }
}

type ProviderStoreLike = {
  getProvider: (providerId: string) => any
}

export type AccountRouteDeps = {
  accountStore: AccountStoreLike
  providers: ProviderStoreLike
  accountQuotaCache: Map<string, unknown>
  accountHealthCache: Map<string, unknown>
  refreshAccountQuotaCache: (
    accounts: StoredAccount[],
    input: { force?: boolean; targetAccountID?: string | null },
  ) => Promise<void>
  refreshAndEmitAccountQuota: (accountId: string, source: string) => Promise<void>
  toPublicAccount: (account: StoredAccount, quota: any) => unknown
  getUsageTotalsSnapshot: () => unknown
  buildDashboardMetrics: () => unknown
  emitAccountRateLimitsUpdated: (input: any) => void
  resolvePublicAccountDerivedState: (accountId: string, quota: any) => {
    abnormalState?: {
      deleteEligible?: boolean
      reason?: string
    } | null
  }
  deleteAccountsWithSingleRouteKeys: (
    accounts: StoredAccount[],
  ) => {
    deletedVirtualKeyCount: number
  }
  buildApiKeyIdentity: (apiKey: string) => string
  normalizeIdentity: (value: any) => string | null | undefined
  exportStoredOAuthAccount: (account: StoredAccount) => unknown
  importJsonOAuthAccount: (input: any) => {
    account: unknown
    virtualKey?: { key: string; record: unknown }
  }
  importRefreshTokenOAuthAccount: (input: any) => Promise<{
    account: unknown
    virtualKey?: { key: string; record: unknown }
    refreshed: boolean
  }>
  invalidatePoolConsistency: (
    providerId: string,
    input?: { account?: StoredAccount },
  ) => void
  evictAccountModelsCache: (accountId: string) => void
  handleBackgroundPromise: (label: string, promise: Promise<unknown>) => void
  markAccountHealthy: (accountId: string, source: string) => void
  markAccountUnhealthy: (accountId: string, reason: string, source: string) => void
  detectRoutingBlockedAccount: (input: { error: unknown }) => {
    matched: boolean
    reason?: string
  }
  errorMessage: (error: unknown) => string
  hasSensitiveActionConfirmation: (c: any) => boolean
  parseBulkDeleteAccounts: (raw: unknown) => {
    ids: string[]
    accountIds: string[]
  }
  parseAddApiKeyAccount: (raw: unknown) => {
    providerId: string
    providerName: string
    methodId: string
    displayName?: string
    apiKey: string
    organizationId?: string
    projectId?: string
  }
  parseExportAccounts: (raw: unknown) => {
    ids?: string[]
  }
  parseImportJsonAccount: (raw: unknown) => unknown
  parseImportRtAccount: (raw: unknown) => unknown
}

export function registerAccountRoutes(app: Hono, deps: AccountRouteDeps) {
  app.get("/api/accounts", async (c) => {
    const refreshQuota = String(c.req.query("refreshQuota") ?? "").trim() === "1"
    const forceQuota = String(c.req.query("forceQuota") ?? "").trim() === "1"
    const targetAccountID = String(c.req.query("accountId") ?? "").trim() || null
    const accounts = deps.accountStore.list()
    if (refreshQuota) {
      await deps.refreshAccountQuotaCache(accounts, {
        force: forceQuota,
        targetAccountID,
      })
    }
    return c.json({
      accounts: accounts.map((account) =>
        deps.toPublicAccount(account, deps.accountQuotaCache.get(account.id) ?? null),
      ),
      usageTotals: deps.getUsageTotalsSnapshot(),
      dashboardMetrics: deps.buildDashboardMetrics(),
    })
  })

  app.post("/api/accounts/:id/refresh-quota", async (c) => {
    const accountID = c.req.param("id")
    const account = deps.accountStore.get(accountID)
    if (!account) return c.json({ error: "Account not found" }, 404)

    try {
      await deps.refreshAccountQuotaCache([account], {
        force: true,
        targetAccountID: accountID,
      })
      const quota = deps.accountQuotaCache.get(accountID) ?? null
      if (quota) {
        deps.emitAccountRateLimitsUpdated({
          accountId: accountID,
          source: "manual-refresh",
          quota,
        })
      }
      return c.json({
        success: true,
        account: deps.toPublicAccount(deps.accountStore.get(accountID) ?? account, quota),
        dashboardMetrics: deps.buildDashboardMetrics(),
      })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.get("/api/accounts/:id/refresh-token", (c) => {
    if (!deps.hasSensitiveActionConfirmation(c)) {
      return c.json({ error: "Sensitive action confirmation required" }, 400)
    }
    const account = deps.accountStore.get(c.req.param("id"))
    if (!account) return c.json({ error: "Account not found" }, 404)
    return c.json({
      refreshToken: account.refreshToken ?? "",
      hasRefreshToken: Boolean(account.refreshToken),
    })
  })

  app.post("/api/accounts/bulk-delete", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.parseBulkDeleteAccounts(raw)
      const uniqueIds = [
        ...new Set(
          [...input.ids, ...input.accountIds].map((item) => String(item || "").trim()).filter(Boolean),
        ),
      ]
      const skipped: Array<{ id: string; reason: string }> = []
      const deletableAccounts: StoredAccount[] = []

      for (const id of uniqueIds) {
        const account = deps.accountStore.get(id)
        if (!account) {
          skipped.push({ id, reason: "account_not_found" })
          continue
        }
        const derived = deps.resolvePublicAccountDerivedState(
          account.id,
          deps.accountQuotaCache.get(account.id) ?? null,
        )
        if (!derived.abnormalState?.deleteEligible) {
          skipped.push({ id, reason: derived.abnormalState?.reason || "not_delete_eligible" })
          continue
        }
        deletableAccounts.push(account)
      }

      const { deletedVirtualKeyCount } = deps.deleteAccountsWithSingleRouteKeys(deletableAccounts)
      return c.json({
        requestedCount: uniqueIds.length,
        deletedAccountCount: deletableAccounts.length,
        deletedVirtualKeyCount,
        skipped,
      })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/accounts/api-key", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.parseAddApiKeyAccount(raw)
      const keyIdentity = deps.buildApiKeyIdentity(input.apiKey)
      const keySuffix = input.apiKey.slice(-4)
      const displayName = input.displayName || `OpenAI API Key (${keySuffix})`
      const accountID = deps.accountStore.saveBridgeOAuth({
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
          organizationId: deps.normalizeIdentity(input.organizationId),
          projectId: deps.normalizeIdentity(input.projectId),
        },
      })
      const account = deps.accountStore.get(accountID)
      deps.invalidatePoolConsistency(input.providerId, account ? { account } : undefined)
      return c.json({
        success: true,
        account,
      })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/accounts/export-json", async (c) => {
    if (!deps.hasSensitiveActionConfirmation(c)) {
      return c.json({ error: "Sensitive action confirmation required" }, 400)
    }
    try {
      const raw = await c.req.json().catch(() => ({}))
      const input = deps.parseExportAccounts(raw)
      const selectedIds = new Set((input.ids ?? []).map((item) => String(item).trim()).filter(Boolean))
      const accounts = deps.accountStore
        .list()
        .filter(
          (account) =>
            account.providerId === "chatgpt" &&
            account.methodId !== "api-key" &&
            Boolean(account.accessToken),
        )
        .filter((account) => selectedIds.size === 0 || selectedIds.has(account.id))

      const records = accounts.map((account) => deps.exportStoredOAuthAccount(account))
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
      return c.json({ error: deps.errorMessage(error) }, 400)
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
        account?: unknown
        virtualKey?: { key: string; record: unknown }
        error?: string
      }> = []

      for (const [index, input] of entries.entries()) {
        try {
          const parsed = deps.parseImportJsonAccount(input)
          const imported = deps.importJsonOAuthAccount(parsed)
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
            error: deps.errorMessage(error),
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
      return c.json({ error: deps.errorMessage(error) }, 400)
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
        account?: unknown
        virtualKey?: { key: string; record: unknown }
        refreshed?: boolean
        error?: string
      }> = []

      let importedCount = 0
      let failedCount = 0
      let refreshedCount = 0

      for (const [index, entry] of entries.entries()) {
        try {
          const parsed = deps.parseImportRtAccount(entry)
          const imported = await deps.importRefreshTokenOAuthAccount(parsed)
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
            error: deps.errorMessage(error),
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
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/accounts/:id/activate", (c) => {
    try {
      deps.accountStore.activate(c.req.param("id"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/accounts/:id/refresh", async (c) => {
    const accountID = c.req.param("id")
    try {
      const account = deps.accountStore.get(accountID)
      if (!account) return c.json({ error: "Account not found" }, 404)

      const provider = deps.providers.getProvider(account.providerId)
      if (!provider?.refresh) {
        return c.json({ error: `Provider ${account.providerId} does not support refresh in this flow` }, 400)
      }

      const result = await provider.refresh(account)
      if (!result) {
        deps.markAccountUnhealthy(accountID, "refresh_token_missing", "account-refresh")
        return c.json({ error: "No refresh token available for this account" }, 400)
      }

      deps.accountStore.updateTokens({
        id: accountID,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        accountId: result.accountId ?? account.accountId,
      })
      deps.markAccountHealthy(accountID, "account-refresh")
      const refreshedAccount = deps.accountStore.get(accountID)
      deps.invalidatePoolConsistency(account.providerId, refreshedAccount ? { account: refreshedAccount } : undefined)
      deps.handleBackgroundPromise(
        "refreshAndEmitAccountQuota:account-refresh",
        deps.refreshAndEmitAccountQuota(accountID, "account-refresh"),
      )

      return c.json({
        success: true,
        account: deps.accountStore.get(accountID),
      })
    } catch (error) {
      const blocked = deps.detectRoutingBlockedAccount({
        error,
      })
      if (blocked.matched) {
        deps.markAccountUnhealthy(accountID, blocked.reason || "routing_blocked", "account-refresh")
      }
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.delete("/api/accounts/:id", (c) => {
    const accountID = c.req.param("id")
    const account = deps.accountStore.get(accountID)
    if (account) {
      const { deletedVirtualKeyCount } = deps.deleteAccountsWithSingleRouteKeys([account])
      return c.json({ success: true, deletedVirtualKeyCount })
    }
    deps.accountStore.delete(accountID)
    deps.accountQuotaCache.delete(accountID)
    deps.accountHealthCache.delete(accountID)
    deps.evictAccountModelsCache(accountID)
    return c.json({ success: true, deletedVirtualKeyCount: 0 })
  })
}
