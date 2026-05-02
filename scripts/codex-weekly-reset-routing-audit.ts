import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type SyncResponse = {
  account: { id: string }
}

type IssueKeyResponse = {
  key: string
}

type AccountsResponse = {
  accounts: Array<{
    id: string
    quotaWeeklyResetAt?: number | null
    quota?: {
      status?: string
      primary?: {
        secondary?: {
          resetsAt?: number | null
          remainingPercent?: number | null
        } | null
      } | null
    } | null
    abnormalState?: {
      category?: string | null
      classification?: string | null
      reason?: string | null
      label?: string | null
    } | null
  }>
}

type CapturedRequest = {
  at: number
  path: string
  token: string
  status: number
  session: string
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
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

async function stopBridgeProcess(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
  })
  child.kill("SIGTERM")
  const exitedGracefully = await Promise.race([exited.then(() => true), Bun.sleep(1500).then(() => false)])
  if (exitedGracefully) return
  child.kill("SIGKILL")
  await Promise.race([exited, Bun.sleep(1500)])
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

function headersToObject(headers: Headers) {
  const output: Record<string, string> = {}
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value
  })
  return output
}

function buildQuotaPayload(input: { usedPercent: number; weeklyResetMs: number }) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    plan_type: "team",
    rate_limit: {
      primary_window: {
        used_percent: input.usedPercent,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: nowSeconds + 5 * 60 * 60,
      },
      secondary_window: {
        used_percent: input.usedPercent,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: Math.floor((Date.now() + input.weeklyResetMs) / 1000),
      },
    },
    additional_rate_limits: [],
  }
}

