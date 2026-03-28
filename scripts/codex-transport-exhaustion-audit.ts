import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
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
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-transport-exhaustion-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const capturedRequests: CapturedRequest[] = []
  const upstreamServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", upstreamOrigin)
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value ?? ""]),
    )

    let body = ""
    for await (const chunk of request) {
      body += String(chunk)
    }
    const parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    const session = String(headers["session_id"] ?? parsedBody.prompt_cache_key ?? parsedBody.session_id ?? "none")
    const accessToken = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")

    if (url.pathname === "/backend-api/wham/usage") {
      response.writeHead(200, {
        "content-type": "application/json",
      })
      response.end(JSON.stringify(buildQuotaPayload(20)))
      return
    }

    if (url.pathname === "/backend-api/codex/responses") {
      capturedRequests.push({
        path: url.pathname,
        token: accessToken,
        session,
      })
      request.socket.destroy()
      return
    }

    response.writeHead(404, {
      "content-type": "text/plain",
    })
    response.end("not found")
  })

  await new Promise<void>((resolve, reject) => {
    upstreamServer.listen(upstreamPort, "127.0.0.1", (error?: Error) => {
      if (error) reject(error)
      else resolve()
    })
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
      ["A", "transport-exhaust-a"],
      ["B", "transport-exhaust-b"],
    ] as const) {
      await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "chatgpt",
          providerName: "ChatGPT",
          methodId: "codex-oauth",
          displayName: `Transport Exhaust ${label}`,
          email: `transport-exhaust-${label.toLowerCase()}@example.com`,
          accountId: `org-transport-exhaust-${label.toLowerCase()}`,
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
        name: "Transport Exhaustion Pool Key",
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
        session_id: "sess-transport-exhaust-001",
        "openai-beta": "responses=v1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        instructions: "transport pool exhaustion normalization",
        input: [{ role: "user", content: [{ type: "input_text", text: "transport exhaustion" }] }],
        prompt_cache_key: "sess-transport-exhaust-001",
        stream: false,
        store: false,
      }),
    })

    const responseText = await response.text()
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(responseText) as Record<string, unknown>
    } catch {
      // validated below
    }

    if (response.status !== 503) {
      findings.push(`expected pool transport exhaustion to return 503, got ${response.status}`)
    }

    const errorObject =
      payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : null
    if (!errorObject) {
      findings.push(`expected JSON error object, got: ${responseText}`)
    } else {
      if (errorObject.code !== "upstream_account_unavailable") {
        findings.push(`expected upstream_account_unavailable code, got ${String(errorObject.code ?? "missing")}`)
      }
      if (errorObject.message !== "No healthy accounts available for pool routing") {
        findings.push(`unexpected error message: ${String(errorObject.message ?? "missing")}`)
      }
    }

    for (const leaked of [
      "Unable to connect. Is the computer able to access the url?",
      "The socket connection was closed unexpectedly",
      "fetch failed",
    ]) {
      if (responseText.includes(leaked)) {
        findings.push(`raw transport error leaked to client: ${leaked}`)
      }
    }

    const distinctTokens = new Set(capturedRequests.map((entry) => entry.token))
    if (capturedRequests.length < 2) {
      findings.push(`expected at least 2 upstream transport attempts, saw ${capturedRequests.length}`)
    }
    if (distinctTokens.size !== 2) {
      findings.push(`expected both pool accounts to be attempted, saw ${distinctTokens.size} distinct account token(s)`)
    }

    const reportLines = [
      "# Codex Transport Exhaustion Audit",
      "",
      `- Bridge origin: ${bridgeOrigin}`,
      `- Upstream origin: ${upstreamOrigin}`,
      `- Attempts observed: ${capturedRequests.length}`,
      `- Distinct account tokens observed: ${distinctTokens.size}`,
      "",
      "## Attempts",
      "",
      ...capturedRequests.map((entry, index) => `1. ${index + 1}: ${entry.token} session=${entry.session} path=${entry.path}`),
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
      "codex-transport-exhaustion-audit.md",
      reportLines.join("\n"),
    )

    if (findings.length > 0) {
      throw new Error(`Transport exhaustion audit failed. See ${reportPath}`)
    }

    console.log(`[codex-transport-exhaustion-audit] PASS -> ${reportPath}`)
  } finally {
    child.kill()
    upstreamServer.close()
    await rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
