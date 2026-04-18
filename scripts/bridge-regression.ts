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

function tryParseRecord(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function buildUnknownParameterErrorPayload(parameter: "client_metadata" | "clientMetadata") {
  return JSON.stringify({
    error: {
      message: `Unknown parameter: '${parameter}'.`,
      type: "invalid_request_error",
      param: parameter,
      code: "unknown_parameter",
    },
  })
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
  const turnStateAuditCase = "turn-state-replay"
  let rerouteFailedToken: string | null = null
  let rerouteSucceededToken: string | null = null
  let turnStateReplayCount = 0
  const expectedTurnState = "ts-regression-1"
  const turnStateSessionKey = "sess-turn-state"
  const expectedTurnStateHeader = `${turnStateSessionKey}:0`
  const turnStateForwardedHeaders: string[] = []
  const turnStateForwardedMetadata: Array<Record<string, unknown> | null> = []
  const turnStateForwardedTurnMetadata: Array<string | null> = []
  const turnStateResponseIds: string[] = []
  const turnStateBodies: string[] = []
  const turnStateHeaderValues: string[] = []
  const turnStateRequestIds: string[] = []
  const turnStateClientRequestIds: string[] = []
  const turnStatePromptCacheKeys: string[] = []
  const turnStateAuthorizationHeaders: string[] = []
  const turnStateWindowHeaders: string[] = []
  const turnStateInstallationHeaders: string[] = []
  const turnStateTurnMetadataHeaders: string[] = []
  const turnStateTraceParents: string[] = []
  const turnStateTraceStates: string[] = []
  const turnStateClientMetadataTraceParents: string[] = []
  const turnStateClientMetadataTraceStates: string[] = []
  const turnStateClientMetadataWindowHeaders: string[] = []
  const turnStateClientMetadataInstallationHeaders: string[] = []
  const turnStateClientMetadataParentHeaders: string[] = []
  const turnStateClientMetadataSubagents: string[] = []
  const turnStateClientMetadataTurnStates: string[] = []
  const turnStateResponseHeaderValues: string[] = []
  const turnStateReplaySeenHeaders: Array<string | null> = []
  const turnStateSecondResponseRequestId = "req_turn_state_second"
  const turnStateFirstResponseRequestId = "req_turn_state_first"
  const turnStateBodyText = JSON.stringify({
    id: "resp_turn_state",
    object: "response",
    output_text: "turn-state-ok",
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3,
    },
  })

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      const body = await request.text()
      const parsedBody = tryParseRecord(body)
      capturedUpstreamRequests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers,
        body,
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
        const illegalCompactField = (["client_metadata", "clientMetadata"] as const).find((field) =>
          Object.prototype.hasOwnProperty.call(parsedBody ?? {}, field),
        )
        if (illegalCompactField) {
          return new Response(buildUnknownParameterErrorPayload(illegalCompactField), {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "x-request-id": `req_unknown_parameter_${illegalCompactField}`,
            },
          })
        }
        return new Response(upstreamCompactPayload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-upstream-test": "codex-compact-pass-through",
          },
        })
      }
      if (headers["x-audit-case"] === turnStateAuditCase && request.url.includes("/backend-api/codex/responses")) {
        turnStateReplayCount += 1
        turnStateReplaySeenHeaders.push(headers["x-codex-turn-state"] ?? null)
        turnStateHeaderValues.push(headers["x-codex-turn-state"] ?? "")
        turnStateForwardedHeaders.push(headers["x-codex-window-id"] ?? "")
        turnStateRequestIds.push(headers["x-request-id"] ?? "")
        turnStateClientRequestIds.push(headers["x-client-request-id"] ?? "")
        const parsed = parsedBody ?? {}
        turnStatePromptCacheKeys.push(String(parsed.prompt_cache_key ?? ""))
        const clientMetadata = (parsed.client_metadata ?? null) as Record<string, unknown> | null
        turnStateForwardedMetadata.push(clientMetadata)
        turnStateBodies.push(JSON.stringify(parsed))
        turnStateResponseIds.push(String(parsed.previous_response_id ?? ""))
        turnStateTurnMetadataHeaders.push(headers["x-codex-turn-metadata"] ?? "")
        turnStateWindowHeaders.push(headers["x-codex-window-id"] ?? "")
        turnStateInstallationHeaders.push(headers["x-codex-installation-id"] ?? "")
        turnStateAuthorizationHeaders.push(headers.authorization ?? "")
        turnStateTraceParents.push(headers.traceparent ?? "")
        turnStateTraceStates.push(headers.tracestate ?? "")
        turnStateClientMetadataTraceParents.push(String(clientMetadata?.ws_request_header_traceparent ?? ""))
        turnStateClientMetadataTraceStates.push(String(clientMetadata?.ws_request_header_tracestate ?? ""))
        turnStateClientMetadataWindowHeaders.push(String(clientMetadata?.["x-codex-window-id"] ?? ""))
        turnStateClientMetadataInstallationHeaders.push(String(clientMetadata?.["x-codex-installation-id"] ?? ""))
        turnStateClientMetadataParentHeaders.push(String(clientMetadata?.["x-codex-parent-thread-id"] ?? ""))
        turnStateClientMetadataSubagents.push(String(clientMetadata?.["x-openai-subagent"] ?? ""))
        turnStateClientMetadataTurnStates.push(String(clientMetadata?.["x-codex-turn-state"] ?? ""))
        if (turnStateReplayCount === 1) {
          turnStateResponseHeaderValues.push(expectedTurnState)
          return new Response(turnStateBodyText, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "x-codex-turn-state": expectedTurnState,
              "x-request-id": turnStateFirstResponseRequestId,
            },
          })
        }
        turnStateResponseHeaderValues.push("")
        return new Response(turnStateBodyText, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": turnStateSecondResponseRequestId,
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
      previous_response_id: "resp-from-previous-turn",
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
        "x-openai-subagent": "review",
        "x-codex-parent-thread-id": "parent-thread-1",
        "x-codex-beta-features": "feature-a,feature-b",
        "x-responsesapi-include-timing-metrics": "true",
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
    assertCondition(
      !parityResponse.headers.get("x-openai-authorization-error"),
      "x-openai-authorization-error should be stripped on failure",
    )
    assertCondition(!parityResponse.headers.get("x-error-json"), "x-error-json should be stripped on failure")
    const parityResponseText = await parityResponse.text()
    assertCondition(parityResponseText === upstreamErrorPayload, "Upstream error payload was altered by proxy")

    const forwarded = capturedUpstreamRequests.at(-1)
    assertCondition(forwarded, "No upstream request was captured for parity validation")
    const expectedParityBody = JSON.parse(rewriteExpectedSessionBody(parityBody, boundAccountId)) as Record<string, unknown>
    assertCondition(forwarded.method === "POST", `Unexpected upstream method: ${forwarded.method}`)
    assertCondition(forwarded.path === "/backend-api/codex/responses", `Unexpected upstream path: ${forwarded.path}`)
    const forwardedParsed = JSON.parse(forwarded.body) as Record<string, unknown>
    assertCondition(
      forwardedParsed.prompt_cache_key === expectedParityBody.prompt_cache_key,
      "prompt_cache_key was not rewritten with account-bound session identifiers",
    )
    assertCondition(
      forwardedParsed.model === expectedParityBody.model,
      "model should be preserved while injecting codex metadata",
    )
    assertCondition(
      JSON.stringify(forwardedParsed.input) === JSON.stringify(expectedParityBody.input),
      "input payload should be preserved while injecting codex metadata",
    )
    assertCondition(
      forwardedParsed.instructions === expectedParityBody.instructions,
      "instructions should be preserved while injecting codex metadata",
    )
    assertCondition(forwardedParsed.store === expectedParityBody.store, "store should be preserved while injecting codex metadata")
    assertCondition(forwardedParsed.stream === expectedParityBody.stream, "stream should be preserved while injecting codex metadata")
    const forwardedClientMetadata = forwardedParsed.client_metadata as Record<string, unknown> | undefined
    const expectedClientMetadata = {
      "x-codex-window-id": "sess-from-prompt-cache:0",
      "x-openai-subagent": "review",
      "x-codex-parent-thread-id": "parent-thread-1",
    }
    assertCondition(forwardedClientMetadata && typeof forwardedClientMetadata === "object", "client_metadata should be injected")
    const normalizedForwardedClientMetadata = Object.fromEntries(
      Object.entries({
        ...forwardedClientMetadata,
        "x-codex-installation-id": "<stable-id>",
      }).sort(([left], [right]) => left.localeCompare(right)),
    )
    const normalizedExpectedClientMetadata = Object.fromEntries(
      Object.entries({
        ...expectedClientMetadata,
        "x-codex-installation-id": "<stable-id>",
      }).sort(([left], [right]) => left.localeCompare(right)),
    )
    const comparableForwardedBody = {
      ...forwardedParsed,
      client_metadata: normalizedForwardedClientMetadata,
    }
    const comparableExpectedBody = {
      ...expectedParityBody,
      client_metadata: normalizedExpectedClientMetadata,
    }
    assertCondition(
      JSON.stringify(comparableForwardedBody) === JSON.stringify(comparableExpectedBody),
      `Request body was not rewritten as expected after codex metadata injection\nexpected=${JSON.stringify(comparableExpectedBody)}\nactual=${JSON.stringify(comparableForwardedBody)}`,
    )
    assertCondition(
      forwardedParsed.previous_response_id === "resp-from-previous-turn",
      "previous_response_id must pass through unchanged for official incremental continuation",
    )
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
    assertCondition(forwarded.headers["x-openai-subagent"] === "review", "x-openai-subagent should be preserved")
    assertCondition(forwarded.headers["x-codex-beta-features"] === "feature-a,feature-b", "x-codex-beta-features should be preserved")
    assertCondition(
      forwarded.headers["x-responsesapi-include-timing-metrics"] === "true",
      "x-responsesapi-include-timing-metrics should be preserved",
    )
    assertCondition(
      forwarded.headers["x-codex-parent-thread-id"] === "parent-thread-1",
      "x-codex-parent-thread-id should be preserved",
    )
    assertCondition(
      typeof forwarded.headers["x-codex-installation-id"] === "string" && forwarded.headers["x-codex-installation-id"].length > 0,
      "x-codex-installation-id should be injected",
    )
    assertCondition(
      forwarded.headers["x-codex-window-id"] === "sess-from-prompt-cache:0",
      `x-codex-window-id mismatch: ${forwarded.headers["x-codex-window-id"] ?? "<missing>"}`,
    )
    const clientMetadata = forwardedClientMetadata
    assertCondition(clientMetadata && typeof clientMetadata === "object", "client_metadata should be injected")
    assertCondition(
      clientMetadata?.["x-codex-beta-features"] == null,
      "x-codex-beta-features should remain a header, not be copied into client_metadata",
    )
    assertCondition(
      clientMetadata?.["x-responsesapi-include-timing-metrics"] == null,
      "x-responsesapi-include-timing-metrics should remain a header, not be copied into client_metadata",
    )
    assertCondition(
      typeof clientMetadata?.["x-codex-installation-id"] === "string" && String(clientMetadata["x-codex-installation-id"]).length > 0,
      "client_metadata.x-codex-installation-id should be injected",
    )
    assertCondition(
      clientMetadata?.["x-codex-window-id"] === "sess-from-prompt-cache:0",
      `client_metadata.x-codex-window-id mismatch: ${String(clientMetadata?.["x-codex-window-id"] ?? "<missing>")}`,
    )
    assertCondition(clientMetadata?.["x-openai-subagent"] === "review", "client_metadata should preserve x-openai-subagent")
    assertCondition(
      clientMetadata?.["x-codex-parent-thread-id"] === "parent-thread-1",
      "client_metadata should preserve x-codex-parent-thread-id",
    )

    const compactBody = JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "compact-check" }] }],
      instructions: "compact-instructions",
      prompt_cache_key: "sess-compact",
      client_metadata: {
        existing: "should-be-stripped",
      },
      clientMetadata: {
        existingCamelCase: "should-also-be-stripped",
      },
      stream: false,
      store: false,
    })
    const compactResponse = await fetch(`${origin}/v1/responses/compact`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
        "openai-beta": "responses=v1",
        "x-openai-subagent": "compact-review",
        "x-codex-parent-thread-id": "compact-parent-1",
        traceparent: "00-00000000000000000000000000000033-0000000000000044-01",
        tracestate: "vendor=compact",
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
    const expectedCompactBody = JSON.parse(rewriteExpectedSessionBody(compactBody, boundAccountId)) as Record<string, unknown>
    delete expectedCompactBody.client_metadata
    delete expectedCompactBody.clientMetadata
    assertCondition(
      compactForwarded.path === "/backend-api/codex/responses/compact",
      `Unexpected compact upstream path: ${compactForwarded.path}`,
    )
    const compactForwardedParsed = JSON.parse(compactForwarded.body) as Record<string, unknown>
    assertCondition(
      compactForwardedParsed.prompt_cache_key === expectedCompactBody.prompt_cache_key,
      "Compact prompt_cache_key was not rewritten with account-bound session identifiers",
    )
    assertCondition(
      !Object.prototype.hasOwnProperty.call(compactForwardedParsed, "client_metadata"),
      "Compact requests should not include client_metadata in the JSON body",
    )
    assertCondition(
      !Object.prototype.hasOwnProperty.call(compactForwardedParsed, "clientMetadata"),
      "Compact requests should not include camelCase clientMetadata in the JSON body",
    )
    assertCondition(
      JSON.stringify(compactForwardedParsed) === JSON.stringify(expectedCompactBody),
      `Compact request body was not rewritten as expected after stripping client_metadata\nexpected=${JSON.stringify(expectedCompactBody)}\nactual=${JSON.stringify(compactForwardedParsed)}`,
    )
    assertCondition(
      typeof compactForwarded.headers["x-codex-installation-id"] === "string" && compactForwarded.headers["x-codex-installation-id"].length > 0,
      "Compact x-codex-installation-id should be injected",
    )
    assertCondition(
      compactForwarded.headers["x-codex-window-id"] === "sess-compact:0",
      `Compact x-codex-window-id mismatch: ${compactForwarded.headers["x-codex-window-id"] ?? "<missing>"}`,
    )
    assertCondition(
      compactForwarded.headers["x-openai-subagent"] === "compact-review",
      "Compact x-openai-subagent should stay in headers only",
    )
    assertCondition(
      compactForwarded.headers["x-codex-parent-thread-id"] === "compact-parent-1",
      "Compact x-codex-parent-thread-id should stay in headers only",
    )
    assertCondition(
      compactForwarded.headers.traceparent === "00-00000000000000000000000000000033-0000000000000044-01",
      "Compact traceparent should stay in headers only",
    )
    assertCondition(
      compactForwarded.headers.tracestate === "vendor=compact",
      "Compact tracestate should stay in headers only",
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
      !modelsForwarded.headers.version || modelsForwarded.headers.version === CODEX_CLIENT_VERSION,
      "Version header should either be omitted or preserved when proxying models",
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

    const turnStateBody = JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "turn-state-check" }] }],
      instructions: "turn-state-check",
      prompt_cache_key: turnStateSessionKey,
      previous_response_id: "resp-turn-state-prev",
      store: false,
      stream: false,
      client_metadata: {
        existing: "preserved",
      },
    })
    const firstTurnStateResponse = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
        "openai-beta": "responses=v1",
        "x-audit-case": turnStateAuditCase,
        traceparent: "00-00000000000000000000000000000011-0000000000000022-01",
        tracestate: "vendor=value",
      },
      body: turnStateBody,
    })
    assertCondition(firstTurnStateResponse.status === 200, `Expected first turn-state status 200, got ${firstTurnStateResponse.status}`)
    const secondTurnStateResponse = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sync.virtualKey?.key ?? ""}`,
        "openai-beta": "responses=v1",
        "x-audit-case": turnStateAuditCase,
      },
      body: turnStateBody,
    })
    assertCondition(secondTurnStateResponse.status === 200, `Expected second turn-state status 200, got ${secondTurnStateResponse.status}`)
    assertCondition(turnStateReplayCount === 2, `Expected 2 turn-state upstream requests, got ${turnStateReplayCount}`)
    assertCondition(turnStateReplaySeenHeaders[0] == null, `First turn-state request should not replay header, got ${turnStateReplaySeenHeaders[0] ?? "<set>"}`)
    assertCondition(turnStateReplaySeenHeaders[1] === expectedTurnState, `Second turn-state request should replay ${expectedTurnState}, got ${turnStateReplaySeenHeaders[1] ?? "<missing>"}`)
    assertCondition(turnStateWindowHeaders[0] === expectedTurnStateHeader, `Turn-state window header mismatch on first request: ${turnStateWindowHeaders[0] ?? "<missing>"}`)
    assertCondition(turnStateWindowHeaders[1] === expectedTurnStateHeader, `Turn-state window header mismatch on second request: ${turnStateWindowHeaders[1] ?? "<missing>"}`)
    assertCondition(turnStateTurnMetadataHeaders[0] === JSON.stringify({ turn_id: turnStateSessionKey }), `First turn metadata header mismatch: ${turnStateTurnMetadataHeaders[0] ?? "<missing>"}`)
    assertCondition(turnStateTurnMetadataHeaders[1] === JSON.stringify({ turn_id: turnStateSessionKey }), `Second turn metadata header mismatch: ${turnStateTurnMetadataHeaders[1] ?? "<missing>"}`)
    assertCondition(turnStateTraceParents[0] === "00-00000000000000000000000000000011-0000000000000022-01", "First turn-state traceparent should be forwarded")
    assertCondition(turnStateTraceStates[0] === "vendor=value", "First turn-state tracestate should be forwarded")
    assertCondition(turnStateTraceParents[1] === "", "Second turn-state traceparent should not be synthesized as header")
    assertCondition(turnStateTraceStates[1] === "", "Second turn-state tracestate should not be synthesized as header")
    assertCondition(turnStateClientMetadataTraceParents[0] === "00-00000000000000000000000000000011-0000000000000022-01", "First turn-state client_metadata traceparent should be injected")
    assertCondition(turnStateClientMetadataTraceStates[0] === "vendor=value", "First turn-state client_metadata tracestate should be injected")
    assertCondition(turnStateClientMetadataTraceParents[1] === "", "Second turn-state client_metadata traceparent should not be synthesized")
    assertCondition(turnStateClientMetadataTraceStates[1] === "", "Second turn-state client_metadata tracestate should not be synthesized")
    assertCondition(turnStateClientMetadataWindowHeaders[0] === expectedTurnStateHeader, "First turn-state client_metadata window id mismatch")
    assertCondition(turnStateClientMetadataWindowHeaders[1] === expectedTurnStateHeader, "Second turn-state client_metadata window id mismatch")
    assertCondition(turnStateForwardedMetadata[0]?.existing === "preserved", "Existing client_metadata should be preserved on first turn-state request")
    assertCondition(turnStateForwardedMetadata[1]?.existing === "preserved", "Existing client_metadata should be preserved on second turn-state request")
    assertCondition(turnStateHeaderValues[1] === expectedTurnState, `Second turn-state header replay mismatch: ${turnStateHeaderValues[1] ?? "<missing>"}`)
    assertCondition(turnStateResponseHeaderValues[0] === expectedTurnState, "First turn-state response should set turn-state header")
    assertCondition(firstTurnStateResponse.headers.get("x-request-id") === turnStateFirstResponseRequestId, "First turn-state response request id mismatch")
    assertCondition(secondTurnStateResponse.headers.get("x-request-id") === turnStateSecondResponseRequestId, "Second turn-state response request id mismatch")
    assertCondition(typeof turnStateInstallationHeaders[0] === "string" && turnStateInstallationHeaders[0].length > 0, "Turn-state installation header should be injected on first request")
    assertCondition(typeof turnStateInstallationHeaders[1] === "string" && turnStateInstallationHeaders[1].length > 0, "Turn-state installation header should be injected on second request")
    assertCondition(typeof turnStateClientMetadataInstallationHeaders[0] === "string" && turnStateClientMetadataInstallationHeaders[0].length > 0, "Turn-state client_metadata installation id should be injected on first request")
    assertCondition(typeof turnStateClientMetadataInstallationHeaders[1] === "string" && turnStateClientMetadataInstallationHeaders[1].length > 0, "Turn-state client_metadata installation id should be injected on second request")
    assertCondition(turnStateClientMetadataParentHeaders[0] === "", "Turn-state parent thread id should stay empty when not provided")
    assertCondition(turnStateClientMetadataSubagents[0] === "", "Turn-state subagent should stay empty when not provided")
    assertCondition(turnStateClientMetadataTurnStates[0] === "", "Turn-state should not be copied into client_metadata")
    assertCondition(turnStateClientMetadataTurnStates[1] === "", "Replayed turn-state should not be copied into client_metadata")
    assertCondition(turnStatePromptCacheKeys[0].length > 0, "Turn-state prompt_cache_key should remain present on first request")
    assertCondition(turnStatePromptCacheKeys[1].length > 0, "Turn-state prompt_cache_key should remain present on second request")
    assertCondition(turnStateAuthorizationHeaders[0] === "Bearer fake-access-token", "Turn-state authorization should resolve to upstream token on first request")
    assertCondition(turnStateAuthorizationHeaders[1] === "Bearer fake-access-token", "Turn-state authorization should resolve to upstream token on second request")
    assertCondition(turnStateBodies[0].includes("existing"), "Turn-state first request body should preserve existing client_metadata")
    assertCondition(turnStateBodies[1].includes("existing"), "Turn-state second request body should preserve existing client_metadata")
    assertCondition(turnStateForwardedMetadata[0] && typeof turnStateForwardedMetadata[0] === "object", "Turn-state first request should inject client_metadata")
    assertCondition(turnStateForwardedMetadata[1] && typeof turnStateForwardedMetadata[1] === "object", "Turn-state second request should inject client_metadata")
    assertCondition(turnStateForwardedHeaders[0] === expectedTurnStateHeader, "Turn-state first request x-codex-window-id mismatch")
    assertCondition(turnStateForwardedHeaders[1] === expectedTurnStateHeader, "Turn-state second request x-codex-window-id mismatch")
    assertCondition(turnStateRequestIds[0] === "", "Turn-state first request should not synthesize x-request-id upstream")
    assertCondition(turnStateRequestIds[1] === "", "Turn-state second request should not synthesize x-request-id upstream")
    assertCondition(turnStateClientRequestIds[0] === "", "Turn-state first request should not synthesize x-client-request-id upstream for pass-through body path")
    assertCondition(turnStateClientRequestIds[1] === "", "Turn-state second request should not synthesize x-client-request-id upstream for pass-through body path")

    const firstTurnStateJson = (await firstTurnStateResponse.json()) as { output_text?: string }
    const secondTurnStateJson = (await secondTurnStateResponse.json()) as { output_text?: string }
    assertCondition(firstTurnStateJson.output_text === "turn-state-ok", "First turn-state payload mismatch")
    assertCondition(secondTurnStateJson.output_text === "turn-state-ok", "Second turn-state payload mismatch")

    const firstTurnStateExpectedBody = JSON.parse(rewriteExpectedSessionBody(turnStateBody, boundAccountId)) as Record<string, unknown>
    const firstTurnStateForwarded = JSON.parse(turnStateBodies[0]) as Record<string, unknown>
    assertCondition(firstTurnStateForwarded.prompt_cache_key === firstTurnStateExpectedBody.prompt_cache_key, "Turn-state first prompt_cache_key mismatch after rewrite")
    const secondTurnStateForwarded = JSON.parse(turnStateBodies[1]) as Record<string, unknown>
    assertCondition(secondTurnStateForwarded.prompt_cache_key === firstTurnStateExpectedBody.prompt_cache_key, "Turn-state second prompt_cache_key mismatch after rewrite")
    assertCondition(secondTurnStateForwarded.previous_response_id === "resp-turn-state-prev", "Turn-state previous_response_id should remain unchanged on replay")
    assertCondition(firstTurnStateForwarded.previous_response_id === "resp-turn-state-prev", "Turn-state previous_response_id should remain unchanged initially")

    assertCondition(rerouteResponse.status === 200, `Expected reroute regression status 200, got ${rerouteResponse.status}`)
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
    const expectedFirstRerouteBody = JSON.parse(rewriteExpectedSessionBody(rerouteBody, rerouteFailedAccountId)) as Record<string, unknown>
    const actualFirstRerouteBody = JSON.parse(rerouteFirstAttempt.body) as Record<string, unknown>
    assertCondition(
      actualFirstRerouteBody.prompt_cache_key === expectedFirstRerouteBody.prompt_cache_key,
      "First reroute attempt prompt_cache_key was not rewritten with the failed account-bound identifiers",
    )
    assertCondition(
      actualFirstRerouteBody.model === expectedFirstRerouteBody.model,
      "First reroute attempt model should be preserved",
    )
    const firstRerouteClientMetadata = actualFirstRerouteBody.client_metadata as Record<string, unknown> | undefined
    assertCondition(firstRerouteClientMetadata && typeof firstRerouteClientMetadata === "object", "First reroute attempt should inject client_metadata")
    assertCondition(
      firstRerouteClientMetadata?.["x-codex-window-id"] === "sess-reroute-check:0",
      "First reroute attempt should inject the expected x-codex-window-id",
    )

    const expectedFinalRerouteBody = JSON.parse(rewriteExpectedSessionBody(rerouteBody, rerouteSucceededAccountId)) as Record<string, unknown>
    const actualFinalRerouteBody = JSON.parse(rerouteFinalAttempt.body) as Record<string, unknown>
    assertCondition(
      actualFinalRerouteBody.prompt_cache_key === expectedFinalRerouteBody.prompt_cache_key,
      "Final reroute attempt prompt_cache_key was not rewritten with the rerouted account-bound identifiers",
    )
    const finalRerouteClientMetadata = actualFinalRerouteBody.client_metadata as Record<string, unknown> | undefined
    assertCondition(finalRerouteClientMetadata && typeof finalRerouteClientMetadata === "object", "Final reroute attempt should inject client_metadata")
    assertCondition(
      finalRerouteClientMetadata?.["x-codex-window-id"] === "sess-reroute-check:0",
      "Final reroute attempt should inject the expected x-codex-window-id",
    )
    assertCondition(
      typeof rerouteFirstAttempt.headers["x-codex-installation-id"] === "string" && rerouteFirstAttempt.headers["x-codex-installation-id"].length > 0,
      "First reroute attempt should inject x-codex-installation-id",
    )
    assertCondition(
      typeof rerouteFinalAttempt.headers["x-codex-installation-id"] === "string" && rerouteFinalAttempt.headers["x-codex-installation-id"].length > 0,
      "Final reroute attempt should inject x-codex-installation-id",
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
