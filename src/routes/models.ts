import type { Hono } from "hono"

export type ModelsRouteDeps = {
  resolveChatModelList: () => Array<Record<string, unknown>>
  resolveDefaultChatModelId?: () => string
  resolveVirtualKeyContext: (
    c: any,
    options?: {
      expectedClientMode?: "codex" | "cursor"
      expectedWireApi?: "responses" | "chat_completions"
      bodySessionId?: string | null
      requestedModel?: string | null
    },
  ) => any
  ensureResolvedPoolAccountConsistent: (input: {
    resolved: any
    sessionId?: string | null
    requestedModel?: string | null
  }) => Promise<any>
  behaviorController: {
    acquire: (input: any) => Promise<any>
  }
  resolveBehaviorSignal: (headers: Headers) => any
  proxyOpenAIModelsRequest: (input: {
    account: any
    requestUrl: string
    requestHeaders: Headers
    routeTag: string
    modelId?: string
  }) => Promise<Response>
  getModelsSnapshot: (input: {
    account: any
    requestUrl?: string
    requestHeaders?: Headers
  }) => Promise<any>
  extractModelEntryID: (item: any) => string | null
  resolveUpstreamProfileForAccount: (account: any) => { providerMode: string }
  normalizeCaughtCodexFailure: (input: { error: unknown; routingMode: string }) => { bodyText: string; status: number; headers: HeadersInit } | null
  getStatusErrorCode: (error: unknown) => number | null
  errorMessage: (error: unknown) => string
  isLikelyAuthError: (error: unknown) => boolean
  resolveModelCatalogForCursorAccount: (input: {
    account: any
    requestUrl?: string
    requestHeaders?: Headers
  }) => Promise<any>
  toOpenAICompatibleErrorResponse: (message: string, status?: number, type?: string) => Response
}

function toBehaviorAcquireResponse(decision: any) {
  const retryAfterSeconds = decision.retryAfterMs ? Math.max(1, Math.ceil(decision.retryAfterMs / 1000)) : undefined
  return new Response(
    JSON.stringify({
      error: decision.message,
      code: decision.code,
    }),
    {
      status: decision.status,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
      },
    },
  )
}

function resolveFixedModelId(key: { fixedModel?: unknown } | null | undefined) {
  return typeof key?.fixedModel === "string" && key.fixedModel.trim() ? key.fixedModel.trim() : null
}

function buildFilteredModelsPayload(payload: Record<string, unknown>, filteredEntries: unknown[]) {
  const next = { ...payload }
  if (Array.isArray(payload.data)) next.data = filteredEntries
  if (Array.isArray(payload.models)) next.models = filteredEntries
  if (!Array.isArray(payload.data) && !Array.isArray(payload.models)) {
    next.data = filteredEntries
    next.models = filteredEntries
  }
  return next
}

function filterSnapshotToFixedModel(
  snapshot: any,
  fixedModelId: string,
  extractModelEntryID: (item: any) => string | null,
) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
  const filteredEntries = entries.filter((item: unknown) => extractModelEntryID(item) === fixedModelId)
  const payload = buildFilteredModelsPayload(
    snapshot?.payload && typeof snapshot.payload === "object" ? snapshot.payload : {},
    filteredEntries,
  )
  return {
    ...snapshot,
    payload,
    entries: filteredEntries,
    body: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: snapshot?.contentType || "application/json",
  }
}

function filterCursorCatalogToFixedModel(payload: any, fixedModelId: string) {
  const data = Array.isArray(payload?.data) ? payload.data : []
  return {
    ...payload,
    data: data.filter((item: { id?: string }) => String(item?.id || "") === fixedModelId),
  }
}

