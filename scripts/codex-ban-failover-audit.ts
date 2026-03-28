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

async function stopChildProcess(child: ReturnType<typeof spawn>) {
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
  })
  if (!child.killed) child.kill()
  await Promise.race([exited, Bun.sleep(5_000)])
  await Bun.sleep(200)
}

function parseResponseSignal(text: string) {
  return {
    session: String(text.match(/session=([^;]+)/)?.[1] ?? ""),
    account: String(text.match(/account=([^;]+)/)?.[1] ?? ""),
  }
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-ban-failover-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const upstreamBase = `${upstreamOrigin}/v1`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)
  const bannedToken = "ban-token-a"

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

      if (url.pathname === "/v1/models" || url.pathname === "/models" || url.pathname.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "gpt-5.4",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "openai",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      }

      if (url.pathname === "/v1/responses") {
        if (accessToken === bannedToken) {
          capturedRequests.push({
            path: url.pathname,
            token: accessToken,
            status: 403,
            session,
          })
          return new Response("msg: 127.0.0.1:4777 is ban", {
            status: 403,
            headers: {
              "content-type": "text/plain",
            },
          })
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
      OAUTH_OPENAI_API_BASE: upstreamBase,
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

    await requestJSON<SyncResponse>(`${bridgeOrigin}/api/accounts/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        providerName: "OpenAI",
        displayName: "Ban Audit A",
        apiKey: bannedToken,
        organizationId: "org-ban-a",
      }),
    })
    const issued = (await requestJSON(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        routingMode: "pool",
        name: "Ban Failover Pool Key",
      }),
    })) as { key: string; record: { id: string } }

    assertCondition(issued.key?.startsWith("ocsk_live_"), "pool key issue failed")
    const forcedSessionId = "ban-failover-session"
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
        model: "gpt-5-codex",
        input: "ban failover",
        prompt_cache_key: forcedSessionId,
      }),
    })

    const responseBody = await response.text()
    if (response.status !== 503) {
      findings.push(`responses route expected=503 actual=${response.status} body=${responseBody}`)
    } else {
      const parsedBody = JSON.parse(responseBody) as {
        error?: {
          code?: string
          message?: string
        }
      }
      if (parsedBody.error?.code !== "upstream_account_unavailable") {
        findings.push(`normalized error code expected=upstream_account_unavailable actual=${parsedBody.error?.code ?? "<missing>"}`)
      }
      if (!String(parsedBody.error?.message ?? "").includes("No healthy accounts available for pool routing")) {
        findings.push(`normalized error message missing: ${parsedBody.error?.message ?? "<missing>"}`)
      }
      if (responseBody.toLowerCase().includes("is ban")) {
        findings.push(`ban message leaked to client body=${responseBody}`)
      }
    }

    const failedAttempts = capturedRequests.filter((item) => item.status === 403 && item.token === bannedToken).length
    if (failedAttempts !== 1) {
      findings.push(`banned account attempts expected=1 actual=${failedAttempts}`)
    }
    const successfulAttempts = capturedRequests.filter((item) => item.status === 200).length
    if (successfulAttempts !== 0) {
      findings.push(`unexpected successful upstream attempts actual=${successfulAttempts}`)
    }
  } finally {
    await stopChildProcess(child)
    upstreamServer.stop(true)
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const reportLines = [
    "# Codex Ban Failover Audit",
    "",
    `- Time: ${new Date().toISOString()}`,
    `- Findings: ${findings.length}`,
    "",
  ]
  if (findings.length > 0) {
    reportLines.push("## Findings", "", ...findings.map((item) => `- ${item}`))
  } else {
    reportLines.push("No findings.")
  }
  const reportPath = await writeReportWithFallback(
    reportDir,
    "codex-ban-failover-audit.md",
    `${reportLines.join("\n")}\n`,
  )

  if (findings.length > 0) {
    console.error(`codex-ban-failover-audit failed. Report: ${reportPath}`)
    process.exitCode = 1
    return
  }

  console.log(`codex-ban-failover-audit passed. Report: ${reportPath}`)
}

await main()
