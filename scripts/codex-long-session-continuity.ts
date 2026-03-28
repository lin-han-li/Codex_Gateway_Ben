import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"
import { bindClientIdentifierToAccount } from "../src/upstream-session-binding"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type SyncResponse = {
  account: {
    id: string
  }
}

type CapturedRequest = {
  at: number
  path: string
  headers: Record<string, string>
  body: string
}

type SessionState = {
  sessionId: string
  expectedTurn: number
  accountMarkers: Set<string>
  failures: string[]
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

function parseResponseSignal(text: string) {
  const turn = Number((text.match(/turn=(\d+)/)?.[1] ?? "NaN"))
  const session = String(text.match(/session=([^;]+)/)?.[1] ?? "")
  const account = String(text.match(/account=([^;]+)/)?.[1] ?? "")
  return {
    turn,
    session,
    account,
  }
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
  throw new Error("Health check timed out")
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  return data as T
}

async function run() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-long-session-"))
  const bridgePort = "4853"
  const upstreamPort = "4854"
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const responsesEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  const capturedRequests: CapturedRequest[] = []
  const upstreamTurnMap = new Map<string, number>()
  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const url = new URL(request.url)
      const headers = headersToObject(request.headers)
      const body = await request.text()
      capturedRequests.push({
        at: Date.now(),
        path: url.pathname,
        headers,
        body,
      })

      const parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      const sessionId = String(headers["session_id"] ?? parsedBody.prompt_cache_key ?? parsedBody.session_id ?? "none")
      const authorization = String(headers.authorization ?? "")
      const accountMarker = authorization.replace(/^Bearer\s+/i, "")
      const turnKey = `${sessionId}|${accountMarker}`
      const turn = (upstreamTurnMap.get(turnKey) ?? 0) + 1
      upstreamTurnMap.set(turnKey, turn)

      await Bun.sleep(8)
      return new Response(
        JSON.stringify({
          id: `resp_${crypto.randomUUID()}`,
          object: "response",
          output_text: `session=${sessionId};account=${accountMarker};turn=${turn}`,
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
            "x-upstream-case": "long-session",
          },
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

  const states: SessionState[] = [
    { sessionId: "sess-long-001", expectedTurn: 0, accountMarkers: new Set<string>(), failures: [] },
    { sessionId: "sess-long-002", expectedTurn: 0, accountMarkers: new Set<string>(), failures: [] },
    { sessionId: "sess-long-003", expectedTurn: 0, accountMarkers: new Set<string>(), failures: [] },
  ]
  const roundsPerSession = 120
  const totalRounds = roundsPerSession * states.length
  const startedAt = Date.now()

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const syncA = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Long Session A",
        email: "long-session-a@example.com",
        accountId: "org-long-session-a",
        accessToken: "long-token-a",
        refreshToken: "long-refresh-a",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })
    const syncB = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Long Session B",
        email: "long-session-b@example.com",
        accountId: "org-long-session-b",
        accessToken: "long-token-b",
        refreshToken: "long-refresh-b",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })
    const accountIdByAccessToken = new Map<string, string>([
      ["long-token-a", syncA.account.id],
      ["long-token-b", syncB.account.id],
    ])

    const issued = (await requestJSON(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Long Session Pool Key",
      }),
    })) as { key: string }
    const virtualKey = issued.key
    assertCondition(virtualKey?.startsWith("ocsk_live_"), "pool key issue failed")

    for (let i = 0; i < roundsPerSession; i += 1) {
      for (let idx = 0; idx < states.length; idx += 1) {
        const state = states[idx]
        const longContext = `会话${idx + 1} 第${i + 1}轮 `.repeat(20)
        const body = JSON.stringify({
          model: "gpt-5.4",
          instructions: "long session continuity check",
          input: [{ role: "user", content: [{ type: "input_text", text: longContext }] }],
          prompt_cache_key: state.sessionId,
          stream: false,
          store: false,
          reasoning: {
            effort: "medium",
            summary: "auto",
          },
        })

        const response = await fetch(`${bridgeOrigin}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${virtualKey}`,
            originator: CODEX_ORIGINATOR,
            "user-agent": userAgent,
            version: CODEX_CLIENT_VERSION,
            session_id: state.sessionId,
            "openai-beta": "responses=v1",
            "x-audit-case": "long-session-continuity",
          },
          body,
        })
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
        if (!response.ok) {
          state.failures.push(`request failed: status=${response.status} payload=${JSON.stringify(payload)}`)
          continue
        }
        const signal = parseResponseSignal(String(payload.output_text ?? ""))

        if (!signal.account) {
          state.failures.push(`missing account marker at turn ${i + 1}`)
        } else {
          state.accountMarkers.add(signal.account)
          const expectedBoundSession = bindClientIdentifierToAccount({
            accountId: accountIdByAccessToken.get(signal.account),
            fieldKey: "session_id",
            value: state.sessionId,
          })
          if (signal.session !== expectedBoundSession) {
            state.failures.push(`session echo mismatch: expected=${expectedBoundSession} actual=${signal.session || "<empty>"}`)
          }
        }

        state.expectedTurn += 1
        if (!Number.isFinite(signal.turn) || signal.turn !== state.expectedTurn) {
          state.failures.push(`turn discontinuity: expected=${state.expectedTurn} actual=${signal.turn}`)
        }
      }
    }

    const elapsedMs = Date.now() - startedAt
    const summaryFailures: string[] = []
    for (const state of states) {
      if (state.accountMarkers.size !== 1) {
        summaryFailures.push(`${state.sessionId} routed across ${state.accountMarkers.size} accounts`)
      }
      if (state.failures.length > 0) {
        summaryFailures.push(`${state.sessionId} had ${state.failures.length} continuity failures`)
      }
    }

    const totalCaptured = capturedRequests.filter((item) => item.path === "/backend-api/codex/responses").length
    const reportLines = [
      "# Long Session Continuity Audit",
      "",
      `Generated at: ${new Date().toISOString()}`,
      `Total rounds: ${totalRounds}`,
      `Elapsed: ${elapsedMs} ms`,
      `Captured upstream responses calls: ${totalCaptured}`,
      "",
      "## Session Results",
      ...states.flatMap((state) => {
        const accountList = [...state.accountMarkers]
        const header = [
          `### ${state.sessionId}`,
          `- Expected turns: ${roundsPerSession}`,
          `- Unique accounts: ${accountList.length}`,
          `- Account marker: ${accountList[0] ?? "-"}`,
          `- Continuity failures: ${state.failures.length}`,
        ]
        if (state.failures.length === 0) return [...header, ""]
        return [...header, ...state.failures.slice(0, 20).map((item) => `- ${item}`), ""]
      }),
      "## Verdict",
      summaryFailures.length === 0
        ? "- PASS: long multi-session continuity is stable; no context discontinuity detected."
        : `- FAIL: ${summaryFailures.join(" | ")}`,
      "",
    ]

    const reportDir = path.join(process.cwd(), "_tmp", "parity")
    await mkdir(reportDir, { recursive: true })
    const defaultReportFile = path.join(reportDir, "codex-long-session-continuity.md")
    let reportFile = defaultReportFile
    try {
      await writeFile(reportFile, reportLines.join("\n"), "utf8")
    } catch {
      reportFile = path.join(reportDir, `codex-long-session-continuity-${Date.now()}.md`)
      await writeFile(reportFile, reportLines.join("\n"), "utf8")
    }

    if (summaryFailures.length === 0) {
      console.log("Long session continuity audit passed")
      console.log(`Report saved: ${reportFile}`)
      return
    }

    console.error("Long session continuity audit failed")
    console.error(`Report saved: ${reportFile}`)
    process.exit(1)
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error("Long session continuity audit failed:", error)
  process.exit(1)
})
