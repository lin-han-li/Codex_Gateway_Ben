import os from "node:os"
import path from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"

type Usage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

type StateSnapshot = {
  accountPrompt: number
  accountCompletion: number
  accountTotal: number
  keyPrompt: number
  keyCompletion: number
  keyTotal: number
  globalPrompt: number
  globalCompletion: number
  globalTotal: number
}

type CaseResult = {
  id: number
  stream: boolean
  promptPreview: string
  expected: Usage
  observedDelta: StateSnapshot
  pass: boolean
}

type TestCase = {
  stream: boolean
  prompt: string
  responseMode?: "default" | "mislabeled-sse"
}

const projectDir = path.resolve(import.meta.dir, "..")
const dataDir = mkdtempSync(path.join(os.tmpdir(), "token-accuracy-audit-"))

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function summarizePromptText(input: unknown) {
  const text = String(input ?? "").trim()
  if (!text) return ""
  return text.length > 48 ? `${text.slice(0, 48)}...` : text
}

function flattenInputText(body: Record<string, unknown>) {
  const parts: string[] = []
  const input = Array.isArray(body.input) ? body.input : []
  for (const row of input) {
    if (!row || typeof row !== "object") continue
    const content = (row as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      if (!item || typeof item !== "object") continue
      const text = (item as Record<string, unknown>).text
      if (typeof text === "string" && text.trim().length > 0) {
        parts.push(text.trim())
      }
    }
  }
  return parts.join("\n")
}

function estimateUsageFromPrompt(promptText: string, stream: boolean): Usage {
  const bytes = new TextEncoder().encode(promptText)
  const promptBase = Math.max(20, Math.ceil(bytes.byteLength / 2.8))
  const completionBase = Math.max(24, Math.ceil(promptBase * (stream ? 0.72 : 0.58)))
  const inputTokens = promptBase + (stream ? 9 : 6)
  const outputTokens = completionBase + (stream ? 7 : 5)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
}

function normalizeUsage(payload: unknown): Usage {
  const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  const usage = raw.usage && typeof raw.usage === "object" ? (raw.usage as Record<string, unknown>) : raw
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  const total = Number(usage.total_tokens ?? input + output)
  return {
    input_tokens: Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0,
    output_tokens: Number.isFinite(output) ? Math.max(0, Math.floor(output)) : 0,
    total_tokens: Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0,
  }
}

function parseSseCompletedUsage(rawText: string): Usage {
  const normalized = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
  const blocks = normalized.split("\n\n")
  for (const block of blocks) {
    if (!block.trim()) continue
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s*/, ""))
      .join("\n")
      .trim()
    if (!data || data === "[DONE]") continue
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (String(parsed.type ?? "") !== "response.completed") continue
      const response = parsed.response as Record<string, unknown>
      return normalizeUsage(response ?? {})
    } catch {
      // ignore invalid SSE chunks
    }
  }
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
}

function diffState(next: StateSnapshot, prev: StateSnapshot): StateSnapshot {
  return {
    accountPrompt: next.accountPrompt - prev.accountPrompt,
    accountCompletion: next.accountCompletion - prev.accountCompletion,
    accountTotal: next.accountTotal - prev.accountTotal,
    keyPrompt: next.keyPrompt - prev.keyPrompt,
    keyCompletion: next.keyCompletion - prev.keyCompletion,
    keyTotal: next.keyTotal - prev.keyTotal,
    globalPrompt: next.globalPrompt - prev.globalPrompt,
    globalCompletion: next.globalCompletion - prev.globalCompletion,
    globalTotal: next.globalTotal - prev.globalTotal,
  }
}

function isDeltaMatchingUsage(delta: StateSnapshot, usage: Usage) {
  return (
    delta.accountPrompt === usage.input_tokens &&
    delta.accountCompletion === usage.output_tokens &&
    delta.accountTotal === usage.total_tokens &&
    delta.keyPrompt === usage.input_tokens &&
    delta.keyCompletion === usage.output_tokens &&
    delta.keyTotal === usage.total_tokens &&
    delta.globalPrompt === usage.input_tokens &&
    delta.globalCompletion === usage.output_tokens &&
    delta.globalTotal === usage.total_tokens
  )
}

