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
  record?: {
    id: string
  } | null
}

type ResponsePayload = {
  output_text?: string
}

type ModelListPayload = {
  data?: Array<Record<string, unknown>>
}

type CapturedRequest = {
  token: string
  text: string
  body: Record<string, unknown>
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

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-mixed-plan-pool-"))
  const bridgePort = await reserveFreePort()
  let upstreamPort = await reserveFreePort()
  while (upstreamPort === bridgePort) {
    upstreamPort = await reserveFreePort()
  }
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
        body: parsedBody,
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
    OAUTH_CODEX_API_BASE: `${upstreamOrigin}/backend-api/codex`,
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
      planType: "Free",
    })
    const paidA = await syncAccount({
      email: "mixed-plan-business@example.com",
      accountId: "org-mixed-paid",
      accessToken: paidTokenA,
      refreshToken: "mixed-plan-business-refresh",
      planType: "Business",
    })
    const paidB = await syncAccount({
      email: "mixed-plan-team@example.com",
      accountId: "org-mixed-paid",
      accessToken: paidTokenB,
      refreshToken: "mixed-plan-team-refresh",
      planType: "Team",
    })

    assertCondition(free.account.id && paidA.account.id && paidB.account.id, "Failed to prepare mixed-plan accounts")
    const db = new Database(path.join(tempDataDir, "accounts.db"))
    db.query(`UPDATE accounts SET is_active = 1 WHERE id IN (?, ?, ?)`).run(
      free.account.id,
      paidA.account.id,
      paidB.account.id,
    )
    db.close()
    await stopBridgeProcess(child)
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
    const freeSingleKey = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        accountId: free.account.id,
        routingMode: "single",
        name: "Mixed Plan Free Key",
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
    const fixedGpt55Key = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Fixed GPT-5.5 XHigh Key",
        fixedModel: "gpt-5.5",
        fixedReasoningEffort: "xhigh",
      }),
    })

    const modelCatalog = await requestJSON<ModelListPayload>(`${origin}/v1/models`, {
      headers: { Authorization: `Bearer ${poolKey.key}` },
    })
    const gpt55CatalogEntry = (modelCatalog.data || []).find((entry) => entry.id === "gpt-5.5" || entry.slug === "gpt-5.5")
    const gpt55ReasoningLevels = Array.isArray(gpt55CatalogEntry?.supported_reasoning_levels)
      ? gpt55CatalogEntry.supported_reasoning_levels.map((item) =>
          typeof item === "string" ? item : String((item as Record<string, unknown>)?.effort || ""),
        )
      : []
    assertCondition(gpt55CatalogEntry, "Expected /v1/models to expose hardcoded gpt-5.5")
    assertCondition(gpt55ReasoningLevels.includes("xhigh"), "Expected /v1/models gpt-5.5 to expose xhigh reasoning")
    const fixedModelCatalog = await requestJSON<ModelListPayload>(`${origin}/v1/models`, {
      headers: { Authorization: `Bearer ${fixedGpt55Key.key}` },
    })
    const fixedModelIds = (fixedModelCatalog.data || [])
      .map((entry) => String(entry.id || entry.slug || ""))
      .filter(Boolean)
    assertCondition(
      fixedModelIds.length === 1 && fixedModelIds[0] === "gpt-5.5",
      `Expected fixed gpt-5.5 key to expose only gpt-5.5, got ${fixedModelIds.join(", ") || "<empty>"}`,
    )

    const buildResponsesRequest = (secret: string, message: string, promptCacheKey: string, model = "gpt-5.4") => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${secret}`,
          "openai-beta": "responses=v1",
        },
        body: JSON.stringify({
          model,
          input: [{ role: "user", content: [{ type: "input_text", text: message }] }],
          instructions: "mixed-plan-pool-audit",
          prompt_cache_key: promptCacheKey,
          store: false,
          stream: false,
        }),
      })
    const sendResponses = async (secret: string, message: string, promptCacheKey: string, model = "gpt-5.4") =>
      await requestJSON<ResponsePayload>(`${origin}/v1/responses`, buildResponsesRequest(secret, message, promptCacheKey, model))

    let heldPaidError: unknown = null
    const heldPaidRequest = sendResponses(paidASingleKey.key, "hold-paid-a", "mixed-plan-hold-paid-a").catch((error) => {
      heldPaidError = error
      return {} as ResponsePayload
    })
    await waitForCondition(
      () => capturedRequests.some((entry) => entry.token === paidTokenA && entry.text === "hold-paid-a"),
      10_000,
      "Timed out waiting for paid cohort pressure request",
    )

    const firstPoolResponse = await sendResponses(poolKey.key, "prefer-free-cohort", "mixed-plan-session-1")
    assertCondition(
      firstPoolResponse.output_text === `token=${freeToken}`,
      `Expected non-gpt-5.5 pool request to prefer Free cohort, got ${firstPoolResponse.output_text ?? "<missing>"}`,
    )

    const freeGpt55Response = await fetch(
      `${origin}/v1/responses`,
      buildResponsesRequest(freeSingleKey.key, "free-gpt55-denied", "mixed-plan-free-gpt55", "gpt-5.5"),
    )
    assertCondition(
      freeGpt55Response.status >= 400,
      `Expected gpt-5.5 to reject a Free single-account key, got ${freeGpt55Response.status}`,
    )

    const poolGpt55Response = await sendResponses(poolKey.key, "gpt55-paid-only", "mixed-plan-gpt55", "gpt-5.5")
    assertCondition(
      poolGpt55Response.output_text !== `token=${freeToken}`,
      `Expected gpt-5.5 pool request to avoid Free account, got ${poolGpt55Response.output_text ?? "<missing>"}`,
    )
    const poolUpperGpt55Response = await sendResponses(poolKey.key, "upper-gpt55-paid-only", "mixed-plan-upper-gpt55", "GPT-5.5")
    assertCondition(
      poolUpperGpt55Response.output_text !== `token=${freeToken}`,
      `Expected uppercase GPT-5.5 pool request to avoid Free account, got ${poolUpperGpt55Response.output_text ?? "<missing>"}`,
    )
    const fixedKeyResponse = await sendResponses(fixedGpt55Key.key, "fixed-gpt55-key-override", "mixed-plan-fixed-gpt55", "gpt-5.4")
    assertCondition(
      fixedKeyResponse.output_text !== `token=${freeToken}`,
      `Expected fixed gpt-5.5 key to avoid Free account, got ${fixedKeyResponse.output_text ?? "<missing>"}`,
    )
    const capturedFixedKeyRequest = capturedRequests.find((entry) => entry.text === "fixed-gpt55-key-override")
    assertCondition(capturedFixedKeyRequest, "Missing captured fixed gpt-5.5 key request")
    assertCondition(
      String(capturedFixedKeyRequest.body.model || "") === "gpt-5.5",
      `Expected fixed key to rewrite model to gpt-5.5, got ${String(capturedFixedKeyRequest.body.model || "<missing>")}`,
    )
    assertCondition(
      String(((capturedFixedKeyRequest.body.reasoning as Record<string, unknown> | null)?.effort as string | undefined) || "") === "xhigh",
      "Expected fixed key to inject reasoning.effort=xhigh",
    )
    assertCondition(fixedGpt55Key.record?.id, "Missing fixed gpt-5.5 key record id")
    const fixedKeyChatResponse = await requestJSON<{ reply?: string }>(`${origin}/api/chat/virtual-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyId: fixedGpt55Key.record.id,
        model: "gpt-5.4",
        message: "fixed-gpt55-chat-override",
        sessionId: "mixed-plan-fixed-gpt55-chat",
      }),
    })
    assertCondition(
      String(fixedKeyChatResponse.reply || "") !== `token=${freeToken}`,
      `Expected fixed gpt-5.5 chat test to avoid Free account, got ${fixedKeyChatResponse.reply ?? "<missing>"}`,
    )
    const capturedFixedKeyChat = capturedRequests.find((entry) => entry.text === "fixed-gpt55-chat-override")
    assertCondition(capturedFixedKeyChat, "Missing captured fixed gpt-5.5 chat request")
    assertCondition(
      String(capturedFixedKeyChat.body.model || "") === "gpt-5.5",
      `Expected fixed chat test to rewrite model to gpt-5.5, got ${String(capturedFixedKeyChat.body.model || "<missing>")}`,
    )
    assertCondition(
      String(((capturedFixedKeyChat.body.reasoning as Record<string, unknown> | null)?.effort as string | undefined) || "") === "xhigh",
      "Expected fixed chat test to inject reasoning.effort=xhigh",
    )

    assertCondition(poolKey.record?.id, "Missing pool key record id")
    const chatGpt55Response = await requestJSON<{ reply?: string }>(`${origin}/api/chat/virtual-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyId: poolKey.record.id,
        model: "gpt-5.5",
        message: "gpt55-chat-minimal-params",
        sessionId: "mixed-plan-gpt55-chat",
      }),
    })
    assertCondition(
      String(chatGpt55Response.reply || "") !== `token=${freeToken}`,
      `Expected gpt-5.5 chat test to avoid Free account, got ${chatGpt55Response.reply ?? "<missing>"}`,
    )
    const capturedGpt55Chat = capturedRequests.find((entry) => entry.text === "gpt55-chat-minimal-params")
    assertCondition(capturedGpt55Chat, "Missing captured gpt-5.5 chat request")
    for (const field of ["truncation"]) {
      assertCondition(
        !Object.prototype.hasOwnProperty.call(capturedGpt55Chat.body, field),
        `Expected gpt-5.5 chat test request to omit ${field}`,
      )
    }

    paidGate.release()
    await heldPaidRequest
    if (heldPaidError) throw heldPaidError

    const sessionOutputs: string[] = []
    for (let index = 0; index < 4; index += 1) {
      const response = await sendResponses(poolKey.key, `free-preferred-${index}`, `mixed-plan-session-${index + 2}`)
      sessionOutputs.push(String(response.output_text || ""))
    }

    const usedTokens = new Set(
      sessionOutputs
        .map((value) => value.replace(/^token=/, ""))
        .filter(Boolean),
    )
    assertCondition(usedTokens.size === 1 && usedTokens.has(freeToken), "Non-gpt-5.5 pool requests did not stay on the Free cohort")
    assertCondition(
      ![...usedTokens].some((token) => token === paidTokenA || token === paidTokenB),
      `Non-gpt-5.5 pool selected paid token before Free: ${[...usedTokens].join(", ")}`,
    )

    console.log(
      `Mixed-plan pool audit passed: gpt-5.5 stayed paid-only and non-gpt-5.5 preferred Free (${[...usedTokens].join(", ")}).`,
    )
  } finally {
    await stopBridgeProcess(child)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("Mixed-plan pool audit failed:", error)
  process.exit(1)
})
