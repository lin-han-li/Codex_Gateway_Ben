import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type SyncAccountResponse = {
  account: {
    id: string
  }
}

type CapturedRequest = {
  path: string
  token: string
  organization: string
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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  }
  return data as T
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-pool-consistency-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const upstreamBase = `${upstreamOrigin}/v1`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)
  const capturedRequests: CapturedRequest[] = []

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const url = new URL(request.url)
      const authToken = String(request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
      const organization = String(request.headers.get("openai-organization") ?? "")

      if (url.pathname === "/v1/models") {
        capturedRequests.push({
          path: url.pathname,
          token: authToken,
          organization,
        })
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "gpt-5.4",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "openai",
                default_reasoning_level: "medium",
                supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
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
        capturedRequests.push({
          path: url.pathname,
          token: authToken,
          organization,
        })
        return new Response(
          JSON.stringify({
            id: `resp_${crypto.randomUUID()}`,
            object: "response",
            output_text: `token=${authToken};organization=${organization || "<empty>"}`,
            usage: {
              input_tokens: 9,
              output_tokens: 5,
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

    await requestJSON<SyncAccountResponse>(`${bridgeOrigin}/api/accounts/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        providerName: "OpenAI",
        methodId: "api-key",
        displayName: "Major Org A",
        apiKey: "pool-token-a",
        organizationId: "org-major",
      }),
    })
    await requestJSON<SyncAccountResponse>(`${bridgeOrigin}/api/accounts/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        providerName: "OpenAI",
        methodId: "api-key",
        displayName: "Major Org B",
        apiKey: "pool-token-b",
        organizationId: "org-major",
      }),
    })
    await requestJSON<SyncAccountResponse>(`${bridgeOrigin}/api/accounts/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        providerName: "OpenAI",
        methodId: "api-key",
        displayName: "Empty Org",
        apiKey: "pool-token-empty",
      }),
    })

    const issued = (await requestJSON(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        routingMode: "pool",
        name: "Pool Consistency Audit",
      }),
    })) as { key: string }

    const virtualKey = issued.key
    assertCondition(virtualKey.startsWith("ocsk_live_"), "pool key issue failed")

    const modelsResponse = await fetch(`${bridgeOrigin}/v1/models`, {
      headers: {
        authorization: `Bearer ${virtualKey}`,
        originator: CODEX_ORIGINATOR,
        "user-agent": userAgent,
        version: CODEX_CLIENT_VERSION,
      },
    })
    const modelsPayload = await modelsResponse.json().catch(() => ({}))
    if (!modelsResponse.ok) {
      findings.push(`models request failed status=${modelsResponse.status} payload=${JSON.stringify(modelsPayload)}`)
    }

    for (const sessionId of ["sess-pool-consistency-1", "sess-pool-consistency-2", "sess-pool-consistency-3"]) {
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
          instructions: "pool consistency subgroup selection",
          input: [{ role: "user", content: [{ type: "input_text", text: sessionId }] }],
          prompt_cache_key: sessionId,
          stream: false,
          store: false,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (!response.ok) {
        findings.push(`responses request failed session=${sessionId} status=${response.status} payload=${JSON.stringify(payload)}`)
      }
    }

    const responseTokens = new Set(capturedRequests.filter((item) => item.path === "/v1/responses").map((item) => item.token))
    if (responseTokens.size < 2) {
      findings.push(`expected metadata-heterogeneous pool to keep balancing, but saw response tokens=${[...responseTokens].join(",")}`)
    }

    const emptyOrgRequests = capturedRequests.filter((item) => item.token === "pool-token-empty")
    if (emptyOrgRequests.length === 0) {
      findings.push("expected empty-organization account to remain eligible under metadata heterogeneity handling")
    }

    const reportDir = path.join(process.cwd(), "_tmp", "parity")
    await mkdir(reportDir, { recursive: true })
    let reportFile = path.join(reportDir, "pool-consistency-audit.md")
    const reportLines = [
      "# Pool Consistency Audit",
      "",
      `Bridge origin: ${bridgeOrigin}`,
      `Upstream origin: ${upstreamOrigin}`,
      `Captured requests: ${capturedRequests.length}`,
      "",
      "## Captured Requests",
      ...capturedRequests.map(
        (item) => `- path=${item.path} token=${item.token} organization=${item.organization || "<empty>"}`,
      ),
      "",
      findings.length === 0 ? "Result: PASS" : "Result: FAIL",
      ...findings.map((item) => `- ${item}`),
    ]
    try {
      await writeFile(reportFile, `${reportLines.join("\n")}\n`, "utf8")
    } catch {
      reportFile = path.join(reportDir, `pool-consistency-audit-${Date.now()}.md`)
      await writeFile(reportFile, `${reportLines.join("\n")}\n`, "utf8")
    }

    if (findings.length > 0) {
      throw new Error(findings.join(" | "))
    }
    console.log(`Pool consistency audit passed. Report: ${reportFile}`)
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(400)
    upstreamServer.stop(true)
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

await main()
