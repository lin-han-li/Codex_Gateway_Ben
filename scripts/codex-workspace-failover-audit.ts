import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type SyncResponse = {
  account: {
    id: string
  }
}

type IssueVirtualKeyResponse = {
  key: string
  record: {
    id: string
  }
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
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-workspace-failover-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)
  const badToken = "workspace-deactivated-a"

  const capturedRequests: Array<{ path: string; token: string; status: number; session: string }> = []

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
        return new Response(JSON.stringify(buildQuotaPayload(20)), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      }

      if (url.pathname === "/backend-api/codex/responses") {
        if (accessToken === badToken) {
          capturedRequests.push({
            path: url.pathname,
            token: accessToken,
            status: 402,
            session,
          })
          return new Response(
            JSON.stringify({
              detail: {
                code: "deactivated_workspace",
              },
            }),
            {
              status: 402,
              headers: {
                "content-type": "application/json",
              },
            },
          )
        }

        capturedRequests.push({
          path: url.pathname,
          token: accessToken,
          status: 200,
          session,
        })
        return new Response(
          JSON.stringify({
            id: `resp_${crypto.randomUUID()}`,
            object: "response",
            output_text: `session=${session};account=${accessToken}`,
            usage: {
              input_tokens: 7,
              output_tokens: 5,
              total_tokens: 12,
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

    const badAccount = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Workspace Failover A",
        email: "workspace-failover-a@example.com",
        accountId: "org-workspace-failover-a",
        accessToken: badToken,
        refreshToken: `refresh-${badToken}`,
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
        displayName: "Workspace Failover B",
        email: "workspace-failover-b@example.com",
        accountId: "org-workspace-failover-b",
        accessToken: "workspace-healthy-b",
        refreshToken: "refresh-workspace-healthy-b",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })

    const issued = await requestJSON<IssueVirtualKeyResponse>(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Workspace Failover Pool Key",
      }),
    })
    assertCondition(issued.key?.startsWith("ocsk_live_"), "pool key issue failed")
    assertCondition(issued.record?.id, "pool key record id missing")

    const forcedSessionId = "workspace-failover-session"
    const db = new Database(path.join(tempDataDir, "accounts.db"))
    try {
      const now = Date.now()
      db.query(
        `
          INSERT INTO virtual_key_sessions (
            key_id,
            session_id,
            account_id,
            request_count,
            last_used_at,
            updated_at
          ) VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(key_id, session_id) DO UPDATE SET
            account_id = excluded.account_id,
            request_count = excluded.request_count,
            last_used_at = excluded.last_used_at,
            updated_at = excluded.updated_at
        `,
      ).run(issued.record.id, forcedSessionId, badAccount.account.id, now, now)
    } finally {
      db.close()
    }

    const response = await fetch(`${bridgeOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${issued.key}`,
        "user-agent": userAgent,
        accept: "application/json",
        session_id: forcedSessionId,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "workspace failover",
        prompt_cache_key: forcedSessionId,
      }),
    })

    const responseBody = await response.text()
    if (response.status !== 200) {
      findings.push(`responses route expected=200 actual=${response.status} body=${responseBody}`)
    } else {
      const parsedBody = JSON.parse(responseBody) as { output_text?: string }
      const signal = parseResponseSignal(String(parsedBody.output_text ?? ""))
      if (signal.account !== "workspace-healthy-b") {
        findings.push(`expected healthy fallback account, got ${signal.account || "<missing>"}`)
      }
      if (!signal.session) {
        findings.push("expected output_text to preserve session marker")
      }
    }

    if (capturedRequests.length < 2) {
      findings.push(`expected at least 2 upstream attempts, saw ${capturedRequests.length}`)
    }
    const statuses = capturedRequests.map((entry) => entry.status)
    if (!statuses.includes(402) || !statuses.includes(200)) {
      findings.push(`expected one 402 and one 200 attempt, saw statuses=${statuses.join(",")}`)
    }

    const reportLines = [
      "# Codex Workspace Deactivated Failover Audit",
      "",
      `- Bridge origin: ${bridgeOrigin}`,
      `- Upstream origin: ${upstreamOrigin}`,
      `- Attempts observed: ${capturedRequests.length}`,
      "",
      "## Attempts",
      "",
      ...capturedRequests.map(
        (entry, index) => `1. ${index + 1}: token=${entry.token} status=${entry.status} session=${entry.session} path=${entry.path}`,
      ),
      "",
      "## Result",
      "",
      findings.length === 0 ? "- PASS" : "- FAIL",
      ...findings.map((finding) => `- ${finding}`),
      "",
    ]

    const reportDir = path.join(process.cwd(), "_tmp", "parity")
    await mkdir(reportDir, { recursive: true })
    const reportPath = await writeReportWithFallback(
      reportDir,
      "codex-workspace-failover-audit.md",
      reportLines.join("\n"),
    )

    if (findings.length > 0) {
      throw new Error(`Workspace failover audit failed. See ${reportPath}`)
    }

    console.log(`codex-workspace-failover-audit passed. Report: ${reportPath}`)
  } finally {
    child.kill()
    upstreamServer.stop(true)
    await rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