async function waitForGatewayReady(url: string, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const resp = await fetch(url)
      if (resp.ok) return
    } catch {
      // ignore
    }
    await sleep(250)
  }
  throw new Error(`Gateway health check timeout: ${url}`)
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

async function main() {
  const mockPort = await reserveFreePort()
  const gatewayPort = await reserveFreePort()
  const testCases: TestCase[] = [
    { stream: false, prompt: "请解释 React useEffect 依赖数组遗漏时的闭包问题，并给一个可运行修复示例。" },
    { stream: true, prompt: "帮我设计一个 Node.js 请求重试器，要求指数退避+抖动，并说明为什么要限制最大重试次数。" },
    { stream: false, prompt: "对下面 SQL 慢查询给出索引优化策略：订单表按用户分页查询且按创建时间倒序。" },
    { stream: true, prompt: "把这段 Python 并发代码改成 asyncio 版本，并说明 IO 密集和 CPU 密集场景的差异。" },
    { stream: false, prompt: "给我一个前端错误监控方案，包含采样、去重、source map、告警分级和回滚策略。" },
    { stream: true, prompt: "请用 TypeScript 实现一个配置热更新模块，要求原子替换、版本号校验和回滚机制。" },
    { stream: true, prompt: "mislabeled-sse usage fallback validation", responseMode: "mislabeled-sse" },
  ]

  const mockServer = Bun.serve({
    hostname: "127.0.0.1",
    port: mockPort,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "gpt-5.3-codex", object: "model" }],
        })
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
        return req.json().then((body: Record<string, unknown>) => {
          const stream = body.stream === true
          const promptText = flattenInputText(body)
          const usage = estimateUsageFromPrompt(promptText, stream)
          if (!stream) {
            return Response.json({
              id: `resp_${crypto.randomUUID()}`,
              object: "response",
              output_text: "ok",
              usage,
            })
          }

          const encoder = new TextEncoder()
          const chunks = [
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
            `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", text: "ok" })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${crypto.randomUUID()}`, output_text: "ok", usage } })}\n\n`,
            "data: [DONE]\n\n",
          ]
          const sse = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk))
              }
              controller.close()
            },
          })
          return new Response(sse, {
            status: 200,
            headers: {
              "content-type": req.headers.get("x-accuracy-response-mode") === "mislabeled-sse" ? "application/json" : "text/event-stream",
            },
          })
        })
      }

      if (url.pathname.endsWith("/usage")) {
        return Response.json({
          object: "rate_limits.usage",
          data: [],
        })
      }

      return new Response("not found", { status: 404 })
    },
  })

  const gateway = Bun.spawn(["bun", "src/index.ts"], {
    cwd: projectDir,
    env: {
      ...process.env,
      OAUTH_APP_HOST: "127.0.0.1",
      OAUTH_APP_PORT: String(gatewayPort),
      OAUTH_APP_DATA_DIR: dataDir,
      OAUTH_APP_ADMIN_TOKEN: "",
      OAUTH_APP_ENCRYPTION_KEY: "",
      OAUTH_APP_FORWARD_PROXY_ENABLED: "0",
      OAUTH_OPENAI_API_BASE: `http://127.0.0.1:${mockPort}/v1`,
    },
    stdout: "ignore",
    stderr: "ignore",
  })

  async function api(pathname: string, init?: RequestInit) {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers || {}),
      },
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    if (!res.ok) {
      throw new Error(`${pathname} ${res.status}: ${text}`)
    }
    return body
  }

  async function fetchState(keyId: string, accountId: string): Promise<StateSnapshot> {
    const accountsPayload = await api("/api/accounts")
    const keysPayload = await api("/api/virtual-keys")
    const account = (accountsPayload.accounts || []).find((item: any) => item.id === accountId) || {}
    const key = (keysPayload.keys || []).find((item: any) => item.id === keyId) || {}
    return {
      accountPrompt: Number(account.promptTokens || 0),
      accountCompletion: Number(account.completionTokens || 0),
      accountTotal: Number(account.totalTokens || 0),
      keyPrompt: Number(key.promptTokens || 0),
      keyCompletion: Number(key.completionTokens || 0),
      keyTotal: Number(key.totalTokens || 0),
      globalPrompt: Number(accountsPayload.usageTotals?.promptTokens || 0),
      globalCompletion: Number(accountsPayload.usageTotals?.completionTokens || 0),
      globalTotal: Number(accountsPayload.usageTotals?.totalTokens || 0),
    }
  }

  try {
    await waitForGatewayReady(`http://127.0.0.1:${gatewayPort}/api/health`)

    const added = await api("/api/accounts/api-key", {
      method: "POST",
      body: JSON.stringify({
        providerId: "openai",
        providerName: "OpenAI",
        methodId: "api-key",
        displayName: "accuracy-audit-account",
        apiKey: "sk-test-token-accuracy-audit",
      }),
    })
    const accountId = String(added.account.id)

    const issued = await api("/api/virtual-keys/issue", {
      method: "POST",
      body: JSON.stringify({
        providerId: "openai",
        routingMode: "single",
        accountId,
        name: "accuracy-audit-key",
        validityDays: 30,
      }),
    })
    const keyId = String(issued.record.id)
    const secret = String(issued.key)

    let previous = await fetchState(keyId, accountId)
    const results: CaseResult[] = []

    for (let index = 0; index < testCases.length; index += 1) {
      const test = testCases[index]
      const requestBody = {
        model: "gpt-5.3-codex",
        input: [{ role: "user", content: [{ type: "input_text", text: test.prompt }] }],
        stream: test.stream,
      }

      const upstreamResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
          ...(test.stream ? { accept: "text/event-stream" } : {}),
          ...(test.responseMode ? { "x-accuracy-response-mode": test.responseMode } : {}),
        },
        body: JSON.stringify(requestBody),
      })

      if (!upstreamResponse.ok) {
        throw new Error(`Test case ${index + 1} failed: ${upstreamResponse.status} ${await upstreamResponse.text()}`)
      }

      const expectedUsage = test.stream
        ? parseSseCompletedUsage(await upstreamResponse.text())
        : normalizeUsage(await upstreamResponse.json())

      await sleep(test.stream ? 500 : 250)
      const current = await fetchState(keyId, accountId)
      const observedDelta = diffState(current, previous)
      previous = current

      results.push({
        id: index + 1,
        stream: test.stream,
        promptPreview: summarizePromptText(test.prompt),
        expected: expectedUsage,
        observedDelta,
        pass: isDeltaMatchingUsage(observedDelta, expectedUsage),
      })
    }

    const passCount = results.filter((item) => item.pass).length
    const totalExpected = results.reduce(
      (acc, item) => {
        acc.input_tokens += item.expected.input_tokens
        acc.output_tokens += item.expected.output_tokens
        acc.total_tokens += item.expected.total_tokens
        return acc
      },
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    )

    const finalState = await fetchState(keyId, accountId)
    console.log(
      JSON.stringify(
        {
          ok: passCount === results.length,
          summary: {
            totalCases: results.length,
            passedCases: passCount,
            failedCases: results.length - passCount,
          },
          totalExpectedUsage: totalExpected,
          finalTotals: finalState,
          results,
          env: {
            gateway: `http://127.0.0.1:${gatewayPort}`,
            mockUpstream: `http://127.0.0.1:${mockPort}/v1`,
          },
        },
        null,
        2,
      ),
    )
  } finally {
    try {
      gateway.kill()
    } catch {}
    try {
      mockServer.stop(true)
    } catch {}
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {}
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
