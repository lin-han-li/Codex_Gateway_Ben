import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"
import { bindClientIdentifierToAccount } from "../src/upstream-session-binding"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type SyncResponse = {
  account: {
    id: string
  }
}

type CapturedRequest = {
  at: number
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

type CheckResult = {
  id: string
  description: string
  passed: boolean
  details: string[]
}

type LatencyStats = {
  count: number
  min: number
  max: number
  mean: number
  p50: number
  p95: number
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

function latencyStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const count = sorted.length
  if (count === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0 }
  }
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const mean = sorted.reduce((sum, item) => sum + item, 0) / count
  const p50 = sorted[Math.floor((count - 1) * 0.5)]
  const p95 = sorted[Math.floor((count - 1) * 0.95)]
  return { count, min, max, mean, p50, p95 }
}

async function measureLatency(requestFactory: () => Promise<Response>) {
  const startedAt = process.hrtime.bigint()
  const response = await requestFactory()
  const _ = await response.text().catch(() => "")
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  return {
    status: response.status,
    elapsedMs,
  }
}

function parseTurnAndAccount(outputText: string) {
  const turnMatch = outputText.match(/turn=(\d+)/)
  const accountMatch = outputText.match(/account=([^\s;]+)/)
  return {
    turn: turnMatch ? Number(turnMatch[1]) : NaN,
    account: accountMatch ? accountMatch[1] : "",
  }
}

