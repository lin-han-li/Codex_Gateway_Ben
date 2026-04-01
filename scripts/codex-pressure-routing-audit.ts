import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { resolveCodexClientVersion } from "../src/codex-version"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()

type SyncResponse = {
  account: { id: string }
}

type IssueKeyResponse = {
  key: string
  record?: {
    id: string
    accountId?: string | null
    routingMode?: string
  } | null
}

type ChatResponse = {
  output_text?: string
}

type CapturedRequest = {
  token: string
  path: string
  text: string
  at: number
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function createManualGate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function extractMessageText(body: unknown): string {
  if (!body || typeof body !== "object") return ""
  const payload = body as Record<string, unknown>
  const input = Array.isArray(payload.input) ? payload.input : []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as Array<unknown>)
      : []
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const text = (part as Record<string, unknown>).text
      if (typeof text === "string" && text.trim().length > 0) return text
    }
  }
  return ""
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

async function waitForCondition(predicate: () => boolean, timeoutMs: number, message: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
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
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-pressure-routing-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const origin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const hotGate = createManualGate()
  const coolGate = createManualGate()
  const capturedRequests: CapturedRequest[] = []

  let hotToken = ""
  let coolToken = ""

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const headers = Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]))
      const token = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")
      const parsedBody = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
      const text = extractMessageText(parsedBody)
      capturedRequests.push({
        token,
        path: new URL(request.url).pathname,
        text,
        at: Date.now(),
      })

      if (text === "hold-hot" && token === hotToken) {
        await hotGate.wait
      }
      if (text === "hold-cool" && token === coolToken) {
        await coolGate.wait
      }

      return new Response(
        JSON.stringify({
          id: `resp_${crypto.randomUUID()}`,
          object: "response",
          output_text: `token=${token}`,
          usage: {
            input_tokens: 9,
            output_tokens: 6,
            total_tokens: 15,
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

  const bridgeEnv = {
    ...process.env,
    OAUTH_APP_HOST: "127.0.0.1",
    OAUTH_APP_PORT: String(bridgePort),
    OAUTH_APP_DATA_DIR: tempDataDir,
    OAUTH_APP_FORWARD_PROXY_ENABLED: "0",
    OAUTH_CODEX_API_ENDPOINT: `${upstreamOrigin}/backend-api/codex/responses`,
    OAUTH_CODEX_CLIENT_VERSION: CODEX_CLIENT_VERSION,
    OAUTH_BEHAVIOR_ENABLED: "true",
    OAUTH_BEHAVIOR_MODE: "observe",
    OAUTH_BEHAVIOR_MAX_IN_FLIGHT_GLOBAL: "16",
    OAUTH_BEHAVIOR_MAX_IN_FLIGHT_PER_ACCOUNT: "4",
  }
  const startBridge = () => {
    const next = spawn("bun", ["src/index.ts"], {
      cwd: process.cwd(),
      env: bridgeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    next.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
    next.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))
    return next
  }
  let child = startBridge()

  try {
    await waitForHealth(origin, 20_000)

    const primarySync = await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Pressure Audit A",
        email: "pressure-audit-a@example.com",
        accountId: "org-pressure-a",
        accessToken: "pressure-token-a",
        refreshToken: "pressure-refresh-a",
        expiresAt: Date.now() + 3600_000,
      }),
    })
    const secondarySync = await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Pressure Audit B",
        email: "pressure-audit-b@example.com",
        accountId: "org-pressure-b",
        accessToken: "pressure-token-b",
        refreshToken: "pressure-refresh-b",
        expiresAt: Date.now() + 3600_000,
      }),
    })

    const orderedAccounts = [
      { id: primarySync.account.id, token: "pressure-token-a" },
      { id: secondarySync.account.id, token: "pressure-token-b" },
    ].sort((a, b) => a.id.localeCompare(b.id))
    const hotAccount = orderedAccounts[0]
    const coolAccount = orderedAccounts[1]
    assertCondition(hotAccount && coolAccount, "Failed to prepare pressure audit accounts")
    const db = new Database(path.join(tempDataDir, "accounts.db"))
    db.query(`UPDATE accounts SET is_active = 1 WHERE id IN (?, ?)`).run(hotAccount.id, coolAccount.id)
    db.close()
    child.kill("SIGTERM")
    await Bun.sleep(500)
    child = startBridge()
    await waitForHealth(origin, 20_000)
    hotToken = hotAccount.token
    coolToken = coolAccount.token

    const hotKey = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        accountId: hotAccount.id,
        routingMode: "single",
        name: "Pressure Audit Hot Key",
      }),
    })
    const coolKey = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        accountId: coolAccount.id,
        routingMode: "single",
        name: "Pressure Audit Cool Key",
      }),
    })
    assertCondition(hotKey.key?.startsWith("ocsk_live_"), "Hot single-route key missing")
    assertCondition(coolKey.key?.startsWith("ocsk_live_"), "Cool single-route key missing")

    const poolKey = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Pressure Audit Pool Key",
      }),
    })
    assertCondition(poolKey.key?.startsWith("ocsk_live_"), "Pool virtual key was not created")

    const sendResponses = async (secret: string, message: string, promptCacheKey: string) =>
      await requestJSON<ChatResponse>(`${origin}/v1/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${secret}`,
          "openai-beta": "responses=v1",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: [{ role: "user", content: [{ type: "input_text", text: message }] }],
          instructions: "pressure-routing-audit",
          prompt_cache_key: promptCacheKey,
          store: false,
          stream: false,
        }),
      })

    const heldHotRequest = sendResponses(hotKey.key, "hold-hot", "hold-hot-session")
    await waitForCondition(
      () => capturedRequests.some((entry) => entry.token === hotToken && entry.text === "hold-hot"),
      10_000,
      "Timed out waiting for hot account pressure request",
    )

    const firstPoolResponse = await sendResponses(poolKey.key, "pool-first", "pressure-sticky-session")
    assertCondition(
      firstPoolResponse.output_text === `token=${coolToken}`,
      `Expected new session to avoid pressured account ${hotAccount.id} and choose ${coolAccount.id}, got ${firstPoolResponse.output_text ?? "<missing>"}`,
    )

    hotGate.release()
    await heldHotRequest

    const heldCoolRequest = sendResponses(coolKey.key, "hold-cool", "hold-cool-session")
    await waitForCondition(
      () => capturedRequests.some((entry) => entry.token === coolToken && entry.text === "hold-cool"),
      10_000,
      "Timed out waiting for cool account pressure request",
    )

    const stickyFollowResponse = await sendResponses(poolKey.key, "pool-follow", "pressure-sticky-session")
    assertCondition(
      stickyFollowResponse.output_text === `token=${coolToken}`,
      `Expected established sticky session to remain on ${coolAccount.id}, got ${stickyFollowResponse.output_text ?? "<missing>"}`,
    )

    coolGate.release()
    await heldCoolRequest

    console.log(
      `Pressure routing audit passed: new session avoided hot account ${hotAccount.id}, sticky follow-up stayed on ${coolAccount.id}.`,
    )
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("Pressure routing audit failed:", error)
  process.exit(1)
})
