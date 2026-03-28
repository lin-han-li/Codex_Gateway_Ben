import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"
import { bindClientIdentifierToAccount } from "../src/upstream-session-binding"

const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type CapturedRequest = {
  caseId: string
  method: string
  url: string
  headers: Record<string, string>
  body: string
  at: number
  inFlightAtStart: number
}

type AuditResult = {
  id: string
  description: string
  passed: boolean
  findings: string[]
  rootCause?: string
  correctiveAction?: string
}

type SyncResponse = {
  account: { id: string }
  virtualKey?: {
    key: string
    record?: { id: string }
  }
}

type UsageSnapshot = {
  account: { promptTokens: number; completionTokens: number; totalTokens: number }
  key: { promptTokens: number; completionTokens: number; totalTokens: number }
}

const STREAM_USAGE = {
  promptTokens: 11,
  completionTokens: 7,
  totalTokens: 18,
}

const JSON_USAGE = {
  promptTokens: 5,
  completionTokens: 3,
  totalTokens: 8,
}

function headersToObject(headers: Headers) {
  const output: Record<string, string> = {}
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value
  })
  return output
}

function parseUsage(value: unknown) {
  const usage = (value as { usage?: Record<string, unknown> })?.usage ?? {}
  const prompt = Number((usage as Record<string, unknown>).input_tokens ?? (usage as Record<string, unknown>).prompt_tokens ?? 0)
  const completion = Number(
    (usage as Record<string, unknown>).output_tokens ?? (usage as Record<string, unknown>).completion_tokens ?? 0,
  )
  const total = Number((usage as Record<string, unknown>).total_tokens ?? prompt + completion)
  return {
    promptTokens: Number.isFinite(prompt) ? Math.max(0, Math.floor(prompt)) : 0,
    completionTokens: Number.isFinite(completion) ? Math.max(0, Math.floor(completion)) : 0,
    totalTokens: Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0,
  }
}

function usageDelta(after: UsageSnapshot, before: UsageSnapshot) {
  return {
    account: {
      promptTokens: after.account.promptTokens - before.account.promptTokens,
      completionTokens: after.account.completionTokens - before.account.completionTokens,
      totalTokens: after.account.totalTokens - before.account.totalTokens,
    },
    key: {
      promptTokens: after.key.promptTokens - before.key.promptTokens,
      completionTokens: after.key.completionTokens - before.key.completionTokens,
      totalTokens: after.key.totalTokens - before.key.totalTokens,
    },
  }
}

function usageEqual(a: { promptTokens: number; completionTokens: number; totalTokens: number }, b: {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}) {
  return a.promptTokens === b.promptTokens && a.completionTokens === b.completionTokens && a.totalTokens === b.totalTokens
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
  throw new Error("Bridge server health check timed out")
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  return data as T
}

function parseRequestJson(request: CapturedRequest) {
  try {
    return JSON.parse(request.body) as Record<string, unknown>
  } catch {
    return null
  }
}

function getCapturedByCase(captured: CapturedRequest[], caseId: string) {
  return captured.filter((item) => item.caseId === caseId)
}

async function readUsageSnapshot(origin: string, accountId: string, keyId: string): Promise<UsageSnapshot> {
  const accounts = await requestJSON<{ accounts: Array<{ id: string; promptTokens: number; completionTokens: number; totalTokens: number }> }>(
    `${origin}/api/accounts`,
  )
  const keys = await requestJSON<{
    keys: Array<{ id: string; promptTokens: number; completionTokens: number; totalTokens: number }>
  }>(`${origin}/api/virtual-keys`)

  const account = accounts.accounts.find((item) => item.id === accountId)
  if (!account) throw new Error(`Account not found in usage snapshot: ${accountId}`)
  const key = keys.keys.find((item) => item.id === keyId)
  if (!key) throw new Error(`Virtual key not found in usage snapshot: ${keyId}`)

  return {
    account: {
      promptTokens: account.promptTokens ?? 0,
      completionTokens: account.completionTokens ?? 0,
      totalTokens: account.totalTokens ?? 0,
    },
    key: {
      promptTokens: key.promptTokens ?? 0,
      completionTokens: key.completionTokens ?? 0,
      totalTokens: key.totalTokens ?? 0,
    },
  }
}

