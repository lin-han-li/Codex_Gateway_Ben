import { mkdtemp, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { resolveCodexClientVersion } from "../src/codex-version"
import { bindClientIdentifierToAccount, isAccountBoundSessionFieldKey } from "../src/upstream-session-binding"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type SyncResponse = {
  account: { id: string }
  virtualKey?: { key: string; record?: { id: string } }
  baseURL: string
}

type IssueKeyResponse = {
  key: string
  record?: {
    id: string
    accountId?: string | null
    routingMode?: string
  } | null
}

type CapturedUpstreamRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function rewriteExpectedSessionBodyNode(node: unknown, accountId: string): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteExpectedSessionBodyNode(item, accountId))
  if (!node || typeof node !== "object") return node

  const rewritten: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && isAccountBoundSessionFieldKey(key)) {
      rewritten[key] = bindClientIdentifierToAccount({ accountId, fieldKey: key, value })
      continue
    }
    rewritten[key] = rewriteExpectedSessionBodyNode(value, accountId)
  }
  return rewritten
}

function rewriteExpectedSessionBody(body: string, accountId: string) {
  try {
    return JSON.stringify(rewriteExpectedSessionBodyNode(JSON.parse(body), accountId))
  } catch {
    return body
  }
}

async function waitForHealth(origin: string, timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // service still booting
    }
    await Bun.sleep(250)
  }
  throw new Error("Server health check timed out")
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  }
  return data as T
}

