import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"
import { bindClientIdentifierToAccount, isAccountBoundSessionFieldKey } from "../src/upstream-session-binding"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type CapturedRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

type TestCase = {
  id: string
  description: string
  bridgePath: "/v1/responses" | "/v1/responses/compact" | "/responses"
  incomingBody: string
  incomingHeaders: Record<string, string>
  upstreamStatus: number
  upstreamHeaders: Record<string, string>
  upstreamBody: string
  expectedRewriteToCodex: boolean
  expectedUpstreamUrl?: string
}

type CaseResult = {
  caseID: string
  description: string
  passed: boolean
  failures: string[]
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function headersToObject(headers: Headers) {
  const output: Record<string, string> = {}
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value
  })
  return output
}

function copyHeaders(input: HeadersInit) {
  const output = new Headers()
  if (input instanceof Headers) {
    input.forEach((value, key) => output.set(key, value))
    return output
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) output.set(key, String(value))
    return output
  }
  for (const [key, value] of Object.entries(input)) output.set(key, String(value))
  return output
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

function rewriteExpectedSessionBody(body: string, accountId?: string) {
  if (!accountId) return body
  try {
    return JSON.stringify(rewriteExpectedSessionBodyNode(JSON.parse(body), accountId))
  } catch {
    return body
  }
}

function normalizeTransportHeaders(headers: Record<string, string>) {
  const copy = { ...headers }
  delete copy.host
  delete copy.connection
  delete copy["content-length"]
  delete copy["accept-encoding"]
  delete copy.date
  return copy
}

function buildExpectedOutgoingRequest(input: {
  requestUrl: string
  requestMethod: string
  requestHeaders: Record<string, string>
  requestBody: string
  accessToken: string
  accountId: string
  sessionBindingAccountId?: string
  codexEndpoint: string
  shouldRewrite: boolean
}) {
  // Mirrors Codex bridge forwarding behavior for v1 proxy routes.
  const headers = copyHeaders(input.requestHeaders)
  headers.delete("authorization")
  headers.delete("Authorization")
  headers.set("authorization", `Bearer ${input.accessToken}`)
  headers.set("ChatGPT-Account-ID", input.accountId)
  if (input.sessionBindingAccountId) {
    for (const [key, value] of headers.entries()) {
      if (isAccountBoundSessionFieldKey(key)) {
        headers.set(key, bindClientIdentifierToAccount({ accountId: input.sessionBindingAccountId, fieldKey: key, value }))
      }
    }
  }

  const parsed = new URL(input.requestUrl)
  const url = input.shouldRewrite ? input.codexEndpoint : parsed.toString()
  return {
    method: input.requestMethod,
    url,
    headers: normalizeTransportHeaders(headersToObject(headers)),
    body: rewriteExpectedSessionBody(input.requestBody, input.sessionBindingAccountId),
  }
}

function diffHeaders(expected: Record<string, string>, actual: Record<string, string>) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
  const failures: string[] = []
  for (const key of keys) {
    if (expected[key] !== actual[key]) {
      failures.push(`header ${key}: expected=${JSON.stringify(expected[key])} actual=${JSON.stringify(actual[key])}`)
    }
  }
  return failures
}

async function waitForHealth(origin: string, timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // booting
    }
    await Bun.sleep(250)
  }
  throw new Error("Health check timed out")
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  return data as T
}

