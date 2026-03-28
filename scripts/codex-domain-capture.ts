import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type CapturedFetch = {
  at: number
  method: string
  url: string
  host: string
  pathname: string
  status?: number
  error?: string
}

type LoginStartResponse = {
  session?: { id?: string }
}

type SyncResponse = {
  virtualKey?: { key?: string }
}

type AddApiKeyAccountResponse = {
  account?: { id?: string }
}

type IssueVirtualKeyResponse = {
  key?: string
}

function isLocalHost(host: string) {
  const normalized = host.toLowerCase().trim()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

function toJsonString(value: unknown) {
  return JSON.stringify(value, null, 2)
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

async function tryRequest(label: string, fn: () => Promise<unknown>, events: Array<{ label: string; error: string }>) {
  try {
    await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    events.push({ label, error: message })
  }
}

function extractHostsFromContent(content: string) {
  const matches = content.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?(?:\/[^\s"'`)]*)?/g)
  const hosts = new Set<string>()
  for (const match of matches) {
    const host = String(match[1] ?? "").toLowerCase().trim()
    if (!host) continue
    hosts.add(host)
  }
  return hosts
}

async function collectOfficialHostsFromSource(codexRoot: string) {
  const files = [
    path.join(codexRoot, "codex-rs/core/src/model_provider_info.rs"),
    path.join(codexRoot, "codex-rs/core/src/auth.rs"),
    path.join(codexRoot, "codex-rs/login/src/server.rs"),
    path.join(codexRoot, "codex-rs/tui_app_server/src/lib.rs"),
    path.join(codexRoot, "codex-rs/tui_app_server/src/chatwidget.rs"),
    path.join(codexRoot, "codex-rs/tui_app_server/src/updates.rs"),
    path.join(codexRoot, "codex-rs/tui_app_server/src/tooltips.rs"),
  ]

  const hosts = new Set<string>()
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8")
      for (const host of extractHostsFromContent(content)) {
        hosts.add(host)
      }
    } catch {
      // ignore missing file
    }
  }
  return hosts
}

function normalizeOfficialOpenAIDomains(hosts: Set<string>) {
  const allowedSuffixes = [
    "openai.com",
    "chatgpt.com",
    "github.com",
    "githubusercontent.com",
    "formulae.brew.sh",
  ]
  return [...hosts]
    .filter((host) => allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))
    .sort()
}

function toMarkdownReport(input: {
  captured: CapturedFetch[]
  capturedHosts: string[]
  officialHosts: string[]
  onlyInCurrent: string[]
  onlyInOfficial: string[]
  errors: Array<{ label: string; error: string }>
}) {
  const lines: string[] = []
  lines.push("# Codex 域名抓包差异报告")
  lines.push("")
  lines.push(`生成时间: ${new Date().toISOString()}`)
  lines.push("")
  lines.push("## 1) 当前软件抓包到的外连域名")
  if (input.capturedHosts.length === 0) {
    lines.push("- (无)")
  } else {
    for (const host of input.capturedHosts) {
      lines.push(`- ${host}`)
    }
  }
  lines.push("")
  lines.push("## 2) codex-official 源码提取的官方域名")
  if (input.officialHosts.length === 0) {
    lines.push("- (无)")
  } else {
    for (const host of input.officialHosts) {
      lines.push(`- ${host}`)
    }
  }
  lines.push("")
  lines.push("## 3) 差异")
  lines.push("- 当前软件独有域名:")
  if (input.onlyInCurrent.length === 0) {
    lines.push("  - 无")
  } else {
    for (const host of input.onlyInCurrent) lines.push(`  - ${host}`)
  }
  lines.push("- 官方有但当前未触发域名:")
  if (input.onlyInOfficial.length === 0) {
    lines.push("  - 无")
  } else {
    for (const host of input.onlyInOfficial) lines.push(`  - ${host}`)
  }
  lines.push("")
  lines.push("## 4) 抓包明细（应用层 fetch）")
  if (input.captured.length === 0) {
    lines.push("- (无)")
  } else {
    for (const item of input.captured) {
      lines.push(
        `- [${new Date(item.at).toISOString()}] ${item.method} ${item.url} -> ${
          item.error ? `ERROR ${item.error}` : `HTTP ${item.status ?? "?"}`
        }`,
      )
    }
  }
  lines.push("")
  lines.push("## 5) 触发错误（预期内，使用了假 token）")
  if (input.errors.length === 0) {
    lines.push("- (无)")
  } else {
    for (const error of input.errors) {
      lines.push(`- ${error.label}: ${error.error}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-domain-capture-"))
  const port = 4821
  const origin = `http://127.0.0.1:${port}`
  const scriptDir = import.meta.dir
  const repoRoot = path.resolve(scriptDir, "..")
  const codexRoot = path.resolve(repoRoot, "..", "codex-official")
  const outputDir = path.join(repoRoot, "_tmp", "parity")
  const outputJson = path.join(outputDir, "codex-domain-capture.json")
  const outputMd = path.join(outputDir, "codex-domain-capture.md")

  process.env.OAUTH_APP_HOST = "127.0.0.1"
  process.env.OAUTH_APP_PORT = String(port)
  process.env.OAUTH_APP_DATA_DIR = tempDataDir
  process.env.OAUTH_BEHAVIOR_ENABLED = "false"
  process.env.OAUTH_CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"

  const captured: CapturedFetch[] = []
  const requestErrors: Array<{ label: string; error: string }> = []
  const originalFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    let host = ""
    let pathname = ""
    try {
      const parsed = new URL(target)
      host = parsed.hostname.toLowerCase()
      pathname = parsed.pathname
    } catch {
      // non-url target
    }

    const item: CapturedFetch = {
      at: Date.now(),
      method,
      url: target,
      host,
      pathname,
    }
    if (host && !isLocalHost(host)) {
      captured.push(item)
    }

    try {
      const response = await originalFetch(input, init)
      item.status = response.status
      return response
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  try {
    await import("../src/index.ts")
    await waitForHealth(origin, 20_000)

    const sync = await requestJSON<SyncResponse>(`${origin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Domain Audit OAuth",
        email: "domain-audit@example.com",
        accountId: "org-domain-audit",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3_600_000,
        issueVirtualKey: true,
        keyName: "Domain Audit Key",
      }),
    })

    const virtualKey = String(sync.virtualKey?.key ?? "").trim()
    const apiAccount = await requestJSON<AddApiKeyAccountResponse>(`${origin}/api/accounts/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai",
        providerName: "OpenAI",
        methodId: "api-key",
        displayName: "Domain Audit API Key",
        apiKey: "fake-openai-api-key",
      }),
    })
    const apiAccountId = String(apiAccount.account?.id ?? "").trim()
    let apiVirtualKey = ""
    if (apiAccountId) {
      const issued = await requestJSON<IssueVirtualKeyResponse>(`${origin}/api/virtual-keys/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "openai",
          routingMode: "single",
          accountId: apiAccountId,
          name: "Domain Audit OpenAI Key",
        }),
      })
      apiVirtualKey = String(issued.key ?? "").trim()
    }

    await tryRequest(
      "responses",
      async () => {
        await fetch(`${origin}/v1/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${virtualKey}`,
            "openai-beta": "responses=v1",
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            instructions: "domain-audit",
            input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
            stream: false,
          }),
        })
      },
      requestErrors,
    )

    await tryRequest(
      "models",
      async () => {
        await fetch(`${origin}/v1/models`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${virtualKey}`,
          },
        })
      },
      requestErrors,
    )

    await tryRequest(
      "responses-apikey",
      async () => {
        if (!apiVirtualKey) throw new Error("api virtual key missing")
        await fetch(`${origin}/v1/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiVirtualKey}`,
            "openai-beta": "responses=v1",
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            instructions: "domain-audit-apikey",
            input: [{ role: "user", content: [{ type: "input_text", text: "ping-apikey" }] }],
            stream: false,
          }),
        })
      },
      requestErrors,
    )

    await tryRequest(
      "usage",
      async () => {
        await fetch(`${origin}/backend-api/wham/usage`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${virtualKey}`,
          },
        })
      },
      requestErrors,
    )

    await tryRequest(
      "oauth-headless-start",
      async () => {
        await requestJSON<LoginStartResponse>(`${origin}/api/login/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: "chatgpt",
            methodId: "headless",
            options: {},
          }),
        })
      },
      requestErrors,
    )

    await tryRequest(
      "oauth-manual-code-exchange",
      async () => {
        const start = await requestJSON<LoginStartResponse>(`${origin}/api/login/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: "chatgpt",
            methodId: "manual-code",
            options: {},
          }),
        })
        const sessionId = String(start.session?.id ?? "").trim()
        if (!sessionId) throw new Error("manual-code session id missing")
        await fetch(`${origin}/api/login/sessions/${encodeURIComponent(sessionId)}/code`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "dummy-code" }),
        })
      },
      requestErrors,
    )

    await Bun.sleep(600)

    const capturedHosts = [...new Set(captured.map((item) => item.host).filter(Boolean))].sort()
    const officialHostsRaw = await collectOfficialHostsFromSource(codexRoot)
    const officialHosts = normalizeOfficialOpenAIDomains(officialHostsRaw)
    const onlyInCurrent = capturedHosts.filter((host) => !officialHosts.includes(host))
    const onlyInOfficial = officialHosts.filter((host) => !capturedHosts.includes(host))

    await mkdir(outputDir, { recursive: true })
    await writeFile(
      outputJson,
      toJsonString({
        captured,
        capturedHosts,
        officialHosts,
        onlyInCurrent,
        onlyInOfficial,
        errors: requestErrors,
      }),
      "utf8",
    )

    await writeFile(
      outputMd,
      toMarkdownReport({
        captured,
        capturedHosts,
        officialHosts,
        onlyInCurrent,
        onlyInOfficial,
        errors: requestErrors,
      }),
      "utf8",
    )

    console.log(`Domain capture completed: ${outputMd}`)
    console.log(`Domain capture JSON: ${outputJson}`)
    process.exit(0)
  } finally {
    await rm(tempDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error("Domain capture failed:", error)
  process.exit(1)
})