async function waitForUsageDelta(
  origin: string,
  accountId: string,
  keyId: string,
  before: UsageSnapshot,
  expected: { promptTokens: number; completionTokens: number; totalTokens: number },
  timeoutMs: number,
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const current = await readUsageSnapshot(origin, accountId, keyId)
    const delta = usageDelta(current, before)
    if (usageEqual(delta.account, expected) && usageEqual(delta.key, expected)) {
      return { snapshot: current, delta }
    }
    await Bun.sleep(150)
  }
  const current = await readUsageSnapshot(origin, accountId, keyId)
  return { snapshot: current, delta: usageDelta(current, before) }
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-codex-hard-audit-"))
  const bridgePort = "4811"
  const upstreamPort = "4812"
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const codexEndpoint = `${upstreamOrigin}/backend-api/codex/responses`
  const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  let inFlight = 0
  let maxInFlight = 0
  const captured: CapturedRequest[] = []

  const streamPayload = [
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    "",
    `data: {"type":"response.completed","response":{"id":"resp_stream_usage","usage":{"input_tokens":${STREAM_USAGE.promptTokens},"output_tokens":${STREAM_USAGE.completionTokens},"total_tokens":${STREAM_USAGE.totalTokens}}}}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n")

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const headers = headersToObject(request.headers)
      const body = await request.text()
      const caseId = String(headers["x-audit-case"] ?? "unknown").trim() || "unknown"

      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      captured.push({
        caseId,
        method: request.method,
        url: request.url,
        headers,
        body,
        at: Date.now(),
        inFlightAtStart: inFlight,
      })

      try {
        if (caseId.startsWith("concurrency-")) {
          await Bun.sleep(120)
        }

        if (caseId === "usage-stream") {
          return new Response(streamPayload, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
            },
          })
        }

        if (caseId === "usage-json") {
          return new Response(
            JSON.stringify({
              id: "resp_json_usage",
              object: "response",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
              usage: {
                input_tokens: JSON_USAGE.promptTokens,
                output_tokens: JSON_USAGE.completionTokens,
                total_tokens: JSON_USAGE.totalTokens,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          )
        }

        return new Response(
          JSON.stringify({
            id: `resp_${caseId}`,
            object: "response",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: null,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      } finally {
        inFlight -= 1
      }
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
      OAUTH_CODEX_API_ENDPOINT: codexEndpoint,
      OAUTH_CODEX_CLIENT_VERSION: CODEX_CLIENT_VERSION,
      OAUTH_CODEX_ORIGINATOR: CODEX_ORIGINATOR,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const results: AuditResult[] = []

  const postResponses = async (input: {
    caseId: string
    body: Record<string, unknown>
    query?: string
    headers?: Record<string, string>
  }) => {
    const response = await fetch(`${bridgeOrigin}/v1/responses${input.query ?? ""}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${virtualKey}`,
        originator: CODEX_ORIGINATOR,
        "User-Agent": userAgent,
        version: CODEX_CLIENT_VERSION,
        "openai-beta": "responses=v1",
        "x-audit-case": input.caseId,
        ...(input.headers ?? {}),
      },
      body: JSON.stringify(input.body),
    })
    const text = await response.text()
    return { response, text }
  }

  let virtualKey = ""
  let accountId = ""
  let keyId = ""

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const sync = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Hard Audit OAuth",
        email: "hard-audit@example.com",
        accountId: "org-hard-audit",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: true,
        keyName: "Hard Audit Key",
      }),
    })

    accountId = sync.account?.id ?? ""
    virtualKey = sync.virtualKey?.key ?? ""
    keyId = sync.virtualKey?.record?.id ?? ""
    if (!accountId || !virtualKey || !keyId) {
      throw new Error("Failed to initialize hard audit account/key")
    }

    // 1) Token accounting parity: stream + non-stream
    const usageBefore = await readUsageSnapshot(bridgeOrigin, accountId, keyId)
    await postResponses({
      caseId: "usage-stream",
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "usage-stream" }] }],
        instructions: "hard-audit",
        prompt_cache_key: "sess-usage-stream",
        store: false,
        stream: true,
      },
      headers: { Accept: "text/event-stream" },
    })
    await postResponses({
      caseId: "usage-json",
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "usage-json" }] }],
        instructions: "hard-audit",
        prompt_cache_key: "sess-usage-json",
        store: false,
        stream: false,
      },
    })

    const expectedUsage = {
      promptTokens: STREAM_USAGE.promptTokens + JSON_USAGE.promptTokens,
      completionTokens: STREAM_USAGE.completionTokens + JSON_USAGE.completionTokens,
      totalTokens: STREAM_USAGE.totalTokens + JSON_USAGE.totalTokens,
    }
    const usageWait = await waitForUsageDelta(bridgeOrigin, accountId, keyId, usageBefore, expectedUsage, 8_000)
    const usageFindings: string[] = []
    if (!usageEqual(usageWait.delta.account, expectedUsage)) {
      usageFindings.push(
        `账号 token 增量不匹配: expected=${JSON.stringify(expectedUsage)} actual=${JSON.stringify(usageWait.delta.account)}`,
      )
    }
    if (!usageEqual(usageWait.delta.key, expectedUsage)) {
      usageFindings.push(
        `密钥 token 增量不匹配: expected=${JSON.stringify(expectedUsage)} actual=${JSON.stringify(usageWait.delta.key)}`,
      )
    }
    results.push({
      id: "token_usage_stream_and_json",
      description: "流式与非流式响应都必须实时且准确计入 token 统计",
      passed: usageFindings.length === 0,
      findings: usageFindings,
      rootCause: usageFindings.length > 0 ? "非 SSE 响应未解析 usage 或前端只依赖定时轮询" : undefined,
      correctiveAction: usageFindings.length > 0 ? "在代理端解析 JSON usage 并通过事件通道推送更新" : undefined,
    })

    // 2) Model passthrough
    const modelName = "gpt-5.4.audit-model"
    await postResponses({
      caseId: "model-name",
      body: {
        model: modelName,
        input: [{ role: "user", content: [{ type: "input_text", text: "model-check" }] }],
        instructions: "hard-audit",
        prompt_cache_key: "sess-model",
        store: false,
        stream: false,
      },
    })
    const modelCaptured = getCapturedByCase(captured, "model-name").at(-1)
    const modelBody = modelCaptured ? parseRequestJson(modelCaptured) : null
    const modelFindings: string[] = []
    if (!modelCaptured) modelFindings.push("上游未捕获到模型名检查请求")
    if (modelBody?.model !== modelName) {
      modelFindings.push(`模型名透传不一致: expected=${modelName} actual=${String(modelBody?.model ?? "<missing>")}`)
    }
    results.push({
      id: "model_name_passthrough",
      description: "模型名必须按请求原值透传",
      passed: modelFindings.length === 0,
      findings: modelFindings,
      rootCause: modelFindings.length > 0 ? "代理层改写或未透明转发请求体" : undefined,
      correctiveAction: modelFindings.length > 0 ? "保持 /v1/responses 请求体字节级直通，不做模型字段重写" : undefined,
    })

    // 3) Input length passthrough
    const longInput = `BEGIN-${"L".repeat(120_000)}-END`
    await postResponses({
      caseId: "input-length",
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: longInput }] }],
        instructions: "hard-audit",
        prompt_cache_key: "sess-input-length",
        store: false,
        stream: false,
      },
    })
    const inputCaptured = getCapturedByCase(captured, "input-length").at(-1)
    const inputBody = inputCaptured ? parseRequestJson(inputCaptured) : null
    const capturedLongInput = (((inputBody?.input as Array<Record<string, unknown>> | undefined)?.[0]?.content as Array<Record<string, unknown>> | undefined)?.[0]
      ?.text ?? "") as string
    const inputFindings: string[] = []
    if (!inputCaptured) inputFindings.push("上游未捕获到长输入检查请求")
    if (capturedLongInput.length !== longInput.length) {
      inputFindings.push(`输入长度透传不一致: expected=${longInput.length} actual=${capturedLongInput.length}`)
    }
    if (capturedLongInput !== longInput) {
      inputFindings.push("输入内容透传不一致: 长文本发生截断或内容改变")
    }
    results.push({
      id: "input_length_passthrough",
      description: "长输入内容与长度必须原样透传",
      passed: inputFindings.length === 0,
      findings: inputFindings,
      rootCause: inputFindings.length > 0 ? "代理层存在额外编码/裁剪行为" : undefined,
      correctiveAction: inputFindings.length > 0 ? "保留原始请求体，不做中间重写和长度限制" : undefined,
    })

    // 4) Tools/session fields passthrough
    const toolsPayload = [
      {
        type: "function",
        name: "search_files",
        description: "search files",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        type: "function",
        name: "read_file",
        description: "read file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]
    const sessionHeader = "conv-hard-audit-001"
    const promptCacheKey = "sess-hard-audit-key-001"
    const query = "?audit_flag=1&audit_flag=2&client_mode=fast"
    await postResponses({
      caseId: "tools-session-query",
      query,
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "tools-session-query" }] }],
        instructions: "hard-audit",
        prompt_cache_key: promptCacheKey,
        tools: toolsPayload,
        tool_choice: "required",
        parallel_tool_calls: false,
        store: false,
        stream: false,
      },
      headers: {
        session_id: sessionHeader,
      },
    })
    const toolsCaptured = getCapturedByCase(captured, "tools-session-query").at(-1)
    const toolsBody = toolsCaptured ? parseRequestJson(toolsCaptured) : null
    const toolsFindings: string[] = []
    const expectedPromptCacheKey = bindClientIdentifierToAccount({
      accountId,
      fieldKey: "prompt_cache_key",
      value: promptCacheKey,
    })
    const expectedSessionHeader = bindClientIdentifierToAccount({
      accountId,
      fieldKey: "session_id",
      value: sessionHeader,
    })
    if (!toolsCaptured) {
      toolsFindings.push("上游未捕获到工具/会话检查请求")
    } else {
      if (JSON.stringify(toolsBody?.tools ?? null) !== JSON.stringify(toolsPayload)) {
        toolsFindings.push("tools 字段透传不一致")
      }
      if (toolsBody?.tool_choice !== "required") {
        toolsFindings.push(`tool_choice 透传不一致: ${String(toolsBody?.tool_choice ?? "<missing>")}`)
      }
      if (toolsBody?.parallel_tool_calls !== false) {
        toolsFindings.push(`parallel_tool_calls 透传不一致: ${String(toolsBody?.parallel_tool_calls ?? "<missing>")}`)
      }
      if (toolsBody?.prompt_cache_key !== promptCacheKey) {
        toolsFindings.push(`prompt_cache_key 透传不一致: ${String(toolsBody?.prompt_cache_key ?? "<missing>")}`)
      }
      if (toolsCaptured.headers["session_id"] !== sessionHeader) {
        toolsFindings.push(`session_id 头透传不一致: ${String(toolsCaptured.headers["session_id"] ?? "<missing>")}`)
      }

      for (let index = toolsFindings.length - 1; index >= 0; index -= 1) {
        const finding = toolsFindings[index] ?? ""
        if (finding.includes("prompt_cache_key") || finding.includes("session_id")) {
          toolsFindings.splice(index, 1)
        }
      }
      if (toolsBody?.prompt_cache_key !== expectedPromptCacheKey) {
        toolsFindings.push(
          `prompt_cache_key expected=${expectedPromptCacheKey} actual=${String(toolsBody?.prompt_cache_key ?? "<missing>")}`,
        )
      }
      if (toolsCaptured.headers["session_id"] !== expectedSessionHeader) {
        toolsFindings.push(
          `session_id expected=${expectedSessionHeader} actual=${String(toolsCaptured.headers["session_id"] ?? "<missing>")}`,
        )
      }

      const upstreamUrl = new URL(toolsCaptured.url)
      const flags = upstreamUrl.searchParams.getAll("audit_flag")
      const clientMode = upstreamUrl.searchParams.get("client_mode")
      if (flags.length !== 2 || flags[0] !== "1" || flags[1] !== "2") {
        toolsFindings.push(`query 透传不一致: audit_flag=${JSON.stringify(flags)}`)
      }
      if (clientMode !== "fast") {
        toolsFindings.push(`query 透传不一致: client_mode=${String(clientMode ?? "<missing>")}`)
      }
    }
    results.push({
      id: "tools_session_query_passthrough",
      description: "工具调用字段、会话字段与查询参数必须无损透传",
      passed: toolsFindings.length === 0,
      findings: toolsFindings,
      rootCause: toolsFindings.length > 0 ? "代理仅转发固定路径，未完整转发请求上下文" : undefined,
      correctiveAction: toolsFindings.length > 0 ? "透传 query/session/tool 字段，避免路由和字段丢失" : undefined,
    })

    // 5) Header sanitization: local-only headers must not leak upstream
    await postResponses({
      caseId: "header-sanitization",
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "header-sanitization" }] }],
        instructions: "hard-audit",
        prompt_cache_key: "sess-header",
        store: false,
        stream: false,
      },
      headers: {
        "x-admin-token": "should-not-pass",
        "x-sensitive-action": "confirm",
      },
    })
    const headerCaptured = getCapturedByCase(captured, "header-sanitization").at(-1)
    const headerFindings: string[] = []
    if (!headerCaptured) {
      headerFindings.push("上游未捕获到头部净化检查请求")
    } else {
      if ("x-admin-token" in headerCaptured.headers) {
        headerFindings.push("x-admin-token 被错误透传到了上游")
      }
      if ("x-sensitive-action" in headerCaptured.headers) {
        headerFindings.push("x-sensitive-action 被错误透传到了上游")
      }
    }
    results.push({
      id: "header_sanitization",
      description: "本地管理头必须拦截，不能透传到 OpenAI 上游",
      passed: headerFindings.length === 0,
      findings: headerFindings,
      rootCause: headerFindings.length > 0 ? "透传过滤名单缺失本地管理头" : undefined,
      correctiveAction: headerFindings.length > 0 ? "在转发层加入本地敏感头黑名单" : undefined,
    })

    // 6) Concurrency cadence: requests should keep parallelism.
    const concurrencyCount = 8
    await Promise.all(
      Array.from({ length: concurrencyCount }).map((_, index) => {
        const seq = index + 1
        return postResponses({
          caseId: `concurrency-${seq}`,
          body: {
            model: "gpt-5.4",
            input: [{ role: "user", content: [{ type: "input_text", text: `concurrency-${seq}` }] }],
            instructions: "hard-audit",
            prompt_cache_key: `sess-concurrency-${seq}`,
            store: false,
            stream: false,
          },
        })
      }),
    )

    const concurrencyCaptured = captured.filter((item) => item.caseId.startsWith("concurrency-"))
    const concurrencyFindings: string[] = []
    if (concurrencyCaptured.length !== concurrencyCount) {
      concurrencyFindings.push(`并发请求捕获数量不一致: expected=${concurrencyCount} actual=${concurrencyCaptured.length}`)
    }
    if (maxInFlight < 2) {
      concurrencyFindings.push(`并发节奏异常: maxInFlight=${maxInFlight}，请求被串行化`)
    }
    const seenMessages = new Set<string>()
    for (const item of concurrencyCaptured) {
      const body = parseRequestJson(item)
      const text = ((((body?.input as Array<Record<string, unknown>> | undefined)?.[0]?.content as Array<Record<string, unknown>> | undefined)?.[0]
        ?.text ?? "") as string)
      if (text) seenMessages.add(text)
    }
    for (let i = 1; i <= concurrencyCount; i += 1) {
      if (!seenMessages.has(`concurrency-${i}`)) {
        concurrencyFindings.push(`并发请求体透传缺失: concurrency-${i}`)
      }
    }
    results.push({
      id: "concurrency_cadence",
      description: "并发请求应保持并发节奏，不应串行退化或请求串扰",
      passed: concurrencyFindings.length === 0,
      findings: concurrencyFindings,
      rootCause: concurrencyFindings.length > 0 ? "代理处理模型中存在阻塞或共享状态串扰" : undefined,
      correctiveAction: concurrencyFindings.length > 0 ? "保持请求无状态透传并避免串行瓶颈" : undefined,
    })
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const passedCount = results.filter((item) => item.passed).length
  const summary = `Hard audit: ${passedCount}/${results.length} checks passed`

  const lines = [
    "# Codex Hard Audit Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Summary: ${summary}`,
    "",
    "## Checks",
    ...results.flatMap((item) => {
      const head = [`### ${item.id}`, `- Description: ${item.description}`, `- Result: ${item.passed ? "PASS" : "FAIL"}`]
      if (item.findings.length === 0) return [...head, ""]
      const detail = [
        ...head,
        "- Findings:",
        ...item.findings.map((finding) => `  - ${finding}`),
      ]
      if (item.rootCause) detail.push(`- Root Cause: ${item.rootCause}`)
      if (item.correctiveAction) detail.push(`- Corrective Action: ${item.correctiveAction}`)
      detail.push("")
      return detail
    }),
  ]

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const defaultReportFile = path.join(reportDir, "codex-hard-audit.md")
  let reportFile = defaultReportFile
  try {
    await writeFile(reportFile, lines.join("\n"), "utf8")
  } catch {
    reportFile = path.join(reportDir, `codex-hard-audit-${Date.now()}.md`)
    await writeFile(reportFile, lines.join("\n"), "utf8")
  }

  console.log(summary)
  console.log(`Report saved: ${reportFile}`)

  if (results.some((item) => !item.passed)) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("Hard audit failed:", error)
  process.exit(1)
})
