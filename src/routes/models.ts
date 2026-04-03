import type { Hono } from "hono"

export type ModelsRouteDeps = {
  resolveChatModelList: () => string[]
  resolveVirtualKeyContext: (
    c: any,
    options?: {
      expectedClientMode?: "codex" | "cursor"
      expectedWireApi?: "responses" | "chat_completions"
      bodySessionId?: string | null
    },
  ) => any
  ensureResolvedPoolAccountConsistent: (input: { resolved: any; sessionId?: string | null }) => Promise<any>
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

export function registerModelsRoutes(app: Hono, deps: ModelsRouteDeps) {
  app.get("/api/chat/models", (c) => {
    const models = deps.resolveChatModelList()
    return c.json({ models })
  })

  app.get("/v1/models", async (c) => {
    const context = deps.resolveVirtualKeyContext(c, {
      expectedClientMode: "codex",
      expectedWireApi: "responses",
    })
    if ("error" in context) {
      return c.json({ error: context.error }, context.status ?? 401)
    }
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
      sessionId: context.sessionId,
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
      const snapshot = await deps.getModelsSnapshot({
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
    const context = deps.resolveVirtualKeyContext(c, {
      expectedClientMode: "codex",
      expectedWireApi: "responses",
    })
    if ("error" in context) {
      return c.json({ error: context.error }, context.status ?? 401)
    }
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
      sessionId: context.sessionId,
    })
    if (!consistentContext.ok) {
      return c.json({ error: "No healthy accounts available for pool routing" }, 503)
    }
    const resolvedContext = consistentContext.resolved
    const id = c.req.param("id")
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
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
    })
    if (!consistentContext.ok) {
      return deps.toOpenAICompatibleErrorResponse("No healthy accounts available for pool routing", 503, "server_error")
    }
    return c.json(
      await deps.resolveModelCatalogForCursorAccount({
        account: consistentContext.resolved.account,
        requestUrl: c.req.url,
        requestHeaders: c.req.raw.headers,
      }),
    )
  })

  app.get("/cursor/v1/models/:id", async (c) => {
    const context = deps.resolveVirtualKeyContext(c, {
      expectedClientMode: "cursor",
      expectedWireApi: "chat_completions",
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
    const modelId = c.req.param("id")
    const consistentContext = await deps.ensureResolvedPoolAccountConsistent({
      resolved: context.resolved,
    })
    if (!consistentContext.ok) {
      return deps.toOpenAICompatibleErrorResponse("No healthy accounts available for pool routing", 503, "server_error")
    }
    const payload = await deps.resolveModelCatalogForCursorAccount({
      account: consistentContext.resolved.account,
      requestUrl: c.req.url,
      requestHeaders: c.req.raw.headers,
    })
    const match = payload.data.find((item: { id?: string }) => String(item.id || "") === modelId)
    if (!match) {
      return deps.toOpenAICompatibleErrorResponse("Model is not available for Cursor compatibility mode", 404, "invalid_request_error")
    }
    return c.json(match)
  })
}
