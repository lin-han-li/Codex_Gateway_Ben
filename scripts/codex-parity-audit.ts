import { mkdtemp, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"
import { bindClientIdentifierToAccount, isAccountBoundSessionFieldKey } from "../src/upstream-session-binding"

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type CapturedRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function headersToObject(headers: Headers) {
  const output: Record<string, string> = {}
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value
  })
  return output
}

function copyHeaders(input?: HeadersInit) {
  const headers = new Headers()
  if (!input) return headers

  if (input instanceof Headers) {
    input.forEach((value, key) => headers.set(key, value))
    return headers
  }

  if (Array.isArray(input)) {
    for (const [key, value] of input) {
      if (value !== undefined) headers.set(key, String(value))
    }
    return headers
  }

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) headers.set(key, String(value))
  }
  return headers
}

function rewriteExpectedSessionBodyNode(node: unknown, accountId: string): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteExpectedSessionBodyNode(item, accountId))
  if (!node || typeof node !== "object") return node

  const rewritten: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && isAccountBoundSessionFieldKey(key)) {
      rewritten[key] = bindClientIdentifierToAccount({ accountId, fieldKey: key, value })
      continue
    }
    rewritten[key] = rewriteExpectedSessionBodyNode(value, accountId)
  }
  return rewritten
}

function rewriteExpectedSessionBody(body: string, accountId?: string) {
  if (!accountId) return body
  try {
    return JSON.stringify(rewriteExpectedSessionBodyNode(JSON.parse(body), accountId))
  } catch {
    return body
  }
}

function stripHeaders(input: Record<string, string>) {
  const output: Record<string, string> = { ...input }
  delete output.host
  delete output["content-length"]
  delete output.connection
  delete output["accept-encoding"]
  return output
}

function buildCodexClientOutgoingRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  codexApiEndpoint?: string
}) {
  // Mirrors Codex bridge forwarding behavior for responses endpoints.
  const headers = copyHeaders(input.headers)
  headers.delete("authorization")
  headers.delete("Authorization")
  headers.set("authorization", `Bearer ${input.accessToken}`)
  if (input.accountId) headers.set("ChatGPT-Account-ID", input.accountId)
  if (input.sessionBindingAccountId) {
    for (const [key, value] of headers.entries()) {
      if (isAccountBoundSessionFieldKey(key)) {
        headers.set(key, bindClientIdentifierToAccount({ accountId: input.sessionBindingAccountId, fieldKey: key, value }))
      }
    }
  }

  const parsed = new URL(input.requestUrl)
  const codexApiEndpoint = input.codexApiEndpoint ?? CODEX_API_ENDPOINT
  const url =
    parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
      ? codexApiEndpoint
      : parsed.toString()
  if (new URL(url).pathname.includes("/backend-api/codex/")) {
    headers.delete("version")
  }

  return {
    method: input.method,
    url,
    headers: headersToObject(headers),
    body: rewriteExpectedSessionBody(input.body, input.sessionBindingAccountId),
  } satisfies CapturedRequest
}

async function waitForHealth(origin: string, timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // still booting
    }
    await Bun.sleep(250)
  }
  throw new Error("Bridge server health check timed out")
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  }
  return data as T
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

