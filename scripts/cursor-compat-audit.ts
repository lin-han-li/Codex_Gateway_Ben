import { Database } from "bun:sqlite"
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
    providerId?: string
    routingMode?: string
    clientMode?: string | null
    wireApi?: string | null
  } | null
}

type CursorModelsResponse = {
  object?: string
  data?: Array<{ id?: string }>
}

type CursorChatCompletionResponse = {
  object?: string
  model?: string
  choices?: Array<{
    message?: {
      role?: string
      content?: string | null
      tool_calls?: Array<Record<string, unknown>>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

type CapturedUpstreamRequest = {
  method: string
  path: string
  token: string
  headers: Record<string, string>
  bodyText: string
}

type ParsedSseEvent =
  | { type: "done" }
  | { type: "json"; payload: Record<string, unknown> }
  | { type: "text"; text: string }

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function headersToObject(headers: Headers) {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value
  })
  return record
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

function extractCursorPromptText(rawBody: string) {
  try {
    const payload = JSON.parse(rawBody) as Record<string, unknown>
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
  } catch {
    // ignore
  }
  return ""
}

function parseSseEvents(rawText: string) {
  const events: ParsedSseEvent[] = []
  const chunks = rawText.split(/\r?\n\r?\n/)
  for (const chunk of chunks) {
    const trimmed = chunk.trim()
    if (!trimmed) continue
    const data = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s*/, ""))
      .join("\n")
      .trim()
    if (!data) continue
    if (data === "[DONE]") {
      events.push({ type: "done" })
      continue
    }
    try {
      events.push({ type: "json", payload: JSON.parse(data) as Record<string, unknown> })
    } catch {
      events.push({ type: "text", text: data })
    }
  }
  return events
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-cursor-compat-"))
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const origin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const capturedUpstreamRequests: CapturedUpstreamRequest[] = []
  const findings: string[] = []

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const url = new URL(request.url)
      const headers = headersToObject(request.headers)
      const bodyText = await request.text()
      const token = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")
      capturedUpstreamRequests.push({
        method: request.method,
        path: url.pathname,
        token,
        headers,
        bodyText,
      })

      if (url.pathname === "/backend-api/codex/models") {
        return new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-5.4",
                display_name: "gpt-5.4",
                default_reasoning_level: "medium",
                supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
                supported_in_api: true,
                visibility: "list",
              },
              {
                slug: "gpt-5.1-codex-mini",
                display_name: "gpt-5.1-codex-mini",
                default_reasoning_level: "medium",
                supported_reasoning_levels: [{ effort: "medium" }],
                supported_in_api: true,
                visibility: "list",
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

      if (url.pathname === "/backend-api/codex/responses") {
        const prompt = extractCursorPromptText(bodyText)
        const parsed = JSON.parse(bodyText || "{}") as Record<string, unknown>
        if (prompt.includes("stream tool")) {
          assertCondition(parsed.stream === true, "cursor stream request should send stream=true upstream")
          const events = [
            {
              type: "response.output_text.delta",
              delta: "processing ",
            },
            {
              type: "response.output_item.added",
              item: {
                type: "function_call",
                call_id: "call_lookup_1",
                name: "lookup_weather",
                arguments: "{\"city\":\"Shanghai\"}",
              },
            },
            {
              type: "response.completed",
              response: {
                id: `resp_${crypto.randomUUID()}`,
                created_at: Math.floor(Date.now() / 1000),
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    call_id: "call_lookup_1",
                    name: "lookup_weather",
                    arguments: "{\"city\":\"Shanghai\"}",
                  },
                ],
                usage: {
                  input_tokens: 21,
                  input_tokens_details: {
                    cached_tokens: 3,
                  },
                  output_tokens: 8,
                  output_tokens_details: {
                    reasoning_tokens: 2,
                  },
                  total_tokens: 29,
                },
              },
            },
          ]
          const sseBody = `${events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`
          return new Response(sseBody, {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
            },
          })
        }

        return new Response(
          JSON.stringify({
            id: `resp_${crypto.randomUUID()}`,
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            output_text: "cursor-non-stream-ok",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "cursor-non-stream-ok",
                  },
                ],
              },
            ],
            usage: {
              input_tokens: 11,
              input_tokens_details: {
                cached_tokens: 2,
              },
              output_tokens: 5,
              output_tokens_details: {
                reasoning_tokens: 1,
              },
              total_tokens: 16,
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
      OAUTH_CODEX_API_ENDPOINT: `${upstreamOrigin}/backend-api/codex/responses`,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  try {
    await waitForHealth(origin, 20_000)

    const synced = await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Cursor Compat Audit",
        email: "cursor-compat@example.com",
        accountId: "org-cursor-compat",
        accessToken: "cursor-compat-token",
        refreshToken: "cursor-compat-refresh",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: false,
      }),
    })

    const cursorSingle = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        accountId: synced.account.id,
        routingMode: "single",
        clientMode: "cursor",
        wireApi: "chat_completions",
        name: "Cursor Compat Single",
      }),
    })
    const cursorPool = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        clientMode: "cursor",
        wireApi: "chat_completions",
        name: "Cursor Compat Pool",
      }),
    })
    const codexKey = await requestJSON<IssueKeyResponse>(`${origin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        accountId: synced.account.id,
        routingMode: "single",
        clientMode: "codex",
        wireApi: "responses",
        name: "Cursor Compat Codex",
      }),
    })

    assertCondition(cursorSingle.record?.clientMode === "cursor", "single cursor key clientMode mismatch")
    assertCondition(cursorSingle.record?.wireApi === "chat_completions", "single cursor key wireApi mismatch")
    assertCondition(cursorPool.record?.clientMode === "cursor", "pool cursor key clientMode mismatch")
    assertCondition(cursorPool.record?.wireApi === "chat_completions", "pool cursor key wireApi mismatch")
    assertCondition(codexKey.record?.clientMode === "codex", "codex key clientMode mismatch")
    assertCondition(codexKey.record?.wireApi === "responses", "codex key wireApi mismatch")

    const modelsResponse = await fetch(`${origin}/cursor/v1/models`, {
      headers: {
        Authorization: `Bearer ${cursorPool.key}`,
      },
    })
    assertCondition(modelsResponse.ok, `/cursor/v1/models should succeed actual=${modelsResponse.status}`)
    const modelsPayload = (await modelsResponse.json()) as CursorModelsResponse
    const modelIds = Array.isArray(modelsPayload.data) ? modelsPayload.data.map((item) => String(item.id ?? "")) : []
    assertCondition(modelIds.includes("gpt-5.4"), "cursor models should include gpt-5.4")

    const modelDetailResponse = await fetch(`${origin}/cursor/v1/models/gpt-5.4`, {
      headers: {
        Authorization: `Bearer ${cursorPool.key}`,
      },
    })
    assertCondition(modelDetailResponse.ok, `/cursor/v1/models/:id should succeed actual=${modelDetailResponse.status}`)

    const missingModelResponse = await fetch(`${origin}/cursor/v1/models/not-real`, {
      headers: {
        Authorization: `Bearer ${cursorPool.key}`,
      },
    })
    assertCondition(missingModelResponse.status === 404, `missing cursor model should 404 actual=${missingModelResponse.status}`)

    const codexOnCursorResponse = await fetch(`${origin}/cursor/v1/models`, {
      headers: {
        Authorization: `Bearer ${codexKey.key}`,
      },
    })
    assertCondition(codexOnCursorResponse.status === 403, `codex key on cursor route should 403 actual=${codexOnCursorResponse.status}`)

    const cursorOnCodexResponse = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cursorSingle.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "wrong-route" }],
          },
        ],
        stream: false,
      }),
    })
    assertCondition(cursorOnCodexResponse.status === 403, `cursor key on codex route should 403 actual=${cursorOnCodexResponse.status}`)

    const nonStreamResponse = await fetch(`${origin}/cursor/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cursorSingle.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [
          {
            role: "user",
            content: "cursor non-stream smoke",
          },
        ],
        stream: false,
      }),
    })
    assertCondition(nonStreamResponse.ok, `cursor non-stream chat should succeed actual=${nonStreamResponse.status}`)
    const nonStreamPayload = (await nonStreamResponse.json()) as CursorChatCompletionResponse
    assertCondition(nonStreamPayload.object === "chat.completion", "cursor non-stream should return chat.completion")
    assertCondition(nonStreamPayload.model === "gpt-5.4", "cursor non-stream model mismatch")
    assertCondition(
      String(nonStreamPayload.choices?.[0]?.message?.content ?? "").includes("cursor-non-stream-ok"),
      "cursor non-stream content mismatch",
    )
    assertCondition(nonStreamPayload.choices?.[0]?.finish_reason === "stop", "cursor non-stream finish_reason should be stop")
    assertCondition(nonStreamPayload.usage?.prompt_tokens === 11, "cursor non-stream prompt_tokens mismatch")
    assertCondition(nonStreamPayload.usage?.prompt_tokens_details?.cached_tokens === 2, "cursor non-stream cached tokens mismatch")
    assertCondition(nonStreamPayload.usage?.completion_tokens_details?.reasoning_tokens === 1, "cursor non-stream reasoning tokens mismatch")

    const streamResponse = await fetch(`${origin}/cursor/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cursorPool.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [
          {
            role: "user",
            content: "cursor stream tool smoke",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_weather",
              description: "Lookup weather",
              parameters: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
              },
            },
          },
        ],
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }),
    })
    assertCondition(streamResponse.ok, `cursor stream chat should succeed actual=${streamResponse.status}`)
    assertCondition(
      String(streamResponse.headers.get("content-type") ?? "").includes("text/event-stream"),
      "cursor stream should return event-stream",
    )
    const streamText = await streamResponse.text()
    const streamEvents = parseSseEvents(streamText)
    assertCondition(streamEvents.some((event) => event.type === "done"), "cursor stream should end with [DONE]")
    const jsonEvents = streamEvents.filter((event): event is Extract<ParsedSseEvent, { type: "json" }> => event.type === "json")
    assertCondition(
      jsonEvents.some((event) => Array.isArray(event.payload.choices) && JSON.stringify(event.payload.choices).includes("\"role\":\"assistant\"")),
      "cursor stream should emit assistant role chunk",
    )
    assertCondition(
      jsonEvents.some((event) => JSON.stringify(event.payload).includes("\"tool_calls\"")),
      "cursor stream should emit tool_calls chunk",
    )
    assertCondition(
      jsonEvents.some((event) => JSON.stringify(event.payload).includes("\"finish_reason\":\"tool_calls\"")),
      "cursor stream should emit tool_calls finish_reason",
    )
    assertCondition(
      jsonEvents.some((event) => JSON.stringify(event.payload).includes("\"total_tokens\":29")),
      "cursor stream should emit usage chunk",
    )

    await waitForCondition(() => capturedUpstreamRequests.some((item) => item.path === "/backend-api/codex/models"), 5_000, "models request not captured")
    await waitForCondition(() => capturedUpstreamRequests.filter((item) => item.path === "/backend-api/codex/responses").length >= 2, 5_000, "responses requests not captured")

    const nonStreamUpstream = capturedUpstreamRequests.find((item) => item.path === "/backend-api/codex/responses" && item.bodyText.includes("cursor non-stream smoke"))
    assertCondition(nonStreamUpstream, "non-stream upstream request not captured")
    const nonStreamUpstreamBody = JSON.parse(nonStreamUpstream.bodyText) as Record<string, unknown>
    assertCondition(nonStreamUpstreamBody.model === "gpt-5.4", "upstream non-stream model mismatch")
    assertCondition(nonStreamUpstreamBody.stream === true, "upstream non-stream should send stream=true")
    assertCondition(
      typeof nonStreamUpstreamBody.instructions === "string" && String(nonStreamUpstreamBody.instructions).trim().length > 0,
      "upstream non-stream should include instructions",
    )

    const streamUpstream = capturedUpstreamRequests.find((item) => item.path === "/backend-api/codex/responses" && item.bodyText.includes("cursor stream tool smoke"))
    assertCondition(streamUpstream, "stream upstream request not captured")
    const streamUpstreamBody = JSON.parse(streamUpstream.bodyText) as Record<string, unknown>
    assertCondition(streamUpstreamBody.stream === true, "upstream stream should send stream=true")
    assertCondition(Array.isArray(streamUpstreamBody.tools) && streamUpstreamBody.tools.length === 1, "upstream stream should forward tools")
    assertCondition(
      typeof streamUpstreamBody.instructions === "string" && String(streamUpstreamBody.instructions).trim().length > 0,
      "upstream stream should include instructions",
    )

    await Bun.sleep(300)
    const db = new Database(path.join(tempDataDir, "accounts.db"), { readonly: true })
    const audits = db
      .query<
        {
          route: string
          client_mode: string | null
          wire_api: string | null
          model: string | null
          estimated_cost_usd: number | null
          total_tokens: number | null
        },
        []
      >(
        `
          SELECT route, client_mode, wire_api, model, estimated_cost_usd, total_tokens
          FROM request_audits
          WHERE route = '/cursor/v1/chat/completions'
          ORDER BY at DESC
        `,
      )
      .all()
    db.close()

    assertCondition(audits.length >= 2, "cursor chat audits should be recorded")
    assertCondition(
      audits.every((row) => row.client_mode === "cursor" && row.wire_api === "chat_completions"),
      "cursor chat audits should keep client_mode/wire_api",
    )
    assertCondition(
      audits.some((row) => row.model === "gpt-5.4"),
      "cursor chat audits should keep model",
    )
    assertCondition(
      audits.some((row) => Number(row.estimated_cost_usd ?? 0) > 0),
      "cursor chat audits should compute estimated cost",
    )
  } catch (error) {
    findings.push(error instanceof Error ? error.message : String(error))
  } finally {
    await stopChildProcess(child)
    upstreamServer.stop(true)
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const reportLines = [
    "# Cursor Compatibility Audit",
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
    "cursor-compat-audit.md",
    `${reportLines.join("\n")}\n`,
  )

  if (findings.length > 0) {
    console.error(`cursor-compat-audit failed. Report: ${reportPath}`)
    process.exitCode = 1
    return
  }

  console.log(`cursor-compat-audit passed. Report: ${reportPath}`)
}

await main()
