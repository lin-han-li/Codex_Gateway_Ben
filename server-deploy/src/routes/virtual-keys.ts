import type { Hono } from "hono"

export type VirtualKeysRouteDeps = {
  accountStore: any
  IssueVirtualKeySchema: { parse: (raw: unknown) => any }
  RenameVirtualKeySchema: { parse: (raw: unknown) => any }
  RenewVirtualKeySchema: { parse: (raw: unknown) => any }
  getCachedPoolConsistencyResult: (providerId: string) => any
  hasSensitiveActionConfirmation: (c: any) => boolean
  errorMessage: (error: unknown) => string
}

export function registerVirtualKeysRoutes(app: Hono, deps: VirtualKeysRouteDeps) {
  app.get("/api/virtual-keys", (c) => {
    const accountId = c.req.query("accountId")
    const keys: any[] = deps.accountStore.listVirtualApiKeys(accountId)
    const accounts: any[] = deps.accountStore.list()
    const accountMap = new Map<string, any>(accounts.map((item: any) => [item.id, item]))
    const rows = keys.map((item: any) => {
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
      const input = deps.IssueVirtualKeySchema.parse(raw)
      const normalizedClientMode = input.clientMode === "cursor" ? "cursor" : "codex"
      const normalizedWireApi =
        input.wireApi ??
        (normalizedClientMode === "cursor" ? "chat_completions" : "responses")
      const isValidCombo =
        (normalizedClientMode === "codex" && normalizedWireApi === "responses") ||
        (normalizedClientMode === "cursor" && normalizedWireApi === "chat_completions")
      if (!isValidCombo) {
        return c.json(
          {
            error:
              "Invalid virtual key mode. Codex keys must use responses, and Cursor keys must use chat_completions.",
          },
          400,
        )
      }
      if (input.routingMode === "pool") {
        const cachedPoolConsistency = deps.getCachedPoolConsistencyResult(input.providerId)
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
      const result = deps.accountStore.createVirtualApiKey({
        accountId: input.accountId,
        providerId: input.providerId,
        routingMode: input.routingMode,
        clientMode: normalizedClientMode,
        wireApi: normalizedWireApi,
        name: input.name,
        validityDays: input.validityDays,
      })
      return c.json({
        key: result.key,
        record: result.record,
      })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/name", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.RenameVirtualKeySchema.parse(raw)
      const record = deps.accountStore.renameVirtualApiKey(c.req.param("id"), input.name)
      return c.json({ success: true, record })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/renew", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.RenewVirtualKeySchema.parse(raw)
      const record = deps.accountStore.renewVirtualApiKey(c.req.param("id"), input.validityDays)
      return c.json({ success: true, record })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/revoke", (c) => {
    try {
      deps.accountStore.revokeVirtualApiKey(c.req.param("id"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/restore", (c) => {
    try {
      deps.accountStore.restoreVirtualApiKey(c.req.param("id"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/reveal", (c) => {
    if (!deps.hasSensitiveActionConfirmation(c)) {
      return c.json({ error: "Sensitive action confirmation required" }, 400)
    }
    try {
      const id = c.req.param("id")
      const key = deps.accountStore.revealVirtualApiKey(id)
      if (!key) return c.json({ error: "Virtual API key not found" }, 404)
      if (String(key).startsWith("encv1:")) {
        return c.json({ error: "Virtual API key cannot be decrypted. Please renew or issue a new key." }, 409)
      }
      return c.json({ key })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.delete("/api/virtual-keys/:id", (c) => {
    try {
      deps.accountStore.deleteVirtualApiKey(c.req.param("id"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })
}