async function captureBridgeOutgoingRequest() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-parity-audit-"))
  const bridgePort = String(await reserveFreePort())
  const upstreamPort = String(await reserveFreePort())
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`

  let captured: CapturedRequest | null = null
  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      captured = {
        method: request.method,
        url: request.url,
        headers: headersToObject(request.headers),
        body: await request.text(),
      }
      return new Response(
        JSON.stringify({
          id: "resp_mock",
          object: "response",
          output_text: "ok",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "x-upstream": "parity-audit" },
        },
      )
    },
  })

  const child = spawn("bun", ["src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OAUTH_APP_HOST: "127.0.0.1",
      OAUTH_APP_PORT: bridgePort,
      OAUTH_APP_DATA_DIR: tempDataDir,
      OAUTH_APP_FORWARD_PROXY_ENABLED: "0",
      OAUTH_CODEX_API_ENDPOINT: `${upstreamOrigin}/backend-api/codex/responses`,
      OAUTH_CODEX_CLIENT_VERSION: CODEX_CLIENT_VERSION,
      OAUTH_CODEX_ORIGINATOR: CODEX_ORIGINATOR,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const sessionID = "sess-parity-audit-001"
  const requestBody = JSON.stringify({
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "parity-audit" }] }],
    instructions: "parity-instructions",
    prompt_cache_key: sessionID,
    store: false,
    stream: true,
  })
    const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const sync = await requestJSON<{ account?: { id: string }; virtualKey?: { key: string } }>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Parity OAuth",
        email: "parity@example.com",
        accountId: "org-parity-account",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: true,
        keyName: "Parity Key",
      }),
    })

    const virtualKey = sync.virtualKey?.key
    assertCondition(virtualKey, "Failed to issue virtual key for parity audit")
    assertCondition(sync.account?.id, "Failed to capture routed account id for parity audit")

    const response = await fetch(`${bridgeOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${virtualKey}`,
        originator: CODEX_ORIGINATOR,
        "User-Agent": userAgent,
        version: CODEX_CLIENT_VERSION,
        session_id: sessionID,
        "openai-beta": "responses=v1",
        "x-stainless-test": "parity-audit",
      },
      body: requestBody,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Bridge request failed (${response.status}): ${text}`)
    }

    assertCondition(captured, "No upstream request captured from bridge")
    return {
      captured,
      requestBody,
      sessionID,
      sessionBindingAccountId: sync.account.id,
      userAgent,
      upstreamCodexEndpoint: `${upstreamOrigin}/backend-api/codex/responses`,
    }
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

function diffRecords(label: string, left: Record<string, string>, right: Record<string, string>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const mismatches: string[] = []
  for (const key of [...keys].sort()) {
    const a = left[key]
    const b = right[key]
    if (a !== b) {
      mismatches.push(`${label}.${key}: expected=${JSON.stringify(a)} actual=${JSON.stringify(b)}`)
    }
  }
  return mismatches
}

async function main() {
  const bridge = await captureBridgeOutgoingRequest()

  const expected = buildCodexClientOutgoingRequest({
    requestUrl: "https://api.openai.com/v1/responses",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer codex-oauth-dummy-key",
      originator: CODEX_ORIGINATOR,
      "User-Agent": bridge.userAgent,
      session_id: bridge.sessionID,
      "openai-beta": "responses=v1",
      "x-stainless-test": "parity-audit",
    },
    body: bridge.requestBody,
    accessToken: "fake-access-token",
    accountId: "org-parity-account",
    sessionBindingAccountId: bridge.sessionBindingAccountId,
    codexApiEndpoint: bridge.upstreamCodexEndpoint,
  })

  const actual = {
    ...bridge.captured,
    headers: stripHeaders(bridge.captured.headers),
  }
  const expectedNormalized = {
    ...expected,
    headers: stripHeaders(expected.headers),
  }

  const diffs: string[] = []
  if (expectedNormalized.method !== actual.method) {
    diffs.push(`method: expected=${expectedNormalized.method} actual=${actual.method}`)
  }
  if (expectedNormalized.url !== actual.url) {
    diffs.push(`url: expected=${expectedNormalized.url} actual=${actual.url}`)
  }
  if (expectedNormalized.body !== actual.body) {
    diffs.push("body: expected and actual request body are different")
  }
  diffs.push(...diffRecords("headers", expectedNormalized.headers, actual.headers))

  if (diffs.length > 0) {
    console.error("Parity audit failed with differences:")
    for (const diff of diffs) {
      console.error(`- ${diff}`)
    }
    process.exit(1)
  }

  console.log("Parity audit passed: bridge outbound request matches codex-official forwarding behavior.")
}

main().catch((error) => {
  console.error("Parity audit failed:", error)
  process.exit(1)
})