export function registerModelsRoutes(app: Hono, deps: ModelsRouteDeps) {
  app.get("/api/chat/models", (c) => {
    const models = deps.resolveChatModelList()
    return c.json({
      models,
      defaultModelId: deps.resolveDefaultChatModelId?.() ?? models[0]?.id ?? null,
    })
  })

  app.get("/v1/models", async (c) => {
    const context = deps.resolveVirtualKeyContext(c, {
      expectedClientMode: "codex",
      expectedWireApi: "responses",
    })
    if ("error" in context) {
      return c.json({ error: context.error }, context.status ?? 401)
    }
    const fixedModelId = resolveFixedModelId(context.resolved.key)
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
      sessionId: context.sessionId,
      requestedModel: fixedModelId,
    })
    if (!consistentContext.ok) {
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }
    const resolvedContext = consistentContext.resolved
    const behaviorDecision = await deps.behaviorController.acquire({
      accountId: resolvedContext.account.id,
      signal: deps.resolveBehaviorSignal(c.req.raw.headers),
    })
    if (!behaviorDecision.ok) {
      return toBehaviorAcquireResponse(behaviorDecision)
    }

    const profile = deps.resolveUpstreamProfileForAccount(resolvedContext.account)
    try {
      if (profile.providerMode === "openai") {
        return await deps.proxyOpenAIModelsRequest({
          account: resolvedContext.account,
          requestUrl: c.req.url,
          requestHeaders: c.req.raw.headers,
          routeTag: "/models",
        })
      }
      let snapshot = await deps.getModelsSnapshot({
        account: resolvedContext.account,
        requestUrl: c.req.url,
        requestHeaders: c.req.raw.headers,
      })
      if (fixedModelId) {
        snapshot = filterSnapshotToFixedModel(snapshot, fixedModelId, deps.extractModelEntryID)
      }
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
      const normalizedCaughtFailure = deps.normalizeCaughtCodexFailure({
        error,
        routingMode: resolvedContext.key.routingMode,
      })
      if (normalizedCaughtFailure) {
        return new Response(normalizedCaughtFailure.bodyText, {
          status: normalizedCaughtFailure.status,
          headers: normalizedCaughtFailure.headers,
        })
      }
      const statusCode = deps.getStatusErrorCode(error)
      if (statusCode) {
        return new Response(JSON.stringify({ error: deps.errorMessage(error) }), {
          status: statusCode,
          headers: { "Content-Type": "application/json" },
        })
      }
      return c.json({ error: deps.errorMessage(error) }, deps.isLikelyAuthError(error) ? 401 : 502)
    } finally {
      behaviorDecision.release()
    }
  })

  app.get("/v1/models/:id", async (c) => {
    const id = c.req.param("id")
    const context = deps.resolveVirtualKeyContext(c, {
      expectedClientMode: "codex",
      expectedWireApi: "responses",
      requestedModel: id,
    })
    if ("error" in context) {
      return c.json({ error: context.error }, context.status ?? 401)
    }
    const fixedModelId = resolveFixedModelId(context.resolved.key)
    if (fixedModelId && id !== fixedModelId) {
      return c.json({ error: `Model not found: ${id}` }, 404)
    }
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
      sessionId: context.sessionId,
      requestedModel: fixedModelId ?? id,
    })
    if (!consistentContext.ok) {
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }
    const resolvedContext = consistentContext.resolved
    const profile = deps.resolveUpstreamProfileForAccount(resolvedContext.account)

    const behaviorDecision = await deps.behaviorController.acquire({
      accountId: resolvedContext.account.id,
      signal: deps.resolveBehaviorSignal(c.req.raw.headers),
    })
    if (!behaviorDecision.ok) {
      return toBehaviorAcquireResponse(behaviorDecision)
    }

    let snapshot: any
    try {
      if (profile.providerMode === "openai") {
        return await deps.proxyOpenAIModelsRequest({
          account: resolvedContext.account,
          requestUrl: c.req.url,
          requestHeaders: c.req.raw.headers,
          routeTag: "/models/:id",
          modelId: id,
        })
      }
      snapshot = await deps.getModelsSnapshot({
        account: resolvedContext.account,
        requestUrl: c.req.url,
        requestHeaders: c.req.raw.headers,
      })
    } catch (error) {
      const normalizedCaughtFailure = deps.normalizeCaughtCodexFailure({
        error,
        routingMode: resolvedContext.key.routingMode,
      })
      if (normalizedCaughtFailure) {
        return new Response(normalizedCaughtFailure.bodyText, {
          status: normalizedCaughtFailure.status,
          headers: normalizedCaughtFailure.headers,
        })
      }
      const statusCode = deps.getStatusErrorCode(error)
      if (statusCode) {
        return new Response(JSON.stringify({ error: deps.errorMessage(error) }), {
          status: statusCode,
          headers: { "Content-Type": "application/json" },
        })
      }
      return c.json({ error: deps.errorMessage(error) }, deps.isLikelyAuthError(error) ? 401 : 502)
    } finally {
      behaviorDecision.release()
    }

    const model = snapshot.entries.find((item: unknown) => deps.extractModelEntryID(item) === id)
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

  app.get("/cursor/v1/models", async (c) => {
    const context = deps.resolveVirtualKeyContext(c, {
      expectedClientMode: "cursor",
      expectedWireApi: "chat_completions",
      requestedModel: null,
    })
    if ("error" in context) {
      const status = typeof context.status === "number" ? context.status : 401
      const message = String(context.error || "Invalid virtual API key")
      return deps.toOpenAICompatibleErrorResponse(
        message,
        status,
        status === 401 ? "authentication_error" : "invalid_request_error",
      )
    }
    const fixedModelId = resolveFixedModelId(context.resolved.key)
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
      requestedModel: fixedModelId,
    })
    if (!consistentContext.ok) {
      return deps.toOpenAICompatibleErrorResponse("No healthy accounts available for pool routing", 503, "server_error")
    }
    let payload = await deps.resolveModelCatalogForCursorAccount({
      account: consistentContext.resolved.account,
      requestUrl: c.req.url,
      requestHeaders: c.req.raw.headers,
    })
    if (fixedModelId) {
      payload = filterCursorCatalogToFixedModel(payload, fixedModelId)
    }
    return c.json(payload)
  })

  app.get("/cursor/v1/models/:id", async (c) => {
    const modelId = c.req.param("id")
    const context = deps.resolveVirtualKeyContext(c, {
      expectedClientMode: "cursor",
      expectedWireApi: "chat_completions",
      requestedModel: modelId,
    })
    if ("error" in context) {
      const status = typeof context.status === "number" ? context.status : 401
      const message = String(context.error || "Invalid virtual API key")
      return deps.toOpenAICompatibleErrorResponse(
        message,
        status,
        status === 401 ? "authentication_error" : "invalid_request_error",
      )
    }
    const fixedModelId = resolveFixedModelId(context.resolved.key)
    if (fixedModelId && modelId !== fixedModelId) {
      return deps.toOpenAICompatibleErrorResponse("Model is not available for Cursor compatibility mode", 404, "invalid_request_error")
    }
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
      requestedModel: fixedModelId ?? modelId,
    })
    if (!consistentContext.ok) {
      return deps.toOpenAICompatibleErrorResponse("No healthy accounts available for pool routing", 503, "server_error")
    }
    let payload = await deps.resolveModelCatalogForCursorAccount({
      account: consistentContext.resolved.account,
      requestUrl: c.req.url,
      requestHeaders: c.req.raw.headers,
    })
    if (fixedModelId) {
      payload = filterCursorCatalogToFixedModel(payload, fixedModelId)
    }
    const match = payload.data.find((item: { id?: string }) => String(item.id || "") === modelId)
    if (!match) {
      return deps.toOpenAICompatibleErrorResponse("Model is not available for Cursor compatibility mode", 404, "invalid_request_error")
    }
    return c.json(match)
  })
}