function parseSelectedToken(payload: Record<string, unknown>) {
  return String(payload.output_text ?? "").match(/token=([^;]+)/)?.[1] ?? ""
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-weekly-reset-routing-"))
  const bridgePort = await reserveFreePort()
  let upstreamPort = await reserveFreePort()
  while (upstreamPort === bridgePort) upstreamPort = await reserveFreePort()

  const origin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const tokenA = "weekly-reset-token-a"
  const tokenB = "weekly-reset-token-b"
  const tokenC = "weekly-reset-token-c"
  const tokenD = "weekly-reset-token-d-zero"
  const resetMsByToken = new Map<string, number>([
    [tokenA, 6 * 24 * 60 * 60 * 1000],
    [tokenB, 1 * 24 * 60 * 60 * 1000],
    [tokenC, 3 * 24 * 60 * 60 * 1000],
    [tokenD, 8 * 24 * 60 * 60 * 1000],
  ])
  const usedPercentByToken = new Map<string, number>([
    [tokenA, 50],
    [tokenB, 50],
    [tokenC, 50],
    [tokenD, 100],
  ])
  const capturedRequests: CapturedRequest[] = []

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const url = new URL(request.url)
      const headers = headersToObject(request.headers)
      const token = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const session = String(headers.session_id ?? body.prompt_cache_key ?? body.session_id ?? "none")

      if (url.pathname === "/backend-api/wham/usage") {
        capturedRequests.push({ at: Date.now(), path: url.pathname, token, status: 200, session })
        return new Response(
          JSON.stringify(
            buildQuotaPayload({
              usedPercent: usedPercentByToken.get(token) ?? 50,
              weeklyResetMs: resetMsByToken.get(token) ?? 7 * 24 * 60 * 60 * 1000,
            }),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      }

      if (url.pathname === "/backend-api/codex/responses") {
        capturedRequests.push({ at: Date.now(), path: url.pathname, token, status: 200, session })
        return new Response(
          JSON.stringify({
            id: `resp_${crypto.randomUUID()}`,
            object: "response",
            output_text: `token=${token};session=${session}`,
            usage: {
              input_tokens: 8,
              output_tokens: 6,
              total_tokens: 14,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      }

      if (url.pathname === "/backend-api/models" || url.pathname === "/backend-api/codex/models") {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.4", object: "model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      return new Response(JSON.stringify({ error: "unexpected path" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    },
  })

  const startBridge = () => {
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
    return child
  }

  let child = startBridge()
  const findings: string[] = []

  try {
    await waitForHealth(origin, 20_000)

    const syncAccount = async (input: { label: string; token: string }) => {
      const slug = input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      return await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "chatgpt",
          providerName: "ChatGPT",
          methodId: "codex-oauth",
          displayName: input.label,
          email: `${slug}@example.com`,
          accountId: `org-${slug}`,
          accessToken: input.token,
          refreshToken: `${input.token}-refresh`,
          expiresAt: Date.now() + 3600_000,
          chatgptPlanType: "Business",
          issueVirtualKey: false,
        }),
      })
    }

    const accountA = await syncAccount({ label: "Weekly Reset A", token: tokenA })
    const accountB = await syncAccount({ label: "Weekly Reset B", token: tokenB })
    const accountC = await syncAccount({ label: "Weekly Reset C", token: tokenC })
    const accountD = await syncAccount({ label: "Weekly Reset D Zero", token: tokenD })

    const db = new Database(path.join(tempDataDir, "accounts.db"))
    db.query(`UPDATE accounts SET is_active = 1 WHERE id IN (?, ?, ?, ?)`).run(
      accountA.account.id,
      accountB.account.id,
      accountC.account.id,
      accountD.account.id,
    )
    db.close()

    await stopBridgeProcess(child)
    child = startBridge()
    await waitForHealth(origin, 20_000)

    const refreshed = await requestJSON<AccountsResponse>(`${origin}/api/accounts?refreshQuota=1&forceQuota=1`)
    const refreshedIds = refreshed.accounts.map((account) => account.id)
    const expectedDisplayOrder = [accountB.account.id, accountC.account.id, accountA.account.id, accountD.account.id]
    const actualDisplayOrder = refreshed.accounts
      .filter((account) => expectedDisplayOrder.includes(account.id))
      .map((account) => account.id)
    if (actualDisplayOrder.join(",") !== expectedDisplayOrder.join(",")) {
      findings.push(
        `account display order expected=${expectedDisplayOrder.join(" > ")} actual=${actualDisplayOrder.join(" > ")}`,
      )
    }

    const quotaByAccountId = new Map(refreshed.accounts.map((account) => [account.id, account]))
    for (const accountId of expectedDisplayOrder) {
      const account = quotaByAccountId.get(accountId)
      if (!Number.isFinite(Number(account?.quotaWeeklyResetAt ?? NaN))) {
        findings.push(`missing public quotaWeeklyResetAt for account=${accountId}`)
      }
      if (account?.quota?.status !== "ok") {
        findings.push(`quota snapshot not ok for account=${accountId}`)
      }
    }
    const zeroQuotaAccount = quotaByAccountId.get(accountD.account.id)
    if (zeroQuotaAccount?.abnormalState?.category !== "quota_exhausted") {
      findings.push(`0% quota account should display quota_exhausted, actual=${JSON.stringify(zeroQuotaAccount?.abnormalState ?? null)}`)
    }
    if (zeroQuotaAccount?.abnormalState?.reason !== "quota_window_exhausted") {
      findings.push(`0% quota account reason expected=quota_window_exhausted actual=${zeroQuotaAccount?.abnormalState?.reason ?? "<missing>"}`)
    }

    const issued = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Weekly Reset Pool Key",
      }),
    })
    assertCondition(issued.key?.startsWith("ocsk_live_"), "pool key issue failed")

    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${issued.key}`,
        originator: CODEX_ORIGINATOR,
        "user-agent": userAgent,
        version: CODEX_CLIENT_VERSION,
        session_id: "weekly-reset-session-1",
        "openai-beta": "responses=v1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        instructions: "weekly reset routing audit",
        input: [{ role: "user", content: [{ type: "input_text", text: "weekly reset routing" }] }],
        prompt_cache_key: "weekly-reset-session-1",
        stream: false,
        store: false,
      }),
    })
    const responsePayload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (response.status !== 200) {
      findings.push(`responses request expected 200, got ${response.status}: ${JSON.stringify(responsePayload)}`)
    }
    const selectedToken = parseSelectedToken(responsePayload)
    if (selectedToken !== tokenB) {
      findings.push(`weekly-reset routing expected token=${tokenB} actual=${selectedToken || "<empty>"}`)
    }

    const reportDir = path.join(process.cwd(), "_tmp", "parity")
    await mkdir(reportDir, { recursive: true })
    const reportLines = [
      "# Codex Weekly Reset Routing Audit",
      "",
      `Generated at: ${new Date().toISOString()}`,
      `Bridge: ${origin}`,
      `Upstream: ${upstreamOrigin}`,
      "",
      "## Weekly Reset Inputs",
      `- ${tokenA}: +6d account=${accountA.account.id}`,
      `- ${tokenB}: +1d account=${accountB.account.id}`,
      `- ${tokenC}: +3d account=${accountC.account.id}`,
      `- ${tokenD}: +8d account=${accountD.account.id} used=100%`,
      "",
      "## Account API Order",
      `- expected: ${expectedDisplayOrder.join(" > ")}`,
      `- actual: ${actualDisplayOrder.join(" > ")}`,
      `- raw: ${refreshedIds.join(" > ")}`,
      "",
      "## Routing Result",
      `- selected token: ${selectedToken || "-"}`,
      "",
      "## Captured Requests",
      ...capturedRequests.map(
        (item, index) =>
          `- #${index + 1} path=${item.path} status=${item.status} token=${item.token || "-"} session=${item.session}`,
      ),
      "",
      "## Verdict",
      findings.length === 0
        ? "- PASS: same-cohort accounts display and route by soonest weekly quota reset without quota pre-exclusion."
        : `- FAIL: ${findings.join(" | ")}`,
      "",
    ]
    const reportFile = await writeReportWithFallback(
      reportDir,
      "codex-weekly-reset-routing-audit.md",
      reportLines.join("\n"),
    )

    if (findings.length > 0) {
      console.error("Weekly reset routing audit failed")
      console.error(`Report saved: ${reportFile}`)
      process.exit(1)
    }

    console.log("Weekly reset routing audit passed")
    console.log(`Report saved: ${reportFile}`)
  } finally {
    await stopBridgeProcess(child)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("Weekly reset routing audit failed:", error)
  process.exit(1)
})
