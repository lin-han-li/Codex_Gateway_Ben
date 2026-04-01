import { mkdtemp, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { resolveCodexClientVersion } from "../src/codex-version"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()

type SyncResponse = {
  account: { id: string }
}

type IssueKeyResponse = {
  key: string
}

type ResponsePayload = {
  output_text?: string
}

type CapturedRequest = {
  token: string
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
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-mixed-plan-pool-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const origin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const paidGate = createManualGate()
  const capturedRequests: CapturedRequest[] = []

  const freeToken = "mixed-plan-free-token"
  const paidTokenA = "mixed-plan-paid-token-a"
  const paidTokenB = "mixed-plan-paid-token-b"

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
        text,
        at: Date.now(),
      })

      if (text === "hold-paid-a" && token === paidTokenA) {
        await paidGate.wait
      }

      return new Response(
        JSON.stringify({
          id: `resp_${crypto.randomUUID()}`,
          object: "response",
          output_text: `token=${token}`,
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
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

    const syncAccount = async (input: {
      email: string
      accountId: string
      accessToken: string
      refreshToken: string
      planType: string
    }) =>
      await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "chatgpt",
          providerName: "ChatGPT",
          methodId: "codex-oauth",
          displayName: input.email,
          email: input.email,
          accountId: input.accountId,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: Date.now() + 3600_000,
          chatgptPlanType: input.planType,
        }),
      })

    const free = await syncAccount({
      email: "mixed-plan-free@example.com",
      accountId: "org-mixed-free",
      accessToken: freeToken,
      refreshToken: "mixed-plan-free-refresh",
      planType: "free",
    })
    const paidA = await syncAccount({
      email: "mixed-plan-business@example.com",
      accountId: "org-mixed-paid",
      accessToken: paidTokenA,
      refreshToken: "mixed-plan-business-refresh",
      planType: "business",
    })
    const paidB = await syncAccount({
      email: "mixed-plan-team@example.com",
      accountId: "org-mixed-paid",
      accessToken: paidTokenB,
      refreshToken: "mixed-plan-team-refresh",
      planType: "team",
    })

    assertCondition(free.account.id && paidA.account.id && paidB.account.id, "Failed to prepare mixed-plan accounts")
    const db = new Database(path.join(tempDataDir, "accounts.db"))
    db.query(`UPDATE accounts SET is_active = 1 WHERE id IN (?, ?, ?)`).run(
      free.account.id,
      paidA.account.id,
      paidB.account.id,
    )
    db.close()
    child.kill("SIGTERM")
    await Bun.sleep(500)
    child = startBridge()
    await waitForHealth(origin, 20_000)

    const paidASingleKey = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        accountId: paidA.account.id,
        routingMode: "single",
        name: "Mixed Plan Paid A Key",
      }),
    })
    const poolKey = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Mixed Plan Pool Key",
      }),
    })

    const sendResponses = async (secret: string, message: string, promptCacheKey: string) =>
      await requestJSON<ResponsePayload>(`${origin}/v1/responses`, {
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
          instructions: "mixed-plan-pool-audit",
          prompt_cache_key: promptCacheKey,
          store: false,
          stream: false,
        }),
      })

    const heldPaidRequest = sendResponses(paidASingleKey.key, "hold-paid-a", "mixed-plan-hold-paid-a")
    await waitForCondition(
      () => capturedRequests.some((entry) => entry.token === paidTokenA && entry.text === "hold-paid-a"),
      10_000,
      "Timed out waiting for paid cohort pressure request",
    )

    const firstPoolResponse = await sendResponses(poolKey.key, "prefer-paid-cohort", "mixed-plan-session-1")
    assertCondition(
      firstPoolResponse.output_text === `token=${paidTokenB}`,
      `Expected pool to stay inside paid cohort under pressure and choose ${paidTokenB}, got ${firstPoolResponse.output_text ?? "<missing>"}`,
    )

    paidGate.release()
    await heldPaidRequest

    const sessionOutputs: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const response = await sendResponses(poolKey.key, `paid-only-${index}`, `mixed-plan-session-${index + 2}`)
      sessionOutputs.push(String(response.output_text || ""))
    }

    const usedTokens = new Set(
      sessionOutputs
        .map((value) => value.replace(/^token=/, ""))
        .filter(Boolean),
    )
    assertCondition(!usedTokens.has(freeToken), "Free cohort account was selected while paid cohort was available")
    assertCondition(
      [...usedTokens].every((token) => token === paidTokenA || token === paidTokenB),
      `Pool selected token outside paid cohort: ${[...usedTokens].join(", ")}`,
    )

    console.log(
      `Mixed-plan pool audit passed: paid cohort stayed isolated from free cohort and used tokens ${[...usedTokens].join(", ")}.`,
    )
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("Mixed-plan pool audit failed:", error)
  process.exit(1)
})
