import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"

type CapturedUpstream = {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

type SyncResponse = {
  account?: { id: string }
  virtualKey?: { key?: string; record?: { id?: string } }
}

type AddApiKeyAccountResponse = {
  account?: { id: string }
}

type IssueVirtualKeyResponse = {
  key?: string
  record?: { id?: string }
}

type ModeCheck = {
  mode: "oauth" | "apikey"
  matched: boolean
  findings: string[]
  rootCause: string
  correctiveAction: string
}

type ModelsPassthroughCheck = {
  matched: boolean
  findings: string[]
}

function headersToObject(headers: Headers) {
  const output: Record<string, string> = {}
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value
  })
  return output
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function waitForHealth(origin: string, timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // continue polling
    }
    await Bun.sleep(250)
  }
  throw new Error("Server health check timed out")
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  }
  return data as T
}

function findCaptured(captured: CapturedUpstream[], caseId: string) {
  return captured.find((item) => item.headers["x-audit-case"] === caseId) ?? null
}

function evaluateOAuthParity(captured: CapturedUpstream): ModeCheck {
  const findings: string[] = []
  const pathName = new URL(captured.url).pathname
  if (captured.method !== "POST") findings.push(`method expected=POST actual=${captured.method}`)
  if (pathName !== "/backend-api/codex/responses") findings.push(`path expected=/backend-api/codex/responses actual=${pathName}`)

  const auth = String(captured.headers.authorization ?? "")
  if (auth !== "Bearer fake-access-token") {
    findings.push(`authorization expected=Bearer fake-access-token actual=${auth || "<missing>"}`)
  }

  if (!captured.headers["chatgpt-account-id"]) {
    findings.push("ChatGPT-Account-ID expected but missing")
  } else if (captured.headers["chatgpt-account-id"] !== "org-oauth-parity") {
    findings.push(`ChatGPT-Account-ID expected=org-oauth-parity actual=${captured.headers["chatgpt-account-id"]}`)
  }

  if (captured.headers.originator !== "codex_cli_rs") {
    findings.push(`originator expected=codex_cli_rs actual=${captured.headers.originator ?? "<missing>"}`)
  }
  if (captured.headers.version !== "1.2.27") {
    findings.push(`version expected=1.2.27 actual=${captured.headers.version ?? "<missing>"}`)
  }
  if (captured.headers["user-agent"] !== "codex_cli_rs/1.2.27 (parity-audit)") {
    findings.push(`user-agent expected=codex_cli_rs/1.2.27 (parity-audit) actual=${captured.headers["user-agent"] ?? "<missing>"}`)
  }

  return {
    mode: "oauth",
    matched: findings.length === 0,
    findings,
    rootCause:
      findings.length === 0
        ? "OAuth 模式上游路径与鉴权字段和官方 ChatGPT Auth 语义一致。"
        : "OAuth 模式上游路径或鉴权字段与官方 ChatGPT Auth 语义不一致。",
    correctiveAction:
      findings.length === 0
        ? "保持当前 OAuth 转发逻辑（authorization、ChatGPT-Account-ID、客户端身份头）不变。"
        : "按 findings 修复路径与关键头字段，优先修复 path、authorization、ChatGPT-Account-ID。",
  }
}

