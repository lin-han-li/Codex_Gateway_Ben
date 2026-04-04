import type { Hono } from "hono"

export type BridgeRouteDeps = {
  accountStore: any
  parseSyncOAuthInput: (raw: unknown) => any
  parseJwtAuthClaims: (token?: string | null) => any
  normalizeIdentity: (value: any) => string | null | undefined
  ensureForcedWorkspaceAllowed: (accountId?: string | null) => void
  buildOAuthIdentity: (input: { email?: string; accountId?: string | null }) => string
  invalidatePoolConsistency: (providerId: string, input?: { account?: any }) => void
  handleBackgroundPromise: (label: string, promise: Promise<unknown>) => void
  refreshAndEmitAccountQuota: (accountId: string, source: string) => Promise<void>
  errorMessage: (error: unknown) => string
}

export function registerBridgeRoutes(app: Hono, deps: BridgeRouteDeps) {
  app.post("/api/bridge/oauth/sync", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.parseSyncOAuthInput(raw)
      const accessTokenClaims = deps.parseJwtAuthClaims(input.accessToken)
      const resolvedAccountId =
        deps.normalizeIdentity(input.accountId) ||
        deps.normalizeIdentity(accessTokenClaims?.chatgpt_account_id)
      const resolvedOrganizationId =
        deps.normalizeIdentity(input.organizationId) ||
        deps.normalizeIdentity(accessTokenClaims?.organization_id)
      const resolvedProjectId =
        deps.normalizeIdentity(input.projectId) ||
        deps.normalizeIdentity(accessTokenClaims?.project_id)
      const resolvedChatgptPlanType =
        deps.normalizeIdentity(input.chatgptPlanType) ||
        deps.normalizeIdentity(accessTokenClaims?.chatgpt_plan_type)
      const resolvedChatgptUserId =
        deps.normalizeIdentity(input.chatgptUserId) ||
        deps.normalizeIdentity(accessTokenClaims?.chatgpt_user_id) ||
        deps.normalizeIdentity(accessTokenClaims?.user_id)
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
        deps.ensureForcedWorkspaceAllowed(resolvedAccountId)
      }

      const identity = deps.buildOAuthIdentity({
        email: input.email,
        accountId: resolvedAccountId,
      })
      const displayName =
        input.displayName || input.email || resolvedAccountId || "Codex OAuth Account"
      const accountID = deps.accountStore.saveBridgeOAuth({
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
      const syncedAccount = deps.accountStore.get(accountID)
      deps.invalidatePoolConsistency(
        input.providerId,
        syncedAccount ? { account: syncedAccount } : undefined,
      )
      deps.handleBackgroundPromise(
        "refreshAndEmitAccountQuota:bridge-oauth-sync",
        deps.refreshAndEmitAccountQuota(accountID, "bridge-oauth-sync"),
      )

      const account = deps.accountStore.get(accountID)
      let virtualKey: { key: string; record: unknown } | undefined
      if (input.issueVirtualKey) {
        const issued = deps.accountStore.createVirtualApiKey({
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
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })
}
