import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

type IssuedVirtualKeyResponse = {
  key: string
}

type CapturedRequest = {
  path: string
  token: string
  session: string
  status: number
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
      // bridge still booting
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
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-transient-exhaustion-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const capturedRequests: CapturedRequest[] = []
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
        capturedRequests.push({
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

    for (const [label, token] of [
      ["A", "transient-exhaust-a"],
      ["B", "transient-exhaust-b"],
    ] as const) {
      await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "chatgpt",
          providerName: "ChatGPT",
          methodId: "codex-oauth",
          displayName: `Transient Exhaust ${label}`,
          email: `transient-exhaust-${label.toLowerCase()}@example.com`,
          accountId: `org-transient-exhaust-${label.toLowerCase()}`,
          accessToken: token,
          refreshToken: `refresh-${token}`,
          expiresAt: Date.now() + 3600_000,
          issueVirtualKey: false,
        }),
      })
    }

    const issued = await requestJSON<IssuedVirtualKeyResponse>(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Transient Exhaustion Pool Key",
      }),
    })
    assertCondition(issued.key.startsWith("ocsk_live_"), "pool key issue failed")

    const response = await fetch(`${bridgeOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${issued.key}`,
        originator: CODEX_ORIGINATOR,
        "user-agent": userAgent,
        version: CODEX_CLIENT_VERSION,
        session_id: "sess-transient-exhaust-001",
        "openai-beta": "responses=v1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        instructions: "transient pool exhaustion normalization",
        input: [{ role: "user", content: [{ type: "input_text", text: "pool exhaustion" }] }],
        prompt_cache_key: "sess-transient-exhaust-001",
        stream: false,
        store: false,
      }),
    })

    const responseText = await response.text()
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(responseText) as Record<string, unknown>
    } catch {
      // handled below
    }

    if (response.status !== 503) {
      findings.push(`expected pool transient exhaustion to return 503, got ${response.status}`)
    }

    const errorObject =
      payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : null
    if (String(errorObject?.code ?? "") !== "upstream_account_unavailable") {
      findings.push(`expected normalized error code upstream_account_unavailable, got ${String(errorObject?.code ?? "<missing>")}`)
    }
    if (!String(errorObject?.message ?? "").includes("No healthy accounts available for pool routing")) {
      findings.push(`expected normalized pool routing message, got ${String(errorObject?.message ?? "<missing>")}`)
    }
    if (responseText.includes("Unknown error")) {
      findings.push("raw upstream 5xx payload leaked to client")
    }

    const responseAttempts = capturedRequests.filter((item) => item.path === "/backend-api/codex/responses")
    if (responseAttempts.length !== 2) {
      findings.push(`expected exactly 2 upstream response attempts for 2 pool accounts, got ${responseAttempts.length}`)
    }
    const attemptedTokens = new Set(responseAttempts.map((item) => item.token))
    if (attemptedTokens.size !== 2) {
      findings.push(`expected both pool accounts to be attempted before exhaustion, got ${[...attemptedTokens].join(",") || "<none>"}`)
    }

    const reportDir = path.join(process.cwd(), "_tmp", "parity")
    await mkdir(reportDir, { recursive: true })
    const reportContent = [
      "# Codex Transient Exhaustion Audit",
      "",
      `Generated at: ${new Date().toISOString()}`,
      `Bridge origin: ${bridgeOrigin}`,
      `Upstream origin: ${upstreamOrigin}`,
      "",
      "## Verdict",
      findings.length === 0
        ? "- PASS: pool transient exhaustion normalizes the final failure to a 503 pool-unavailable response."
        : `- FAIL: ${findings.join(" | ")}`,
      "",
      "## Client Response",
      `- Status: ${response.status}`,
      `- Body: ${responseText}`,
      "",
      "## Captured Upstream Attempts",
      ...responseAttempts.map((item, index) => `- #${index + 1} token=${item.token} status=${item.status} session=${item.session}`),
      "",
    ].join("\n")
    const reportFile = await writeReportWithFallback(reportDir, "codex-transient-exhaustion-audit.md", reportContent)

    if (findings.length === 0) {
      console.log("Transient exhaustion audit passed")
      console.log(`Report saved: ${reportFile}`)
      return
    }

    console.error("Transient exhaustion audit failed")
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
  console.error("Transient exhaustion audit failed:", error)
  process.exit(1)
})
