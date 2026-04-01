import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
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

type AccountsResponse = {
  accounts: Array<{
    id: string
    quota?: {
      status?: string
      primary?: {
        primary?: {
          remainingPercent?: number
        } | null
        secondary?: {
          remainingPercent?: number
        } | null
      } | null
    } | null
    routing?: {
      state?: string
      headroomPercent?: number | null
    } | null
  }>
}

type CapturedRequest = {
  at: number
  path: string
  token: string
  session: string
  status: number
}

type SendResult = {
  response: Response
  payload: Record<string, unknown>
  elapsedMs: number
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

async function writeReportWithFallback(reportDir: string, baseName: string, content: string) {
  const primaryPath = path.join(reportDir, baseName)
  try {
    await writeFile(primaryPath, content, "utf8")
    return primaryPath
  } catch {
    const fallbackPath = path.join(
      reportDir,
      `${path.basename(baseName, path.extname(baseName))}-${Date.now()}${path.extname(baseName)}`,
    )
    await writeFile(fallbackPath, content, "utf8")
    return fallbackPath
  }
}

function parseResponseSignal(text: string) {
  return {
    session: String(text.match(/session=([^;]+)/)?.[1] ?? ""),
    account: String(text.match(/account=([^;]+)/)?.[1] ?? ""),
    turn: Number(text.match(/turn=(\d+)/)?.[1] ?? "NaN"),
  }
}

function buildQuotaPayload(usedPercent: number, secondaryUsedPercent = usedPercent) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    plan_type: "team",
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: nowSeconds + 5 * 60 * 60,
      },
      secondary_window: {
        used_percent: secondaryUsedPercent,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: nowSeconds + 7 * 24 * 60 * 60,
      },
    },
    additional_rate_limits: [],
  }
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-quota-failover-"))
  const bridgePort = "4863"
  const upstreamPort = "4864"
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const capturedRequests: CapturedRequest[] = []
  const turnByAccountSession = new Map<string, number>()
  let exhaustedAccessToken = ""

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const url = new URL(request.url)
      const headers = headersToObject(request.headers)
      const body = await request.text()
      const parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      const session = String(headers["session_id"] ?? parsedBody.prompt_cache_key ?? parsedBody.session_id ?? "none")
      const accessToken = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")
      const caseId = String(headers["x-audit-case"] ?? "")

      if (url.pathname === "/backend-api/wham/usage") {
        const quotaPayload =
          accessToken === "quota-token-a"
            ? buildQuotaPayload(20)
            : accessToken === "quota-token-b"
              ? buildQuotaPayload(95)
              : accessToken === "quota-token-c"
                ? buildQuotaPayload(30)
                : buildQuotaPayload(50)
        return new Response(JSON.stringify(quotaPayload), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      }

      if (caseId === "quota-failover" && !exhaustedAccessToken) {
        exhaustedAccessToken = accessToken
      }

      const shouldQuotaFail = caseId.startsWith("quota-failover") && accessToken === exhaustedAccessToken
      if (shouldQuotaFail) {
        capturedRequests.push({
          at: Date.now(),
          path: url.pathname,
          token: accessToken,
          session,
          status: 429,
        })
        return new Response(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              code: "usage_limit_reached",
              message: "The usage limit has been reached",
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "11",
              "x-codex-active-limit": "codex",
              "x-codex-primary-used-percent": "100",
              "x-codex-primary-window-minutes": "300",
              "x-codex-primary-reset-at": "1774283031",
            },
          },
        )
      }

      const turnKey = `${session}|${accessToken}`
      const turn = (turnByAccountSession.get(turnKey) ?? 0) + 1
      turnByAccountSession.set(turnKey, turn)
      capturedRequests.push({
        at: Date.now(),
        path: url.pathname,
        token: accessToken,
        session,
        status: 200,
      })
      return new Response(
        JSON.stringify({
          id: `resp_${crypto.randomUUID()}`,
          object: "response",
          output_text: `session=${session};account=${accessToken};turn=${turn}`,
          usage: {
            input_tokens: 8,
            output_tokens: 6,
            total_tokens: 14,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )
    },
  })

  const startBridge = () => {
    const next = spawn("bun", ["src/index.ts"], {
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
    next.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
    next.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))
    return next
  }

  let child = startBridge()

  const findings: string[] = []

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const syncA = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Quota Audit A",
        email: "quota-a@example.com",
        accountId: "org-quota-a",
        accessToken: "quota-token-a",
        refreshToken: "quota-refresh-a",
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
        displayName: "Quota Audit B",
        email: "quota-b@example.com",
        accountId: "org-quota-b",
        accessToken: "quota-token-b",
        refreshToken: "quota-refresh-b",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })
    const syncC = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Quota Audit C",
        email: "quota-c@example.com",
        accountId: "org-quota-c",
        accessToken: "quota-token-c",
        refreshToken: "quota-refresh-c",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })
    const accountIdByAccessToken = new Map<string, string>([
      ["quota-token-a", syncA.account.id],
      ["quota-token-b", syncB.account.id],
      ["quota-token-c", syncC.account.id],
    ])
    const db = new Database(path.join(tempDataDir, "accounts.db"))
    db.query(`UPDATE accounts SET is_active = 1 WHERE id IN (?, ?, ?)`).run(syncA.account.id, syncB.account.id, syncC.account.id)
    db.close()
    child.kill("SIGTERM")
    await Bun.sleep(500)
    child = startBridge()
    await waitForHealth(bridgeOrigin, 20_000)
    const preferredAccessToken = "quota-token-a"
    const softDrainedAccessToken = "quota-token-b"
    const failoverAccessToken = "quota-token-c"

    const issued = (await requestJSON(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Quota Failover Pool Key",
      }),
    })) as { key: string }
    const virtualKey = issued.key
    assertCondition(virtualKey?.startsWith("ocsk_live_"), "pool key issue failed")

    const refreshedAccounts = await requestJSON<AccountsResponse>(`${bridgeOrigin}/api/accounts?refreshQuota=1&forceQuota=1`)
    const accountStateById = new Map(refreshedAccounts.accounts.map((account) => [account.id, account]))
    const quotaA = accountStateById.get(syncA.account.id)
    const quotaB = accountStateById.get(syncB.account.id)
    const quotaC = accountStateById.get(syncC.account.id)
    if (quotaA?.routing?.headroomPercent !== 80) {
      findings.push(`account A headroom expected=80 actual=${quotaA?.routing?.headroomPercent ?? "<missing>"}`)
    }
    if (quotaB?.routing?.state !== "soft_drained") {
      findings.push(`account B should be soft-drained after quota refresh: actual=${quotaB?.routing?.state ?? "<missing>"}`)
    }
    if (quotaC?.routing?.headroomPercent !== 70) {
      findings.push(`account C headroom expected=70 actual=${quotaC?.routing?.headroomPercent ?? "<missing>"}`)
    }

    const send = async (sessionId: string, caseId: string): Promise<SendResult> => {
      const body = JSON.stringify({
        model: "gpt-5.4",
        instructions: "quota failover continuity",
        input: [{ role: "user", content: [{ type: "input_text", text: `${caseId}-${sessionId}` }] }],
        prompt_cache_key: sessionId,
        stream: false,
        store: false,
      })
      const startedAt = process.hrtime.bigint()
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
      return {
        response,
        payload,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      }
    }

    const primarySession = "sess-quota-failover-001"
    const first = await send(primarySession, "quota-failover")
    if (first.response.status !== 200) {
      findings.push(`first failover request expected 200 after reroute, got ${first.response.status}`)
    }
    const firstSignal = parseResponseSignal(String(first.payload.output_text ?? ""))
    const healthyAccessToken = firstSignal.account
    if (!healthyAccessToken) {
      findings.push("missing healthy account marker after failover")
    }
    if (!exhaustedAccessToken) {
      findings.push("did not capture an exhausted account during first failover request")
    }
    if (healthyAccessToken && healthyAccessToken === exhaustedAccessToken) {
      findings.push("request remained on exhausted account instead of rerouting")
    }
    const expectedHealthySession = bindClientIdentifierToAccount({
      accountId: accountIdByAccessToken.get(healthyAccessToken),
      fieldKey: "session_id",
      value: primarySession,
    })
    if (firstSignal.session !== expectedHealthySession) {
      findings.push(`first failover response session mismatch: expected=${expectedHealthySession} actual=${firstSignal.session || "<empty>"}`)
    }

    const firstAttemptSequence = capturedRequests.filter((item) => item.path === "/backend-api/codex/responses").slice(0, 2)
    if (firstAttemptSequence.length !== 2) {
      findings.push(`first request expected 2 upstream attempts, got ${firstAttemptSequence.length}`)
    } else {
      if (firstAttemptSequence[0].status !== 429) {
        findings.push(`first upstream attempt expected 429, got ${firstAttemptSequence[0].status}`)
      }
      if (firstAttemptSequence[1].status !== 200) {
        findings.push(`second upstream attempt expected 200, got ${firstAttemptSequence[1].status}`)
      }
      if (firstAttemptSequence[0].token === firstAttemptSequence[1].token) {
        findings.push("second upstream attempt reused the exhausted account instead of rerouting")
      }
      if (firstAttemptSequence[0].token !== preferredAccessToken) {
        findings.push(`first upstream attempt should prefer healthiest account: expected=${preferredAccessToken} actual=${firstAttemptSequence[0].token}`)
      }
      if (firstAttemptSequence[1].token !== failoverAccessToken) {
        findings.push(`failover should route to next healthiest account: expected=${failoverAccessToken} actual=${firstAttemptSequence[1].token}`)
      }
      if (firstAttemptSequence[1].token === softDrainedAccessToken) {
        findings.push("failover incorrectly routed into a soft-drained account")
      }
    }

    const second = await send(primarySession, "quota-failover-followup")
    if (second.response.status !== 200) {
      findings.push(`follow-up failover request expected 200, got ${second.response.status}`)
    }
    const secondSignal = parseResponseSignal(String(second.payload.output_text ?? ""))
    if (secondSignal.account !== healthyAccessToken) {
      findings.push(`same session was not sticky after failover: expected=${healthyAccessToken} actual=${secondSignal.account || "<empty>"}`)
    }
    if (secondSignal.turn !== 2) {
      findings.push(`same session turn should continue on rerouted account: expected=2 actual=${secondSignal.turn}`)
    }

    const freshSession = "sess-quota-failover-002"
    const third = await send(freshSession, "quota-failover-new-session")
    if (third.response.status !== 200) {
      findings.push(`new-session request during cooldown expected 200, got ${third.response.status}`)
    }
    const thirdSignal = parseResponseSignal(String(third.payload.output_text ?? ""))
    if (thirdSignal.account === exhaustedAccessToken) {
      findings.push("new session incorrectly reused the exhausted account during cooldown")
    }
    if (thirdSignal.account !== failoverAccessToken) {
      findings.push(`new session should avoid soft-drained account during cooldown: expected=${failoverAccessToken} actual=${thirdSignal.account || "<empty>"}`)
    }
    const expectedThirdSession = bindClientIdentifierToAccount({
      accountId: accountIdByAccessToken.get(thirdSignal.account),
      fieldKey: "session_id",
      value: freshSession,
    })
    if (thirdSignal.session !== expectedThirdSession) {
      findings.push(`new-session bound session mismatch: expected=${expectedThirdSession} actual=${thirdSignal.session || "<empty>"}`)
    }

    if (
      capturedRequests.some(
        (item) => item.path === "/backend-api/codex/responses" && item.token === softDrainedAccessToken,
      )
    ) {
      findings.push("soft-drained account should not receive responses traffic while healthier accounts exist")
    }

    const reportDir = path.join(process.cwd(), "_tmp", "parity")
    await mkdir(reportDir, { recursive: true })
    const lines = [
      "# Codex Quota Failover Audit",
      "",
      `Generated at: ${new Date().toISOString()}`,
      `Exhausted account token: ${exhaustedAccessToken || "-"}`,
      `Soft-drained account token: ${softDrainedAccessToken}`,
      `Healthy account token after failover: ${healthyAccessToken || "-"}`,
      `Failover request latency: ${first.elapsedMs.toFixed(2)} ms`,
      `Sticky follow-up latency: ${second.elapsedMs.toFixed(2)} ms`,
      `Fresh-session latency: ${third.elapsedMs.toFixed(2)} ms`,
      "",
      "## Verdict",
      findings.length === 0 ? "- PASS: quota exhaustion reroutes within-request and stays sticky on the new account." : `- FAIL: ${findings.join(" | ")}`,
      "",
      "## Captured Upstream Attempts",
      ...capturedRequests.map((item, index) => `- #${index + 1} path=${item.path} status=${item.status} token=${item.token} session=${item.session}`),
      "",
    ]
    const reportContent = lines.join("\n")
    const reportFile = await writeReportWithFallback(reportDir, "codex-quota-failover-audit.md", reportContent)

    if (findings.length === 0) {
      console.log("Quota failover audit passed")
      console.log(`Report saved: ${reportFile}`)
      return
    }

    console.error("Quota failover audit failed")
    console.error(`Report saved: ${reportFile}`)
    process.exit(1)
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("Quota failover audit failed:", error)
  process.exit(1)
})