async function reserveFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-bridge-regression-"))
  const port = String(await reserveFreePort())
  const upstreamPort = String(await reserveFreePort())
  const origin = `http://127.0.0.1:${port}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const upstreamErrorPayload = JSON.stringify({
    error: {
      message: "mock upstream parity check",
      type: "invalid_request_error",
    },
  })
  const capturedUpstreamRequests: CapturedUpstreamRequest[] = []
  const upstreamModelsPayload = JSON.stringify({
    models: [
      {
        slug: "gpt-5.4",
        display_name: "gpt-5.4",
        description: "latest",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "low" },
          { effort: "medium", description: "medium" },
          { effort: "high", description: "high" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        minimal_client_version: CODEX_CLIENT_VERSION,
        supported_in_api: true,
        priority: 0,
        upgrade: null,
        base_instructions: "test",
        supports_reasoning_summaries: true,
      },
    ],
  })
  const upstreamCompactPayload = JSON.stringify({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "compact-ok" }],
      },
    ],
  })
  const rerouteProbeAuditCase = "pool-reroute-probe"
  const rerouteAuditCase = "pool-reroute-body"
  let rerouteFailedToken: string | null = null
  let rerouteSucceededToken: string | null = null

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      capturedUpstreamRequests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers,
        body: await request.text(),
      })
      if (request.url.includes("/backend-api/codex/models")) {
        return new Response(upstreamModelsPayload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            etag: "\"models-etag\"",
            "x-upstream-test": "codex-models-pass-through",
          },
        })
      }
      if (request.url.includes("/backend-api/codex/responses/compact")) {
        return new Response(upstreamCompactPayload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-upstream-test": "codex-compact-pass-through",
          },
        })
      }
      if (
        (headers["x-audit-case"] === rerouteProbeAuditCase || headers["x-audit-case"] === rerouteAuditCase) &&
        request.url.includes("/backend-api/codex/responses")
      ) {
        const accessToken = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")
        if (headers["x-audit-case"] === rerouteAuditCase && rerouteFailedToken && accessToken === rerouteFailedToken) {
          return new Response(
            JSON.stringify({
              error: {
                message: "temporary upstream failure for reroute regression",
                type: "server_error",
              },
            }),
            {
              status: 502,
              headers: {
                "Content-Type": "application/json",
              },
            },
          )
        }
        return new Response(
          JSON.stringify({
            id: `resp_${crypto.randomUUID()}`,
            object: "response",
            output_text: `rerouted=${accessToken}`,
            usage: {
              input_tokens: 12,
              output_tokens: 7,
              total_tokens: 19,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        )
      }
      return new Response(upstreamErrorPayload, {
        status: 418,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "7",
          "x-codex-active-limit": "codex",
          "x-codex-primary-used-percent": "80",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": "1774283031",
          "x-upstream-test": "codex-pass-through",
          "x-request-id": "req_bridge_regression",
          "cf-ray": "cf_bridge_regression",
          "x-openai-authorization-error": "account_deactivated",
          "x-error-json": Buffer.from(JSON.stringify({ code: "account_deactivated" })).toString("base64"),
        },
      })
    },
  })

  const child = spawn("bun", ["src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OAUTH_APP_HOST: "127.0.0.1",
      OAUTH_APP_PORT: port,
      OAUTH_APP_DATA_DIR: tempDataDir,
      OAUTH_APP_FORWARD_PROXY_ENABLED: "0",
      OAUTH_CODEX_API_ENDPOINT: `${upstreamOrigin}/backend-api/codex/responses`,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`))

  try {
    await waitForHealth(origin, 20_000)

    const sync = await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Regression OAuth",
        email: "regression@example.com",
        accountId: "org-regression-account",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: true,
        keyName: "Regression Key",
      }),
    })

    assertCondition(sync.account?.id, "Missing account id from sync response")
    assertCondition(sync.virtualKey?.key?.startsWith("ocsk_live_"), "Virtual key format mismatch")
    assertCondition(sync.baseURL === `${origin}/v1`, "Unexpected bridge baseURL")
    const boundAccountId = sync.account.id

    const parityBody = JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "parity-check" }] }],
      instructions: "parity-instructions",
      prompt_cache_key: "sess-from-prompt-cache",
      store: false,
      stream: true,
    })

    const parityResponse = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
        "openai-beta": "responses=v1",
        "x-stainless-test": "bridge-regression",
      },
      body: parityBody,
    })

    assertCondition(parityResponse.status === 418, `Expected upstream passthrough status 418, got ${parityResponse.status}`)
    assertCondition(!parityResponse.headers.get("x-upstream-test"), "Non-official upstream headers should be stripped on failure")
    assertCondition(parityResponse.headers.get("retry-after") === "7", "Retry-After should be preserved on failure")
    assertCondition(
      parityResponse.headers.get("x-codex-active-limit") === "codex",
      "Codex active limit header should be preserved on failure",
    )
    assertCondition(
      parityResponse.headers.get("x-codex-primary-used-percent") === "80",
      "Codex rate limit headers should be preserved on failure",
    )
    assertCondition(
      parityResponse.headers.get("x-request-id") === "req_bridge_regression",
      "x-request-id should be preserved on failure",
    )
    assertCondition(!parityResponse.headers.get("cf-ray"), "cf-ray should be stripped on failure")
    assertCondition(
      !parityResponse.headers.get("x-openai-authorization-error"),
      "x-openai-authorization-error should be stripped on failure",
    )
    assertCondition(!parityResponse.headers.get("x-error-json"), "x-error-json should be stripped on failure")
    const parityResponseText = await parityResponse.text()
    assertCondition(parityResponseText === upstreamErrorPayload, "Upstream error payload was altered by proxy")

    const forwarded = capturedUpstreamRequests.at(-1)
    assertCondition(forwarded, "No upstream request was captured for parity validation")
    const expectedParityBody = rewriteExpectedSessionBody(parityBody, boundAccountId)
    assertCondition(forwarded.method === "POST", `Unexpected upstream method: ${forwarded.method}`)
    assertCondition(forwarded.path === "/backend-api/codex/responses", `Unexpected upstream path: ${forwarded.path}`)
    assertCondition(forwarded.body === expectedParityBody, "Request body was not rewritten with account-bound session identifiers")
    assertCondition(
      forwarded.headers.authorization === "Bearer fake-access-token",
      `Authorization header mismatch: ${forwarded.headers.authorization ?? "<missing>"}`,
    )
    assertCondition(
      forwarded.headers["chatgpt-account-id"] === "org-regression-account",
      `ChatGPT-Account-ID mismatch: ${forwarded.headers["chatgpt-account-id"] ?? "<missing>"}`,
    )
    assertCondition(
      !forwarded.headers["session_id"],
      `session_id should not be synthesized by bridge: ${forwarded.headers["session_id"] ?? "<missing>"}`,
    )
    assertCondition(forwarded.headers["openai-beta"] === "responses=v1", "Inbound OpenAI SDK header was not preserved")
    assertCondition(forwarded.headers["x-stainless-test"] === "bridge-regression", "Inbound custom header was not preserved")

    const compactBody = JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "compact-check" }] }],
      instructions: "compact-instructions",
      prompt_cache_key: "sess-compact",
      stream: false,
      store: false,
    })
    const compactResponse = await fetch(`${origin}/v1/responses/compact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
        "openai-beta": "responses=v1",
      },
      body: compactBody,
    })
    assertCondition(compactResponse.status === 200, `Expected compact passthrough status 200, got ${compactResponse.status}`)
    assertCondition(
      compactResponse.headers.get("x-upstream-test") === "codex-compact-pass-through",
      "Compact upstream response headers were not passthrough",
    )
    const compactResponseText = await compactResponse.text()
    assertCondition(compactResponseText === upstreamCompactPayload, "Compact response payload was altered by proxy")
    const compactForwarded = capturedUpstreamRequests.at(-1)
    assertCondition(compactForwarded, "No upstream request captured for compact parity validation")
    const expectedCompactBody = rewriteExpectedSessionBody(compactBody, boundAccountId)
    assertCondition(
      compactForwarded.path === "/backend-api/codex/responses/compact",
      `Unexpected compact upstream path: ${compactForwarded.path}`,
    )
    assertCondition(
      compactForwarded.body === expectedCompactBody,
      "Compact request body was not rewritten with account-bound session identifiers",
    )

    const modelsRequestsBefore = capturedUpstreamRequests.length
    const modelsResponse = await fetch(`${origin}/v1/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
        originator: "spoofed_originator",
        "User-Agent": "spoofed_ua/999",
        version: "999.0.0",
      },
    })
    assertCondition(modelsResponse.status === 200, `Expected models status 200, got ${modelsResponse.status}`)
    assertCondition(
      String(modelsResponse.headers.get("content-type") ?? "").toLowerCase().includes("application/json"),
      "Models response should be json",
    )
    assertCondition(
      modelsResponse.headers.get("etag") === "\"models-etag\"",
      "Models response should preserve upstream etag",
    )
    assertCondition(
      !modelsResponse.headers.get("x-upstream-test"),
      "Models response should come from local snapshot layer, not passthrough upstream headers",
    )
    const modelsResponseText = await modelsResponse.text()
    assertCondition(modelsResponseText === upstreamModelsPayload, "Models payload was altered by proxy")
    const modelsForwarded = capturedUpstreamRequests.at(-1)
    assertCondition(modelsForwarded, "No upstream request captured for models parity validation")
    assertCondition(
      capturedUpstreamRequests.length === modelsRequestsBefore + 1,
      "First models request should fetch upstream exactly once",
    )
    assertCondition(modelsForwarded.method === "GET", `Unexpected models upstream method: ${modelsForwarded.method}`)
    assertCondition(modelsForwarded.path === "/backend-api/codex/models", `Unexpected models upstream path: ${modelsForwarded.path}`)
    assertCondition(
      modelsForwarded.headers.version === CODEX_CLIENT_VERSION,
      "Version header was not preserved when proxying models",
    )
    assertCondition(
      modelsForwarded.headers.originator === CODEX_ORIGINATOR,
      `Originator header should be enforced by bridge: ${modelsForwarded.headers.originator ?? "<missing>"}`,
    )
    assertCondition(
      String(modelsForwarded.headers["user-agent"] ?? "").startsWith(`${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`),
      `User-Agent header should be enforced by bridge: ${modelsForwarded.headers["user-agent"] ?? "<missing>"}`,
    )
    assertCondition(
      modelsForwarded.headers.authorization === "Bearer fake-access-token",
      `Models authorization header mismatch: ${modelsForwarded.headers.authorization ?? "<missing>"}`,
    )
    assertCondition(
      modelsForwarded.headers["chatgpt-account-id"] === "org-regression-account",
      `Models ChatGPT-Account-ID mismatch: ${modelsForwarded.headers["chatgpt-account-id"] ?? "<missing>"}`,
    )

    const modelsCachedResponse = await fetch(`${origin}/v1/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
      },
    })
    assertCondition(modelsCachedResponse.status === 200, `Expected cached models status 200, got ${modelsCachedResponse.status}`)
    const modelsCachedText = await modelsCachedResponse.text()
    assertCondition(modelsCachedText === upstreamModelsPayload, "Cached models payload was altered")
    assertCondition(
      capturedUpstreamRequests.length === modelsRequestsBefore + 1,
      "Second models request should be served from local cache without upstream call",
    )

    const secondSync = await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Regression OAuth Secondary",
        email: "regression-secondary@example.com",
        accountId: "org-regression-account-secondary",
        accessToken: "fake-access-token-secondary",
        refreshToken: "fake-refresh-token-secondary",
        expiresAt: Date.now() + 3600_000,
      }),
    })
    assertCondition(secondSync.account?.id, "Missing secondary account id from sync response")

    const poolProbe = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Regression Pool Probe Key",
      }),
    })
    assertCondition(poolProbe.key?.startsWith("ocsk_live_"), "Pool probe key format mismatch")
    const rerouteProbeBody = JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "reroute-probe" }] }],
      instructions: "reroute-probe",
      prompt_cache_key: "sess-reroute-probe",
      store: false,
      stream: false,
    })
    const rerouteProbeResponse = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${poolProbe.key ?? ""}`,
        "openai-beta": "responses=v1",
        "x-audit-case": rerouteProbeAuditCase,
      },
      body: rerouteProbeBody,
    })
    assertCondition(rerouteProbeResponse.status === 200, `Expected reroute probe status 200, got ${rerouteProbeResponse.status}`)
    const rerouteProbeJson = (await rerouteProbeResponse.json()) as { output_text?: string }
    const defaultSelectedToken = String(rerouteProbeJson.output_text ?? "").replace(/^rerouted=/, "")
    assertCondition(defaultSelectedToken.length > 0, "Failed to detect default pool route token")
    if (poolProbe.record?.id) {
      await requestJSON<{ success: boolean }>(`${origin}/api/virtual-keys/${encodeURIComponent(poolProbe.record.id)}`, {
        method: "DELETE",
      })
    }

    const rerouteCandidates = [
      {
        accountId: sync.account.id,
        accessToken: "fake-access-token",
      },
      {
        accountId: secondSync.account.id,
        accessToken: "fake-access-token-secondary",
      },
    ]
    const rerouteFailed = rerouteCandidates.find((item) => item.accessToken === defaultSelectedToken) ?? null
    const rerouteSucceeded = rerouteCandidates.find((item) => item.accessToken !== defaultSelectedToken) ?? null
    rerouteFailedToken = rerouteFailed?.accessToken ?? null
    rerouteSucceededToken = rerouteSucceeded?.accessToken ?? null
    const rerouteFailedAccountId = rerouteFailed?.accountId ?? null
    const rerouteSucceededAccountId = rerouteSucceeded?.accountId ?? null
    assertCondition(rerouteFailedToken && rerouteSucceededToken, "Missing reroute token bindings")
    assertCondition(rerouteFailedAccountId && rerouteSucceededAccountId, "Missing reroute account bindings")
    const poolIssued = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Regression Pool Key",
      }),
    })
    assertCondition(poolIssued.key?.startsWith("ocsk_live_"), "Pool virtual key format mismatch")
    assertCondition(poolIssued.record?.routingMode === "pool", "Pool virtual key routing mode mismatch")
    assertCondition(poolIssued.record?.accountId == null, "Pool virtual key should not bind accountId")
    const rerouteBody = JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "reroute-check" }] }],
      instructions: "reroute-check",
      prompt_cache_key: "sess-reroute-check",
      store: false,
      stream: false,
    })
    const rerouteResponse = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${poolIssued.key ?? ""}`,
        "openai-beta": "responses=v1",
        "x-audit-case": rerouteAuditCase,
      },
      body: rerouteBody,
    })
    assertCondition(rerouteResponse.status === 200, `Expected reroute regression status 200, got ${rerouteResponse.status}`)
    const rerouteResponseJson = (await rerouteResponse.json()) as { output_text?: string }
    assertCondition(
      rerouteResponseJson.output_text === `rerouted=${rerouteSucceededToken}`,
      `Expected rerouted token ${rerouteSucceededToken}, got ${rerouteResponseJson.output_text ?? "<missing>"}`,
    )
    const rerouteForwarded = capturedUpstreamRequests.filter((item) => item.headers["x-audit-case"] === rerouteAuditCase)
    assertCondition(rerouteForwarded.length >= 2, `Expected at least 2 reroute upstream attempts, got ${rerouteForwarded.length}`)
    const rerouteFirstAttempt = rerouteForwarded[0]
    const rerouteFinalAttempt = rerouteForwarded.at(-1)
    assertCondition(rerouteFirstAttempt, "Missing first reroute attempt")
    assertCondition(rerouteFinalAttempt, "Missing final reroute attempt")
    assertCondition(
      rerouteFirstAttempt.headers.authorization === `Bearer ${rerouteFailedToken}`,
      `Expected first reroute attempt on failed token ${rerouteFailedToken}, got ${rerouteFirstAttempt.headers.authorization ?? "<missing>"}`,
    )
    assertCondition(
      rerouteFinalAttempt.headers.authorization === `Bearer ${rerouteSucceededToken}`,
      `Expected final reroute attempt on rerouted token ${rerouteSucceededToken}, got ${rerouteFinalAttempt.headers.authorization ?? "<missing>"}`,
    )
    assertCondition(
      rerouteFirstAttempt.body === rewriteExpectedSessionBody(rerouteBody, rerouteFailedAccountId),
      "First reroute attempt body was not rewritten with the failed account-bound identifiers",
    )
    assertCondition(
      rerouteFinalAttempt.body === rewriteExpectedSessionBody(rerouteBody, rerouteSucceededAccountId),
      "Final reroute attempt body was not rewritten with the rerouted account-bound identifiers",
    )
    if (poolIssued.record?.id) {
      await requestJSON<{ success: boolean }>(`${origin}/api/virtual-keys/${encodeURIComponent(poolIssued.record.id)}`, {
        method: "DELETE",
      })
    }

    const keys = await requestJSON<{ keys: Array<{ id: string; accountId: string | null; isRevoked: boolean }> }>(
      `${origin}/api/virtual-keys?accountId=${encodeURIComponent(sync.account.id)}`,
    )
    assertCondition(keys.keys.length > 0, "No virtual keys returned for synced account")
    assertCondition(keys.keys.some((item) => item.isRevoked === false), "No active virtual key found")

    const keyID = keys.keys[0]?.id
    assertCondition(keyID, "Missing key id in list")
    const reveal = await requestJSON<{ key: string }>(`${origin}/api/virtual-keys/${encodeURIComponent(keyID)}/reveal`, {
      method: "POST",
      headers: {
        "x-sensitive-action": "confirm",
      },
    })
    assertCondition(reveal.key === sync.virtualKey?.key, "Reveal endpoint returned unexpected key value")
    await requestJSON<{ success: boolean }>(`${origin}/api/virtual-keys/${encodeURIComponent(keyID)}/revoke`, {
      method: "POST",
    })
    const afterRevoke = await requestJSON<{ keys: Array<{ id: string; isRevoked: boolean }> }>(
      `${origin}/api/virtual-keys?accountId=${encodeURIComponent(sync.account.id)}`,
    )
    assertCondition(afterRevoke.keys.some((item) => item.id === keyID && item.isRevoked), "Key should be revoked but is not")

    await requestJSON<{ success: boolean }>(`${origin}/api/virtual-keys/${encodeURIComponent(keyID)}/restore`, {
      method: "POST",
    })
    const afterRestore = await requestJSON<{ keys: Array<{ id: string; isRevoked: boolean }> }>(
      `${origin}/api/virtual-keys?accountId=${encodeURIComponent(sync.account.id)}`,
    )
    assertCondition(afterRestore.keys.some((item) => item.id === keyID && !item.isRevoked), "Key should be restored but is still revoked")

    await requestJSON<{ success: boolean }>(`${origin}/api/virtual-keys/${encodeURIComponent(keyID)}/revoke`, {
      method: "POST",
    })

    await requestJSON<{ success: boolean }>(`${origin}/api/virtual-keys/${encodeURIComponent(keyID)}`, {
      method: "DELETE",
    })

    const afterDelete = await requestJSON<{ keys: Array<{ id: string }> }>(`${origin}/api/virtual-keys?accountId=${encodeURIComponent(sync.account.id)}`)
    assertCondition(!afterDelete.keys.some((item) => item.id === keyID), "Deleted key still exists in list")

    const revokedResponse = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
        stream: true,
      }),
    })
    assertCondition(revokedResponse.status === 401, `Expected 401 for deleted key, got ${revokedResponse.status}`)

    console.log("Bridge regression passed: sync/issue/list/revoke/auth + codex parity checks are valid.")
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("Bridge regression failed:", error)
  process.exit(1)
})
