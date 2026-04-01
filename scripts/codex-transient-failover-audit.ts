import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import net from "node:net"
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

type AccountsResponse = {
  accounts: Array<{
    id: string
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
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function reserveFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve dynamic port")))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
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

function buildQuotaPayload(usedPercent: number) {
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
        used_percent: usedPercent,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: nowSeconds + 7 * 24 * 60 * 60,
      },
    },
    additional_rate_limits: [],
  }
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-transient-failover-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const capturedRequests: CapturedRequest[] = []
  const turnByAccountSession = new Map<string, number>()
  const transientFailedToken = "transient-token-a"

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const url = new URL(request.url)
      const headers = Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]))
      const body = await request.text()
      const parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      const session = String(headers["session_id"] ?? parsedBody.prompt_cache_key ?? parsedBody.session_id ?? "none")
      const accessToken = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")

      if (url.pathname === "/backend-api/wham/usage") {
        const quotaPayload =
          accessToken === transientFailedToken
            ? buildQuotaPayload(10)
            : accessToken === "transient-token-b"
              ? buildQuotaPayload(30)
              : buildQuotaPayload(94)
        return new Response(JSON.stringify(quotaPayload), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      }

      if (url.pathname === "/backend-api/codex/responses") {
        if (accessToken === transientFailedToken) {
          capturedRequests.push({
            at: Date.now(),
            path: url.pathname,
            token: accessToken,
            session,
            status: 502,
          })
          return new Response(
            JSON.stringify({
              error: {
                message: "Unknown error",
                type: "server_error",
              },
            }),
            {
              status: 502,
              headers: {
                "content-type": "application/json",
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
      }

      return new Response("not found", { status: 404 })
    },
  })

  const child = spawn("bun", ["src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OAUTH_APP_HOST: "127.0.0.1",
      OAUTH_APP_PORT: String(bridgePort),
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
        displayName: "Transient Audit A",
        email: "transient-a@example.com",
        accountId: "org-transient-a",
        accessToken: transientFailedToken,
        refreshToken: "transient-refresh-a",
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
        displayName: "Transient Audit B",
        email: "transient-b@example.com",
        accountId: "org-transient-b",
        accessToken: "transient-token-b",
        refreshToken: "transient-refresh-b",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })
    await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Transient Audit C",
        email: "transient-c@example.com",
        accountId: "org-transient-c",
        accessToken: "transient-token-c",
        refreshToken: "transient-refresh-c",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })

    const accountIdByAccessToken = new Map<string, string>([
      [transientFailedToken, syncA.account.id],
      ["transient-token-b", syncB.account.id],
    ])

    const issued = (await requestJSON(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Transient Failover Pool Key",
      }),
    })) as { key: string }
    const virtualKey = issued.key
    assertCondition(virtualKey?.startsWith("ocsk_live_"), "pool key issue failed")

    const refreshedAccounts = await requestJSON<AccountsResponse>(`${bridgeOrigin}/api/accounts?refreshQuota=1&forceQuota=1`)
    const accountStateById = new Map(refreshedAccounts.accounts.map((account) => [account.id, account]))
    if (accountStateById.get(syncA.account.id)?.routing?.headroomPercent !== 90) {
      findings.push(`account A headroom expected=90 actual=${accountStateById.get(syncA.account.id)?.routing?.headroomPercent ?? "<missing>"}`)
    }
    if (accountStateById.get(syncB.account.id)?.routing?.headroomPercent !== 70) {
      findings.push(`account B headroom expected=70 actual=${accountStateById.get(syncB.account.id)?.routing?.headroomPercent ?? "<missing>"}`)
    }

    const send = async (sessionId: string): Promise<SendResult> => {
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
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          instructions: "transient failover continuity",
          input: [{ role: "user", content: [{ type: "input_text", text: sessionId }] }],
          prompt_cache_key: sessionId,
          stream: false,
          store: false,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
      return { response, payload }
    }

    const primarySession = "sess-transient-failover-001"
    const first = await send(primarySession)
    if (first.response.status !== 200) {
      findings.push(`first transient failover request expected 200 after reroute, got ${first.response.status}`)
    }
    const firstSignal = parseResponseSignal(String(first.payload.output_text ?? ""))
    if (!firstSignal.account) {
      findings.push("missing healthy account marker after transient failover")
    }
    if (firstSignal.account === transientFailedToken) {
      findings.push("request remained on transiently failing account instead of rerouting")
    }

    const expectedBoundSession = bindClientIdentifierToAccount({
      accountId: accountIdByAccessToken.get(firstSignal.account),
      fieldKey: "session_id",
      value: primarySession,
    })
    if (firstSignal.session !== expectedBoundSession) {
      findings.push(`rerouted session binding mismatch: expected=${expectedBoundSession} actual=${firstSignal.session || "<empty>"}`)
    }

    const firstAttemptSequence = capturedRequests.filter((item) => item.path === "/backend-api/codex/responses")
    if (firstAttemptSequence.length < 1) {
      findings.push("first request did not reach upstream")
    } else {
      const finalFirstAttempt = firstAttemptSequence[firstAttemptSequence.length - 1]
      if (finalFirstAttempt.status !== 200) {
        findings.push(`first request final upstream attempt expected 200, got ${finalFirstAttempt.status}`)
      }
      if (finalFirstAttempt.token !== "transient-token-b") {
        findings.push(`first request should finish on a healthy rerouted account: expected=transient-token-b actual=${finalFirstAttempt.token}`)
      }
      if (firstAttemptSequence.length > 1) {
        const leadingAttempts = firstAttemptSequence.slice(0, -1)
        for (const [index, attempt] of leadingAttempts.entries()) {
          if (attempt.status !== 502) {
            findings.push(`first request transient pre-attempt #${index + 1} expected 502, got ${attempt.status}`)
          }
          if (attempt.token !== transientFailedToken) {
            findings.push(
              `first request transient pre-attempt #${index + 1} should stay on the initially preferred account: expected=${transientFailedToken} actual=${attempt.token}`,
            )
          }
        }
      }
    }

    const followup = await send(primarySession)
    if (followup.response.status !== 200) {
      findings.push(`follow-up transient failover request expected 200, got ${followup.response.status}`)
    }
    const followupSignal = parseResponseSignal(String(followup.payload.output_text ?? ""))
    if (followupSignal.account !== "transient-token-b") {
      findings.push(`same session was not sticky after transient failover: expected=transient-token-b actual=${followupSignal.account || "<empty>"}`)
    }
    if (followupSignal.turn !== 2) {
      findings.push(`same session turn should continue on rerouted account: expected=2 actual=${followupSignal.turn}`)
    }

    const reportDir = path.join(process.cwd(), "_tmp", "parity")
    await mkdir(reportDir, { recursive: true })
    const reportContent = [
      "# Codex Transient Failover Audit",
      "",
      `Generated at: ${new Date().toISOString()}`,
      `Failed account token: ${transientFailedToken}`,
      `Healthy account token after failover: ${firstSignal.account || "-"}`,
      "",
      "## Verdict",
      findings.length === 0 ? "- PASS: transient upstream 5xx reroutes within-request and stays sticky on the new account." : `- FAIL: ${findings.join(" | ")}`,
      "",
      "## Captured Upstream Attempts",
      ...capturedRequests.map((item, index) => `- #${index + 1} path=${item.path} status=${item.status} token=${item.token} session=${item.session}`),
      "",
    ].join("\n")
    const reportFile = await writeReportWithFallback(reportDir, "codex-transient-failover-audit.md", reportContent)

    if (findings.length === 0) {
      console.log("Transient failover audit passed")
      console.log(`Report saved: ${reportFile}`)
      return
    }

    console.error("Transient failover audit failed")
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
  console.error("Transient failover audit failed:", error)
  process.exit(1)
})