function evaluateApiKeyParity(captured: {
  responses: CapturedUpstream
  compact: CapturedUpstream
  models: CapturedUpstream
  modelById: CapturedUpstream
}): ModeCheck {
  const findings: string[] = []
  const all = [captured.responses, captured.compact, captured.models, captured.modelById]

  const checkPath = (name: string, value: CapturedUpstream, expected: string) => {
    const pathName = new URL(value.url).pathname
    if (pathName !== expected) findings.push(`${name} path expected=${expected} actual=${pathName}`)
  }
  checkPath("responses", captured.responses, "/v1/responses")
  checkPath("compact", captured.compact, "/v1/responses/compact")
  checkPath("models", captured.models, "/v1/models")
  checkPath("models/:id", captured.modelById, "/v1/models/gpt-5.4")

  if (captured.responses.method !== "POST") findings.push(`responses method expected=POST actual=${captured.responses.method}`)
  if (captured.compact.method !== "POST") findings.push(`compact method expected=POST actual=${captured.compact.method}`)
  if (captured.models.method !== "GET") findings.push(`models method expected=GET actual=${captured.models.method}`)
  if (captured.modelById.method !== "GET") findings.push(`models/:id method expected=GET actual=${captured.modelById.method}`)

  for (const [index, item] of all.entries()) {
    const auth = String(item.headers.authorization ?? "")
    if (auth !== "Bearer fake-openai-api-key") {
      findings.push(`request-${index + 1} authorization expected=Bearer fake-openai-api-key actual=${auth || "<missing>"}`)
    }
    if (item.headers["chatgpt-account-id"]) {
      findings.push(`request-${index + 1} ChatGPT-Account-ID should be absent in API key mode`)
    }
    if (item.headers.originator !== "codex_cli_rs") {
      findings.push(`request-${index + 1} originator expected=codex_cli_rs actual=${item.headers.originator ?? "<missing>"}`)
    }
    if (item.headers.version !== "1.2.27") {
      findings.push(`request-${index + 1} version expected=1.2.27 actual=${item.headers.version ?? "<missing>"}`)
    }
    if (item.headers["user-agent"] !== "codex_cli_rs/1.2.27 (parity-audit)") {
      findings.push(
        `request-${index + 1} user-agent expected=codex_cli_rs/1.2.27 (parity-audit) actual=${item.headers["user-agent"] ?? "<missing>"}`,
      )
    }
    if (item.headers["openai-organization"] !== "org_test_parity") {
      findings.push(
        `request-${index + 1} OpenAI-Organization expected=org_test_parity actual=${item.headers["openai-organization"] ?? "<missing>"}`,
      )
    }
    if (item.headers["openai-project"] !== "proj_test_parity") {
      findings.push(`request-${index + 1} OpenAI-Project expected=proj_test_parity actual=${item.headers["openai-project"] ?? "<missing>"}`)
    }
  }

  return {
    mode: "apikey",
    matched: findings.length === 0,
    findings,
    rootCause:
      findings.length === 0
        ? "API key 模式上游路径、鉴权头、客户端身份头与官方 OpenAI provider 语义一致。"
        : "API key 模式仍存在路径或头部语义偏差，影响官方 API key 行为对齐。",
    correctiveAction:
      findings.length === 0
        ? "保持当前 openai provider 转发语义（/v1/* + API key bearer + 无 ChatGPT-Account-ID）。"
        : "按 findings 修复路径与关键头字段，确保 API key 模式仅使用 OpenAI 语义。",
  }
}

function evaluateModelsPassthrough(input: {
  listStatus: number
  listHeader: string
  listBody: string
  detailStatus: number
  detailHeader: string
  detailBody: string
}): ModelsPassthroughCheck {
  const findings: string[] = []
  if (input.listStatus !== 206) findings.push(`models list status expected=206 actual=${input.listStatus}`)
  if (input.listHeader !== "list-pass") findings.push(`models list x-parity-models expected=list-pass actual=${input.listHeader || "<missing>"}`)
  if (!input.listBody.includes("\"object\":\"list\"")) findings.push("models list body passthrough check failed")

  if (input.detailStatus !== 202) findings.push(`models/:id status expected=202 actual=${input.detailStatus}`)
  if (input.detailHeader !== "detail-pass") {
    findings.push(`models/:id x-parity-model-id expected=detail-pass actual=${input.detailHeader || "<missing>"}`)
  }
  if (!input.detailBody.includes("\"id\":\"gpt-5.4\"")) findings.push("models/:id body passthrough check failed")

  return {
    matched: findings.length === 0,
    findings,
  }
}

