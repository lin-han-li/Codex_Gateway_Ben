import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type SyncResponse = {
  account: { id: string }
  virtualKey?: {
    key: string
    record?: { id: string }
  }
}

type CapturedRequest = {
  caseId: string
  at: number
}

type CheckResult = {
  id: string
  description: string
  passed: boolean
  findings: string[]
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  }
  return data as T
}

function hasBehaviorBlockMarker(text: string) {
  return (
    text.includes("egress_switch_too_fast") ||
    text.includes("region_switch_too_fast") ||
    text.includes("rate_or_concurrency_limited")
  )
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-behavior-audit-"))
  const bridgePort = "4821"
  const upstreamPort = "4822"
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const codexEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  let retryCaseCount = 0
  let upstreamInFlight = 0
  let upstreamMaxInFlightConcurrency = 0
  const captured: CapturedRequest[] = []

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const caseId = String(request.headers.get("x-audit-case") ?? "unknown")
      captured.push({ caseId, at: Date.now() })
      upstreamInFlight += 1
      if (caseId.startsWith("concurrency-")) {
        upstreamMaxInFlightConcurrency = Math.max(upstreamMaxInFlightConcurrency, upstreamInFlight)
      }
      try {
        if (caseId === "retry-5xx") {
          retryCaseCount += 1
          if (retryCaseCount <= 2) {
            return new Response(JSON.stringify({ error: { message: "temporary upstream failure" } }), {
              status: 502,
              headers: { "Content-Type": "application/json" },
            })
          }
        }

        if (caseId.startsWith("concurrency-")) {
          await Bun.sleep(150)
        }

        return new Response(
          JSON.stringify({
            id: `resp_${caseId}`,
            object: "response",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      } finally {
        upstreamInFlight -= 1
      }
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

      OAUTH_UPSTREAM_RETRY_MAX_ATTEMPTS: "2",
      OAUTH_UPSTREAM_RETRY_BASE_DELAY_MS: "40",
      OAUTH_UPSTREAM_RETRY_429: "false",
      OAUTH_UPSTREAM_RETRY_5XX: "true",
      OAUTH_UPSTREAM_RETRY_TRANSPORT: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const results: CheckResult[] = []
  let virtualKey = ""

  try {
    await waitForHealth(bridgeOrigin, 20_000)
    const sync = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Behavior Audit",
        email: "behavior-audit@example.com",
        accountId: "org-behavior-audit",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: true,
        keyName: "Behavior Audit Key",
      }),
    })
    virtualKey = sync.virtualKey?.key ?? ""
    assertCondition(virtualKey, "virtual key missing")

    const requestResponses = async (input: {
      caseId: string
      body?: Record<string, unknown>
      headers?: Record<string, string>
    }) => {
      const startedAt = Date.now()
      const response = await fetch(`${bridgeOrigin}/v1/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${virtualKey}`,
          originator: CODEX_ORIGINATOR,
          "User-Agent": userAgent,
          version: CODEX_CLIENT_VERSION,
          "openai-beta": "responses=v1",
          "x-audit-case": input.caseId,
          ...(input.headers ?? {}),
        },
        body: JSON.stringify(
          input.body ?? {
            model: "gpt-5.4",
            input: [{ role: "user", content: [{ type: "input_text", text: input.caseId }] }],
            instructions: "behavior-audit",
            prompt_cache_key: `sess-${input.caseId}`,
            store: false,
            stream: false,
          },
        ),
      })
      const latencyMs = Date.now() - startedAt
      const text = await response.text().catch(() => "")
      return { response, text, latencyMs }
    }

    // 1) Failure retry mode (5xx -> retry -> success).
    const retryResponse = await requestResponses({ caseId: "retry-5xx" })
    const retryFindings: string[] = []
    if (retryResponse.response.status !== 200) {
      retryFindings.push(`expected 200 after retries, got ${retryResponse.response.status}`)
    }
    if (retryCaseCount !== 3) {
      retryFindings.push(`expected 3 upstream attempts, got ${retryCaseCount}`)
    }
    results.push({
      id: "failure_retry_mode",
      description: "5xx upstream failures should retry with codex-compatible cadence.",
      passed: retryFindings.length === 0,
      findings: retryFindings,
    })

    // 2) Burst traffic should pass through without behavior-layer blocking.
    const burst1 = await requestResponses({ caseId: "burst-1" })
    const burst2 = await requestResponses({ caseId: "burst-2" })
    const burst3 = await requestResponses({ caseId: "burst-3" })
    const burstFindings: string[] = []
    for (const [index, item] of [burst1, burst2, burst3].entries()) {
      if (item.response.status !== 200) {
        burstFindings.push(`burst-${index + 1} expected 200, got ${item.response.status}`)
      }
      if (hasBehaviorBlockMarker(item.text)) {
        burstFindings.push(`burst-${index + 1} contains unexpected behavior block marker`)
      }
    }
    const burstCaptured = captured.filter((item) => item.caseId.startsWith("burst-"))
    if (burstCaptured.length !== 3) {
      burstFindings.push(`expected 3 burst requests to hit upstream, got ${burstCaptured.length}`)
    }
    results.push({
      id: "rate_burst_cadence",
      description: "Burst flow should not include custom behavior-layer throttling artifacts.",
      passed: burstFindings.length === 0,
      findings: burstFindings,
    })

    await Bun.sleep(300)

    // 3) Same-account egress switching should not trigger custom 409 guard.
    const egressA = await requestResponses({
      caseId: "egress-a",
      headers: { "x-forwarded-for": "10.10.10.1" },
    })
    const egressB = await requestResponses({
      caseId: "egress-b",
      headers: { "x-forwarded-for": "10.10.10.2" },
    })
    const egressFindings: string[] = []
    if (egressA.response.status !== 200) {
      egressFindings.push(`first egress request expected 200, got ${egressA.response.status}`)
    }
    if (egressB.response.status !== 200) {
      egressFindings.push(`second egress switch expected 200, got ${egressB.response.status}`)
    }
    if (hasBehaviorBlockMarker(egressB.text)) {
      egressFindings.push("unexpected behavior block marker in egress switch response")
    }
    results.push({
      id: "same_account_multi_egress",
      description: "Egress switch should not be rejected by custom behavior controls.",
      passed: egressFindings.length === 0,
      findings: egressFindings,
    })

    await Bun.sleep(300)

    // 4) Cross-region switch should not trigger custom 409 guard.
    const regionA = await requestResponses({
      caseId: "region-a",
      headers: {
        "x-forwarded-for": "10.10.10.1",
        "x-region": "cn-sh",
      },
    })
    const regionB = await requestResponses({
      caseId: "region-b",
      headers: {
        "x-forwarded-for": "10.10.10.1",
        "x-region": "us-ca",
      },
    })
    const regionFindings: string[] = []
    if (regionA.response.status !== 200) {
      regionFindings.push(`first region request expected 200, got ${regionA.response.status}`)
    }
    if (regionB.response.status !== 200) {
      regionFindings.push(`region switch expected 200, got ${regionB.response.status}`)
    }
    if (hasBehaviorBlockMarker(regionB.text)) {
      regionFindings.push("unexpected behavior block marker in region switch response")
    }
    results.push({
      id: "cross_region_switch",
      description: "Region switch should not be rejected by custom behavior controls.",
      passed: regionFindings.length === 0,
      findings: regionFindings,
    })

    await Bun.sleep(300)

    // 5) Concurrency should not be artificially capped by behavior layer.
    const concurrencyResponses = await Promise.all(
      Array.from({ length: 4 }).map((_, index) =>
        requestResponses({
          caseId: `concurrency-${index + 1}`,
          headers: { "x-forwarded-for": "10.10.10.1" },
        }),
      ),
    )
    const concurrencyFindings: string[] = []
    for (const [index, item] of concurrencyResponses.entries()) {
      if (item.response.status !== 200) {
        concurrencyFindings.push(`concurrency-${index + 1} expected 200, got ${item.response.status}`)
      }
      if (hasBehaviorBlockMarker(item.text)) {
        concurrencyFindings.push(`concurrency-${index + 1} contains unexpected behavior block marker`)
      }
    }
    if (upstreamMaxInFlightConcurrency < 3) {
      concurrencyFindings.push(
        `max upstream in-flight expected >=3 without behavior cap, got ${upstreamMaxInFlightConcurrency}`,
      )
    }
    results.push({
      id: "concurrency_cadence",
      description: "Parallel requests should pass without custom behavior concurrency cap.",
      passed: concurrencyFindings.length === 0,
      findings: concurrencyFindings,
    })
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstream.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const passedCount = results.filter((item) => item.passed).length
  const summary = `Behavior audit: ${passedCount}/${results.length} checks passed`

  const lines = [
    "# Codex Behavior Audit Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Summary: ${summary}`,
    "",
    "## Checks",
    ...results.flatMap((item) => {
      const head = [`### ${item.id}`, `- Description: ${item.description}`, `- Result: ${item.passed ? "PASS" : "FAIL"}`]
      if (item.findings.length === 0) return [...head, ""]
      return [...head, "- Findings:", ...item.findings.map((finding) => `  - ${finding}`), ""]
    }),
    "## Captured Request Count",
    `- Total captured upstream requests: ${captured.length}`,
    "",
  ]

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const defaultReportFile = path.join(reportDir, "codex-behavior-audit.md")
  let reportFile = defaultReportFile
  try {
    await writeFile(reportFile, lines.join("\n"), "utf8")
  } catch {
    reportFile = path.join(reportDir, `codex-behavior-audit-${Date.now()}.md`)
    await writeFile(reportFile, lines.join("\n"), "utf8")
  }

  console.log(summary)
  console.log(`Report saved: ${reportFile}`)

  if (results.some((item) => !item.passed)) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("Behavior audit failed:", error)
  process.exit(1)
})