async function runAudit() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-session-quality-"))
  const bridgePort = "4843"
  const upstreamPort = "4844"
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const capturedRequests: CapturedRequest[] = []
  const sessionTurnByAccount = new Map<string, number>()
  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const url = new URL(request.url)
      const headers = headersToObject(request.headers)
      const body = await request.text()
      capturedRequests.push({
        at: Date.now(),
        method: request.method,
        path: url.pathname,
        headers,
        body,
      })

      await Bun.sleep(12)
      const parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      const sessionId = String(headers["session_id"] ?? parsedBody.prompt_cache_key ?? parsedBody.session_id ?? "none")
      const authorization = String(headers.authorization ?? "none")
      const accountMarker = authorization.replace(/^Bearer\s+/i, "")
      const turnKey = `${sessionId}|${accountMarker}`
      const turn = (sessionTurnByAccount.get(turnKey) ?? 0) + 1
      sessionTurnByAccount.set(turnKey, turn)

      return new Response(
        JSON.stringify({
          id: `resp_${crypto.randomUUID()}`,
          object: "response",
          output_text: `session=${sessionId};account=${accountMarker};turn=${turn}`,
          usage: {
            input_tokens: 6,
            output_tokens: 4,
            total_tokens: 10,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-upstream-audit": "session-quality",
          },
        },
      )
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
      OAUTH_CODEX_API_ENDPOINT: responsesEndpoint,
      OAUTH_CODEX_CLIENT_VERSION: CODEX_CLIENT_VERSION,
      OAUTH_CODEX_ORIGINATOR: CODEX_ORIGINATOR,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const checks: CheckResult[] = []
  let directStats: LatencyStats | null = null
  let bridgeStats: LatencyStats | null = null

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const syncA = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Session Quality A",
        email: "session-quality-a@example.com",
        accountId: "org-session-quality-a",
        accessToken: "qa-token-a",
        refreshToken: "qa-refresh-a",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })
    const syncB = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Session Quality B",
        email: "session-quality-b@example.com",
        accountId: "org-session-quality-b",
        accessToken: "qa-token-b",
        refreshToken: "qa-refresh-b",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })
    const accountIdByAccessToken = new Map<string, string>([
      ["qa-token-a", syncA.account.id],
      ["qa-token-b", syncB.account.id],
    ])

    const issued = (await requestJSON(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Session Quality Pool Key",
      }),
    })) as { key: string }
    const virtualKey = issued.key
    assertCondition(virtualKey?.startsWith("ocsk_live_"), "Pool virtual key not issued")

    {
      const caseId = "ctx-continuity"
      const sessionId = "sess-quality-continuity-001"
      const turns = 6
      const outputs: Array<{ turn: number; account: string }> = []
      for (let i = 0; i < turns; i += 1) {
        const body = JSON.stringify({
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: `turn-${i + 1}` }] }],
          instructions: "context continuity test",
          prompt_cache_key: sessionId,
          stream: false,
          store: false,
        })
        const response = await fetch(`${bridgeOrigin}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${virtualKey}`,
            originator: CODEX_ORIGINATOR,
            "user-agent": userAgent,
            version: CODEX_CLIENT_VERSION,
            session_id: sessionId,
            "openai-beta": "responses=v1",
            "x-audit-case": caseId,
          },
          body,
        })
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
        if (!response.ok) throw new Error(`context continuity request failed: ${response.status} ${JSON.stringify(payload)}`)
        const outputText = String(payload.output_text ?? "")
        const parsed = parseTurnAndAccount(outputText)
        outputs.push(parsed)
      }

      const continuityFailures: string[] = []
      const uniqueAccounts = new Set(outputs.map((item) => item.account))
      if (uniqueAccounts.size !== 1) {
        continuityFailures.push(`same session routed to multiple accounts: ${[...uniqueAccounts].join(", ")}`)
      }
      const routedAccessToken = outputs[0]?.account ?? ""
      const routedAccountId = accountIdByAccessToken.get(routedAccessToken)
      if (!routedAccountId) {
        continuityFailures.push(`unknown routed account token: ${routedAccessToken || "<empty>"}`)
      }
      for (let i = 0; i < outputs.length; i += 1) {
        const expectedTurn = i + 1
        if (outputs[i].turn !== expectedTurn) {
          continuityFailures.push(`turn continuity mismatch at #${i + 1}: expected=${expectedTurn} actual=${outputs[i].turn}`)
        }
      }

      checks.push({
        id: "context_continuity",
        description: "Same session keeps sticky routing and monotonic turn progression after account-bound rewrite",
        passed: continuityFailures.length === 0,
        details:
          continuityFailures.length > 0
            ? continuityFailures
            : [
                `session stickiness account=${outputs[0]?.account ?? "-"}`,
                `account-bound session=${bindClientIdentifierToAccount({
                  accountId: routedAccountId,
                  fieldKey: "session_id",
                  value: sessionId,
                })}`,
              ],
      })
    }

    {
      const caseId = "param-parity"
      const sessionId = "sess-quality-param-001"
      const requestBody = JSON.stringify({
        model: "gpt-5.4",
        instructions: "parameter parity validation",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "validate parameters parity" }],
          },
        ],
        prompt_cache_key: sessionId,
        stream: false,
        store: false,
        max_output_tokens: 512,
        parallel_tool_calls: true,
        tool_choice: "auto",
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "lookup helper",
            parameters: {
              type: "object",
              properties: {
                q: { type: "string" },
              },
              required: ["q"],
              additionalProperties: false,
            },
          },
        ],
        reasoning: {
          effort: "medium",
          summary: "auto",
        },
        metadata: {
          trace_id: "trace-param-parity",
          scope: "session-quality-audit",
        },
      })

      const response = await fetch(`${bridgeOrigin}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${virtualKey}`,
          originator: CODEX_ORIGINATOR,
          "user-agent": userAgent,
          version: CODEX_CLIENT_VERSION,
          session_id: sessionId,
          "openai-beta": "responses=v1",
          "x-audit-case": caseId,
        },
        body: requestBody,
      })
      const text = await response.text().catch(() => "")
      if (!response.ok) throw new Error(`parameter parity request failed: ${response.status} ${text}`)

      const captured = [...capturedRequests].reverse().find((item) => item.headers["x-audit-case"] === caseId)
      const parityFailures: string[] = []
      if (!captured) {
        parityFailures.push("no upstream request captured for parameter parity case")
      } else {
        const parsed = JSON.parse(captured.body) as Record<string, unknown>
        const routedAccessToken = String(captured.headers.authorization ?? "").replace(/^Bearer\s+/i, "")
        const routedAccountId = accountIdByAccessToken.get(routedAccessToken)
        if (!routedAccountId) {
          parityFailures.push(`unknown routed account token: ${routedAccessToken || "<empty>"}`)
        }
        if (String(parsed.model ?? "") !== "gpt-5.4") parityFailures.push("model mismatch after forwarding")
        if (String((parsed.reasoning as Record<string, unknown> | undefined)?.effort ?? "") !== "medium") {
          parityFailures.push("reasoning.effort mismatch after forwarding")
        }
        if (!Array.isArray(parsed.tools) || parsed.tools.length !== 1) {
          parityFailures.push("tools payload mismatch after forwarding")
        }
        if (String((parsed.metadata as Record<string, unknown> | undefined)?.trace_id ?? "") !== "trace-param-parity") {
          parityFailures.push("metadata.trace_id mismatch after forwarding")
        }
        const expectedPromptCacheKey = bindClientIdentifierToAccount({
          accountId: routedAccountId,
          fieldKey: "prompt_cache_key",
          value: sessionId,
        })
        if (String(parsed.prompt_cache_key ?? "") !== expectedPromptCacheKey) {
          parityFailures.push("prompt_cache_key was not rewritten to routed account-bound value")
        }
      }

      checks.push({
        id: "model_parameter_parity",
        description: "Model and advanced parameters remain equivalent after forwarding",
        passed: parityFailures.length === 0,
        details:
          parityFailures.length > 0
            ? parityFailures
            : ["model/reasoning/tools/metadata preserved; only account-bound prompt_cache_key was rewritten"],
      })
    }

    {
      const warmup = 6
      const rounds = 36
      const sessionId = "sess-quality-benchmark-001"
      const benchmarkBody = JSON.stringify({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "benchmark request" }] }],
        instructions: "benchmark",
        prompt_cache_key: sessionId,
        stream: false,
        store: false,
      })

      const runDirect = () =>
        fetch(responsesEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: "Bearer qa-token-a",
            "chatgpt-account-id": "org-session-quality-a",
            originator: CODEX_ORIGINATOR,
            "user-agent": userAgent,
            version: CODEX_CLIENT_VERSION,
            session_id: sessionId,
            "openai-beta": "responses=v1",
            "x-audit-case": "perf-direct",
          },
          body: benchmarkBody,
        })

      const runBridge = () =>
        fetch(`${bridgeOrigin}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${virtualKey}`,
            originator: CODEX_ORIGINATOR,
            "user-agent": userAgent,
            version: CODEX_CLIENT_VERSION,
            session_id: sessionId,
            "openai-beta": "responses=v1",
            "x-audit-case": "perf-bridge",
          },
          body: benchmarkBody,
        })

      for (let i = 0; i < warmup; i += 1) {
        const d = await measureLatency(runDirect)
        const b = await measureLatency(runBridge)
        if (d.status !== 200 || b.status !== 200) {
          throw new Error(`benchmark warmup failed: direct=${d.status} bridge=${b.status}`)
        }
      }

      const directSamples: number[] = []
      const bridgeSamples: number[] = []
      for (let i = 0; i < rounds; i += 1) {
        const d = await measureLatency(runDirect)
        const b = await measureLatency(runBridge)
        if (d.status !== 200 || b.status !== 200) {
          throw new Error(`benchmark round failed #${i + 1}: direct=${d.status} bridge=${b.status}`)
        }
        directSamples.push(d.elapsedMs)
        bridgeSamples.push(b.elapsedMs)
      }

      directStats = latencyStats(directSamples)
      bridgeStats = latencyStats(bridgeSamples)
      const meanOverheadMs = bridgeStats.mean - directStats.mean
      const p95OverheadMs = bridgeStats.p95 - directStats.p95

      const performanceFailures: string[] = []
      if (meanOverheadMs > 20) {
        performanceFailures.push(`mean overhead too high: ${meanOverheadMs.toFixed(2)}ms (> 20ms)`)
      }
      if (p95OverheadMs > 25) {
        performanceFailures.push(`p95 overhead too high: ${p95OverheadMs.toFixed(2)}ms (> 25ms)`)
      }

      checks.push({
        id: "forward_performance",
        description: "Forwarding latency overhead remains within acceptable threshold",
        passed: performanceFailures.length === 0,
        details:
          performanceFailures.length > 0
            ? performanceFailures
            : [
                `mean overhead ${meanOverheadMs.toFixed(2)}ms`,
                `p95 overhead ${p95OverheadMs.toFixed(2)}ms`,
              ],
      })
    }
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const passedCount = checks.filter((item) => item.passed).length
  const summary = `Session quality audit: ${passedCount}/${checks.length} checks passed`

  const lines = [
    "# Codex Session Quality Audit",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Summary: ${summary}`,
    "",
    "## Check Results",
    ...checks.flatMap((item) => {
      const head = [`### ${item.id}`, `- Description: ${item.description}`, `- Result: ${item.passed ? "PASS" : "FAIL"}`]
      return [...head, ...item.details.map((detail) => `- ${detail}`), ""]
    }),
  ]

  if (directStats && bridgeStats) {
    lines.push(
      "## Performance Stats (ms)",
      "",
      `- Direct: count=${directStats.count}, min=${directStats.min.toFixed(2)}, p50=${directStats.p50.toFixed(2)}, p95=${directStats.p95.toFixed(2)}, max=${directStats.max.toFixed(2)}, mean=${directStats.mean.toFixed(2)}`,
      `- Bridge: count=${bridgeStats.count}, min=${bridgeStats.min.toFixed(2)}, p50=${bridgeStats.p50.toFixed(2)}, p95=${bridgeStats.p95.toFixed(2)}, max=${bridgeStats.max.toFixed(2)}, mean=${bridgeStats.mean.toFixed(2)}`,
      "",
    )
  }

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const defaultReportFile = path.join(reportDir, "codex-session-quality-audit.md")
  let reportFile = defaultReportFile
  try {
    await writeFile(reportFile, lines.join("\n"), "utf8")
  } catch {
    reportFile = path.join(reportDir, `codex-session-quality-audit-${Date.now()}.md`)
    await writeFile(reportFile, lines.join("\n"), "utf8")
  }

  console.log(summary)
  console.log(`Report saved: ${reportFile}`)

  if (checks.some((item) => !item.passed)) {
    process.exit(1)
  }
}

runAudit().catch((error) => {
  console.error("Session quality audit failed:", error)
  process.exit(1)
})