function toMarkdown(input: {
  oauth: ModeCheck
  apiKey: ModeCheck
  modelsPassthrough: ModelsPassthroughCheck
  oauthCaptured: CapturedUpstream
  apiKeyCaptured: {
    responses: CapturedUpstream
    compact: CapturedUpstream
    models: CapturedUpstream
    modelById: CapturedUpstream
  }
}) {
  const lines: string[] = []
  lines.push("# OAuth vs API Key 对齐审计")
  lines.push("")
  lines.push(`生成时间: ${new Date().toISOString()}`)
  lines.push("")
  lines.push("## 抓包样本（OAuth）")
  lines.push(`- method: ${input.oauthCaptured.method}`)
  lines.push(`- url: ${input.oauthCaptured.url}`)
  lines.push(`- authorization: ${input.oauthCaptured.headers.authorization ?? "<missing>"}`)
  lines.push(`- chatgpt-account-id: ${input.oauthCaptured.headers["chatgpt-account-id"] ?? "<missing>"}`)
  lines.push("")
  lines.push("## 抓包样本（API Key）")
  lines.push(`- responses: ${input.apiKeyCaptured.responses.method} ${input.apiKeyCaptured.responses.url}`)
  lines.push(`- compact: ${input.apiKeyCaptured.compact.method} ${input.apiKeyCaptured.compact.url}`)
  lines.push(`- models: ${input.apiKeyCaptured.models.method} ${input.apiKeyCaptured.models.url}`)
  lines.push(`- models/:id: ${input.apiKeyCaptured.modelById.method} ${input.apiKeyCaptured.modelById.url}`)
  lines.push("")
  lines.push("## OAuth 模式与官方对齐结果")
  lines.push(`- matched: ${input.oauth.matched ? "YES" : "NO"}`)
  for (const finding of input.oauth.findings) lines.push(`- finding: ${finding}`)
  lines.push(`- rootCause: ${input.oauth.rootCause}`)
  lines.push(`- correctiveAction: ${input.oauth.correctiveAction}`)
  lines.push("")
  lines.push("## API Key 模式与官方对齐结果")
  lines.push(`- matched: ${input.apiKey.matched ? "YES" : "NO"}`)
  for (const finding of input.apiKey.findings) lines.push(`- finding: ${finding}`)
  lines.push(`- rootCause: ${input.apiKey.rootCause}`)
  lines.push(`- correctiveAction: ${input.apiKey.correctiveAction}`)
  lines.push("")
  lines.push("## models 接口透传检查（API Key）")
  lines.push(`- matched: ${input.modelsPassthrough.matched ? "YES" : "NO"}`)
  for (const finding of input.modelsPassthrough.findings) lines.push(`- finding: ${finding}`)
  lines.push("")
  return lines.join("\n")
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-authmode-parity-"))
  const bridgePort = "4831"
  const upstreamPort = "4832"
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const outputDir = path.join(process.cwd(), "_tmp", "parity")
  const outputPath = path.join(outputDir, "codex-oauth-vs-apikey-parity.md")

  const capturedRequests: CapturedUpstream[] = []
  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      const url = new URL(request.url)
      const pathname = url.pathname
      const headers = headersToObject(request.headers)
      capturedRequests.push({
        method: request.method,
        url: request.url,
        headers,
        body: await request.text(),
      })

      if (pathname === "/v1/models") {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-5.4", object: "model" }],
          }),
          {
            status: 206,
            headers: {
              "Content-Type": "application/json",
              "x-parity-models": "list-pass",
            },
          },
        )
      }

      if (pathname === "/v1/models/gpt-5.4") {
        return new Response(
          JSON.stringify({
            id: "gpt-5.4",
            object: "model",
          }),
          {
            status: 202,
            headers: {
              "Content-Type": "application/json",
              "x-parity-model-id": "detail-pass",
            },
          },
        )
      }

      if (pathname === "/v1/responses/compact") {
        return new Response(
          JSON.stringify({
            id: "resp_compact_mock",
            object: "response",
            output_text: "compact-ok",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        )
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
          headers: {
            "Content-Type": "application/json",
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
      OAUTH_APP_DATA_DIR: tempDataDir,
      OAUTH_APP_FORWARD_PROXY_ENABLED: "0",
      OAUTH_CODEX_API_BASE: `${upstreamOrigin}/backend-api/codex`,
      OAUTH_OPENAI_API_BASE: `${upstreamOrigin}/v1`,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const oauthSync = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "OAuth Parity",
        email: "oauth-parity@example.com",
        accountId: "org-oauth-parity",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: true,
        keyName: "OAuth Parity Key",
      }),
    })
    const oauthVirtualKey = String(oauthSync.virtualKey?.key ?? "").trim()
    assertCondition(oauthVirtualKey.length > 0, "oauth virtual key missing")

    const apikeyAccount = await requestJSON<AddApiKeyAccountResponse>(`${bridgeOrigin}/api/accounts/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        providerName: "OpenAI",
        methodId: "api-key",
        displayName: "APIKey Parity",
        apiKey: "fake-openai-api-key",
        organizationId: "org_test_parity",
        projectId: "proj_test_parity",
      }),
    })
    const openaiAccountId = String(apikeyAccount.account?.id ?? "").trim()
    assertCondition(openaiAccountId.length > 0, "openai api-key account missing")

    const apikeyIssue = await requestJSON<IssueVirtualKeyResponse>(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        routingMode: "single",
        accountId: openaiAccountId,
        name: "APIKey Parity Key",
      }),
    })
    const apikeyVirtualKey = String(apikeyIssue.key ?? "").trim()
    assertCondition(apikeyVirtualKey.length > 0, "apikey virtual key missing")

    const commonIdentityHeaders = {
      originator: "codex_cli_rs",
      version: "1.2.27",
      "user-agent": "codex_cli_rs/1.2.27 (parity-audit)",
      "openai-beta": "responses=v1",
    }

    const requestBody = JSON.stringify({
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "parity-check" }] }],
      instructions: "parity",
      stream: false,
      store: false,
    })

    const oauthResponse = await fetch(`${bridgeOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oauthVirtualKey}`,
        "x-audit-case": "oauth-response",
        ...commonIdentityHeaders,
      },
      body: requestBody,
    })
    await oauthResponse.text().catch(() => "")

    const apikeyResponse = await fetch(`${bridgeOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apikeyVirtualKey}`,
        "x-audit-case": "apikey-response",
        ...commonIdentityHeaders,
      },
      body: requestBody,
    })
    await apikeyResponse.text().catch(() => "")

    const apikeyCompactResponse = await fetch(`${bridgeOrigin}/v1/responses/compact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apikeyVirtualKey}`,
        "x-audit-case": "apikey-compact",
        ...commonIdentityHeaders,
      },
      body: requestBody,
    })
    await apikeyCompactResponse.text().catch(() => "")

    const modelsResponse = await fetch(`${bridgeOrigin}/v1/models?client_version=1.2.27`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apikeyVirtualKey}`,
        "x-audit-case": "apikey-models",
        ...commonIdentityHeaders,
      },
    })
    const modelsBody = await modelsResponse.text().catch(() => "")

    const modelByIdResponse = await fetch(`${bridgeOrigin}/v1/models/gpt-5.4?client_version=1.2.27`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apikeyVirtualKey}`,
        "x-audit-case": "apikey-model-id",
        ...commonIdentityHeaders,
      },
    })
    const modelByIdBody = await modelByIdResponse.text().catch(() => "")

    const oauthCaptured = findCaptured(capturedRequests, "oauth-response")
    const apikeyResponsesCaptured = findCaptured(capturedRequests, "apikey-response")
    const apikeyCompactCaptured = findCaptured(capturedRequests, "apikey-compact")
    const apikeyModelsCaptured = findCaptured(capturedRequests, "apikey-models")
    const apikeyModelByIdCaptured = findCaptured(capturedRequests, "apikey-model-id")

    assertCondition(oauthCaptured, "no oauth /responses upstream request captured")
    assertCondition(apikeyResponsesCaptured, "no apikey /responses upstream request captured")
    assertCondition(apikeyCompactCaptured, "no apikey /responses/compact upstream request captured")
    assertCondition(apikeyModelsCaptured, "no apikey /models upstream request captured")
    assertCondition(apikeyModelByIdCaptured, "no apikey /models/:id upstream request captured")

    const oauthCheck = evaluateOAuthParity(oauthCaptured)
    const apikeyCheck = evaluateApiKeyParity({
      responses: apikeyResponsesCaptured,
      compact: apikeyCompactCaptured,
      models: apikeyModelsCaptured,
      modelById: apikeyModelByIdCaptured,
    })
    const modelsPassthrough = evaluateModelsPassthrough({
      listStatus: modelsResponse.status,
      listHeader: modelsResponse.headers.get("x-parity-models") ?? "",
      listBody: modelsBody,
      detailStatus: modelByIdResponse.status,
      detailHeader: modelByIdResponse.headers.get("x-parity-model-id") ?? "",
      detailBody: modelByIdBody,
    })

    await mkdir(outputDir, { recursive: true })
    await writeFile(
      outputPath,
      toMarkdown({
        oauth: oauthCheck,
        apiKey: apikeyCheck,
        modelsPassthrough,
        oauthCaptured,
        apiKeyCaptured: {
          responses: apikeyResponsesCaptured,
          compact: apikeyCompactCaptured,
          models: apikeyModelsCaptured,
          modelById: apikeyModelByIdCaptured,
        },
      }),
      "utf8",
    )

    if (!oauthCheck.matched || !apikeyCheck.matched || !modelsPassthrough.matched) {
      throw new Error(
        `Parity checks failed: oauth=${oauthCheck.matched} apikey=${apikeyCheck.matched} models_passthrough=${modelsPassthrough.matched}`,
      )
    }

    console.log(`Auth-mode parity report: ${outputPath}`)
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(300)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error("Auth-mode parity audit failed:", error)
  process.exit(1)
})
