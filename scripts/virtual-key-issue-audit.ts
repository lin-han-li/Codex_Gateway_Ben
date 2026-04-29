import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"

type SyncResponse = {
  account: {
    id: string
  }
}

type IssueKeyResponse = {
  key: string
  record?: {
    id: string
    accountId?: string | null
    routingMode?: string | null
    accountScope?: string | null
    clientMode?: string | null
    wireApi?: string | null
    fixedModel?: string | null
    fixedReasoningEffort?: string | null
  } | null
}

type UpdateKeyResponse = {
  record?: IssueKeyResponse["record"]
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

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-key-issue-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const upstreamBase = `${upstreamOrigin}/v1`
  const capturedRequests: Array<{ path: string; token: string }> = []

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const url = new URL(request.url)
      const authToken = String(request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
      capturedRequests.push({
        path: url.pathname,
        token: authToken,
      })

      if (url.pathname === "/v1/models") {
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
        return new Response(
          JSON.stringify({
            id: `resp_${crypto.randomUUID()}`,
            object: "response",
            output_text: "ok",
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
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const findings: string[] = []

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const accountA = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Key Issue Audit A",
        email: "key-issue-a@example.com",
        accountId: "org-key-issue-a",
        accessToken: "key-issue-token-a",
        refreshToken: "key-issue-refresh-a",
        expiresAt: Date.now() + 3600_000,
        organizationId: "org-key-issue-a",
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
        displayName: "Key Issue Audit B",
        email: "key-issue-b@example.com",
        accountId: "org-key-issue-b",
        accessToken: "key-issue-token-b",
        refreshToken: "key-issue-refresh-b",
        expiresAt: Date.now() + 3600_000,
        organizationId: "org-key-issue-b",
        issueVirtualKey: false,
      }),
    })

    capturedRequests.length = 0

    const issued = await requestJSON<IssueKeyResponse>(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Key Issue Audit Pool Key",
      }),
    })

    assertCondition(issued.key?.startsWith("ocsk_live_"), "pool key issue failed")
    assertCondition(issued.record?.id, "pool key issue did not return record id")

    const cursorUpdated = await requestJSON<UpdateKeyResponse>(
      `${bridgeOrigin}/api/virtual-keys/${encodeURIComponent(issued.record.id)}/settings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routingMode: "pool",
          accountScope: "all",
          clientMode: "cursor",
          wireApi: "chat_completions",
          fixedModel: "gpt-5.5",
          fixedReasoningEffort: "xhigh",
        }),
      },
    )
    assertCondition(cursorUpdated.record?.routingMode === "pool", "settings update should keep pool routing")
    assertCondition(cursorUpdated.record?.clientMode === "cursor", "settings update should switch key to cursor mode")
    assertCondition(cursorUpdated.record?.wireApi === "chat_completions", "settings update should switch wire API")
    assertCondition(cursorUpdated.record?.fixedModel === "gpt-5.5", "settings update should persist fixed model")
    assertCondition(cursorUpdated.record?.fixedReasoningEffort === "xhigh", "settings update should persist fixed reasoning")

    const singleUpdated = await requestJSON<UpdateKeyResponse>(
      `${bridgeOrigin}/api/virtual-keys/${encodeURIComponent(issued.record.id)}/settings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: accountA.account.id,
          routingMode: "single",
          accountScope: "all",
          clientMode: "codex",
          wireApi: "responses",
          fixedModel: null,
          fixedReasoningEffort: null,
        }),
      },
    )
    assertCondition(singleUpdated.record?.routingMode === "single", "settings update should switch key to single routing")
    assertCondition(singleUpdated.record?.accountId === accountA.account.id, "settings update should bind selected account")
    assertCondition(singleUpdated.record?.clientMode === "codex", "settings update should switch key back to codex mode")
    assertCondition(singleUpdated.record?.wireApi === "responses", "settings update should switch wire API back to responses")
    assertCondition(!singleUpdated.record?.fixedModel, "settings update should clear fixed model")
    await Bun.sleep(250)

    const modelFetchCount = capturedRequests.filter((item) => item.path === "/v1/models").length
    if (modelFetchCount !== 0) {
      findings.push(`virtual key issue should not force /v1/models probes actual=${modelFetchCount}`)
    }
  } finally {
    await stopChildProcess(child)
    upstreamServer.stop(true)
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const reportLines = [
    "# Virtual Key Issue Audit",
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
    "virtual-key-issue-audit.md",
    `${reportLines.join("\n")}\n`,
  )

  if (findings.length > 0) {
    console.error(`virtual-key-issue-audit failed. Report: ${reportPath}`)
    process.exitCode = 1
    return
  }

  console.log(`virtual-key-issue-audit passed. Report: ${reportPath}`)
}

await main()