async function runAudit() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-session-parity-"))
  const bridgePort = "4793"
  const upstreamPort = "4794"
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const codexEndpoint = `${upstreamOrigin}/backend-api/codex/responses`

  const sessionID = "sess-session-parity-001"
    const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const responseStreamBody = [
    'data: {"type":"response.output_text.delta","delta":"hello"}',
    "",
    'data: {"type":"response.completed","response":{"id":"resp_mock","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n")

  const cases: TestCase[] = [
    {
      id: "responses_stream_passthrough",
      description: "Responses route should rewrite URL and pass SSE response through unchanged",
      bridgePath: "/v1/responses",
      incomingBody: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "who are you?" }] }],
        instructions: "session parity instructions",
        prompt_cache_key: sessionID,
        store: false,
        stream: true,
      }),
      incomingHeaders: {
        "content-type": "application/json",
        accept: "text/event-stream",
        originator: CODEX_ORIGINATOR,
        "user-agent": userAgent,
        version: CODEX_CLIENT_VERSION,
        session_id: sessionID,
        "openai-beta": "responses=v1",
        "x-stainless-test": "session-parity",
        "x-session-case": "responses_stream_passthrough",
      },
      upstreamStatus: 200,
      upstreamHeaders: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-upstream-case": "responses-stream",
      },
      upstreamBody: responseStreamBody,
      expectedRewriteToCodex: true,
      expectedUpstreamUrl: codexEndpoint,
    },
    {
      id: "responses_compact_passthrough",
      description: "Responses compact route should rewrite URL and pass JSON response unchanged",
      bridgePath: "/v1/responses/compact",
      incomingBody: JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "compact this" }] }],
        instructions: "compact instructions",
        prompt_cache_key: sessionID,
        store: false,
        stream: false,
      }),
      incomingHeaders: {
        "content-type": "application/json",
        accept: "application/json",
        originator: CODEX_ORIGINATOR,
        "user-agent": userAgent,
        version: CODEX_CLIENT_VERSION,
        "openai-beta": "responses=v1",
        "x-stainless-test": "session-parity",
        "x-session-case": "responses_compact_passthrough",
      },
      upstreamStatus: 200,
      upstreamHeaders: {
        "content-type": "application/json",
        "x-upstream-case": "responses-compact",
      },
      upstreamBody: JSON.stringify({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
      }),
      expectedRewriteToCodex: true,
      expectedUpstreamUrl: `${upstreamOrigin}/backend-api/codex/responses/compact`,
    },
  ]

  const capturedRequests = new Map<string, CapturedRequest>()
  const caseMap = new Map(cases.map((item) => [item.id, item]))
  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const headers = headersToObject(request.headers)
      const caseID = String(headers["x-session-case"] ?? "").trim()
      const testCase = caseMap.get(caseID)
      if (!testCase) {
        return new Response(JSON.stringify({ error: "ignored" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      }
      const body = await request.text()
      capturedRequests.set(caseID, {
        method: request.method,
        url: request.url,
        headers,
        body,
      })
      return new Response(testCase.upstreamBody, {
        status: testCase.upstreamStatus,
        headers: testCase.upstreamHeaders,
      })
    },
  })

  const child = spawn("bun", ["src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OAUTH_APP_HOST: "127.0.0.1",
      OAUTH_APP_PORT: bridgePort,
      OAUTH_APP_FORWARD_PROXY_ENABLED: "0",
      OAUTH_APP_DATA_DIR: tempDataDir,
      OAUTH_CODEX_API_ENDPOINT: codexEndpoint,
      OAUTH_CODEX_CLIENT_VERSION: CODEX_CLIENT_VERSION,
      OAUTH_CODEX_ORIGINATOR: CODEX_ORIGINATOR,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const results: CaseResult[] = []

  try {
    await waitForHealth(bridgeOrigin, 20_000)
    const sync = await requestJSON<{ account?: { id: string }; virtualKey?: { key: string } }>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Session Parity OAuth",
        email: "session-parity@example.com",
        accountId: "org-session-parity",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: true,
        keyName: "Session Parity Key",
      }),
    })
    const virtualKey = sync.virtualKey?.key
    assertCondition(virtualKey, "Virtual key not issued")
    assertCondition(sync.account?.id, "Session parity sync did not return account id")

    for (let i = 0; i < cases.length; i += 1) {
      const testCase = cases[i]
      const response = await fetch(`${bridgeOrigin}${testCase.bridgePath}`, {
        method: "POST",
        headers: {
          ...testCase.incomingHeaders,
          Authorization: `Bearer ${virtualKey}`,
        },
        body: testCase.incomingBody,
      })

      const clientBody = await response.text()
      const clientHeaders = normalizeTransportHeaders(headersToObject(response.headers))
      const captured = capturedRequests.get(testCase.id)
      const failures: string[] = []

      if (!captured) {
        failures.push("no upstream request captured")
      } else {
        const expected = buildExpectedOutgoingRequest({
          requestUrl: `https://api.openai.com${testCase.bridgePath}`,
          requestMethod: "POST",
          requestHeaders: {
            ...testCase.incomingHeaders,
            authorization: "Bearer codex-oauth-dummy-key",
          },
          requestBody: testCase.incomingBody,
          accessToken: "fake-access-token",
          accountId: "org-session-parity",
          sessionBindingAccountId: sync.account.id,
          codexEndpoint: testCase.expectedUpstreamUrl ?? codexEndpoint,
          shouldRewrite: testCase.expectedRewriteToCodex,
        })

        const actualNormalized = {
          method: captured.method,
          url: captured.url,
          headers: normalizeTransportHeaders(captured.headers),
          body: captured.body,
        }

        if (expected.method !== actualNormalized.method) {
          failures.push(`method mismatch: expected=${expected.method} actual=${actualNormalized.method}`)
        }
        if (expected.url !== actualNormalized.url) {
          failures.push(`url mismatch: expected=${expected.url} actual=${actualNormalized.url}`)
        }
        if (expected.body !== actualNormalized.body) {
          failures.push("request body mismatch")
        }
        failures.push(...diffHeaders(expected.headers, actualNormalized.headers))
      }

      if (response.status !== testCase.upstreamStatus) {
        failures.push(`response status mismatch: expected=${testCase.upstreamStatus} actual=${response.status}`)
      }
      if (clientBody !== testCase.upstreamBody) {
        failures.push("response body mismatch")
      }

      const expectedClientHeaders = normalizeTransportHeaders(
        Object.fromEntries(Object.entries(testCase.upstreamHeaders).map(([k, v]) => [k.toLowerCase(), v])),
      )
      failures.push(...diffHeaders(expectedClientHeaders, clientHeaders))

      results.push({
        caseID: testCase.id,
        description: testCase.description,
        passed: failures.length === 0,
        failures,
      })
    }

    // Strict OpenAI v1 compatibility audit:
    // Non-v1 aliases should not be routable in strict codex-compat mode.
    const unsupportedChecks = [
      { path: "/responses", method: "POST", body: cases[0].incomingBody, headers: cases[0].incomingHeaders },
      { path: "/chat/completions", method: "POST", body: cases[1].incomingBody, headers: cases[1].incomingHeaders },
      { path: "/models", method: "GET" as const },
    ]

    for (const check of unsupportedChecks) {
      const beforeCount = capturedRequests.size
      const response = await fetch(`${bridgeOrigin}${check.path}`, {
        method: check.method,
        headers: {
          ...(check.headers ?? {}),
          Authorization: `Bearer ${virtualKey}`,
        },
        body: check.body,
      })
      const failures: string[] = []
      if (response.status !== 404) {
        failures.push(`expected 404 for unsupported alias route ${check.path}, got ${response.status}`)
      }
      if (capturedRequests.size !== beforeCount) {
        failures.push(`unsupported route ${check.path} should not forward upstream requests`)
      }
      results.push({
        caseID: `strict_route_${check.path.replaceAll("/", "_")}`,
        description: `Unsupported alias route should return 404: ${check.path}`,
        passed: failures.length === 0,
        failures,
      })
    }
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const passedCount = results.filter((item) => item.passed).length
  const summary = `Session parity: ${passedCount}/${results.length} cases passed`
  const lines = [
    "# Codex Session Parity Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Summary: ${summary}`,
    "",
    "## Cases",
    ...results.flatMap((item) => {
      const head = [`### ${item.caseID}`, `- Description: ${item.description}`, `- Result: ${item.passed ? "PASS" : "FAIL"}`]
      if (item.failures.length === 0) return [...head, ""]
      return [...head, "- Failures:", ...item.failures.map((failure) => `  - ${failure}`), ""]
    }),
  ]
  const report = lines.join("\n")

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const defaultReportFile = path.join(reportDir, "codex-session-parity-report.md")
  let reportFile = defaultReportFile
  try {
    await writeFile(reportFile, report, "utf8")
  } catch {
    reportFile = path.join(reportDir, `codex-session-parity-report-${Date.now()}.md`)
    await writeFile(reportFile, report, "utf8")
  }

  console.log(summary)
  console.log(`Report saved: ${reportFile}`)

  if (results.some((item) => !item.passed)) {
    process.exit(1)
  }
}

runAudit().catch((error) => {
  console.error("Session parity audit failed:", error)
  process.exit(1)
})
