import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { Database } from "bun:sqlite"
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
    routingMode?: string | null
    accountScope?: string | null
    clientMode?: string | null
    wireApi?: string | null
    fixedModel?: string | null
    fixedReasoningEffort?: string | null
  } | null
}

type UpdateKeyResponse = {
  record?: IssueKeyResponse["record"]
}

type ChatModelsResponse = {
  models?: Array<Record<string, unknown>>
  data?: Array<Record<string, unknown>>
  defaultModelId?: string | null
}

type ConfigureCodexResponse = {
  success?: boolean
  modelCatalogPath?: string | null
  modelsCachePath?: string | null
  backups?: {
    modelsCachePath?: string | null
  }
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function buildFakeJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.sig`
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

async function main() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-key-issue-"))
  const codexHome = path.join(tempDataDir, ".codex-home")
  const bridgePort = await reserveFreePort()
  const upstreamPort = await reserveFreePort()
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const upstreamBase = `${upstreamOrigin}/v1`
  const capturedRequests: Array<{ path: string; token: string }> = []
  const fakeAccessToken = buildFakeJwt({
    sub: "user-key-issue-audit",
    email: "codex-audit@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "local-codex-account",
      account_id: "local-codex-account",
      chatgpt_user_id: "user-key-issue-audit",
      user_id: "user-key-issue-audit",
      organization_id: "local-codex-account",
    },
    "https://api.openai.com/profile": {
      email: "codex-audit@example.com",
    },
  })
  const fakeIdToken = buildFakeJwt({
    sub: "auth0|codex-audit",
    email: "codex-audit@example.com",
    "https://api.openai.com/profile": {
      email: "codex-audit@example.com",
    },
  })

  await mkdir(codexHome, { recursive: true })
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      'model = "gpt-5.4"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          access_token: fakeAccessToken,
          id_token: fakeIdToken,
          account_id: "local-codex-account",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await writeFile(
    path.join(codexHome, ".codex-global-state.json"),
    `${JSON.stringify({
      "electron-persisted-atom-state": {
        "agent-mode-by-host-id": { local: "full-access" },
        "preferred-non-full-access-agent-mode-by-host-id": { local: "guardian-approvals" },
        "skip-full-access-confirm": true,
      },
    })}
`,
    "utf8",
  )
  const modelsCachePath = path.join(codexHome, "models_cache.json")
  await writeFile(
    modelsCachePath,
    `${JSON.stringify(
      {
        fetched_at: new Date().toISOString(),
        etag: 'W/"stale-no-fast"',
        client_version: "0.128.0",
        models: [
          {
            slug: "gpt-5.4",
            display_name: "gpt-5.4",
            description: "stale cached model without fast",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "medium" }],
            shell_type: "shell_command",
            visibility: "list",
            supported_in_api: true,
            priority: 0,
            additional_speed_tiers: [],
            base_instructions: "cached",
            supports_reasoning_summaries: true,
            default_reasoning_summary: "none",
            support_verbosity: true,
            default_verbosity: "low",
            truncation_policy: { mode: "tokens", limit: 10000 },
            supports_parallel_tool_calls: true,
            context_window: 272000,
            max_context_window: 272000,
            effective_context_window_percent: 95,
            experimental_supported_tools: [],
            input_modalities: ["text"],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  const stateDbPath = path.join(codexHome, "state_5.sqlite")
  const stateDb = new Database(stateDbPath)
  stateDb.run("create table threads (id text primary key, cwd text not null, sandbox_policy text not null, approval_mode text not null)")
  stateDb.run("insert into threads (id, cwd, sandbox_policy, approval_mode) values (?, ?, ?, ?)", [
    "thread-key-mode-audit",
    process.cwd(),
    '{"type":"danger-full-access"}',
    "never",
  ])
  stateDb.close()

  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const url = new URL(request.url)
      const authToken = String(request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
      capturedRequests.push({
        path: url.pathname,
        token: authToken,
      })

      if (url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "gpt-5.4",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "openai",
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

      if (url.pathname === "/v1/responses") {
        return new Response(
          JSON.stringify({
            id: `resp_${crypto.randomUUID()}`,
            object: "response",
            output_text: "ok",
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
      OAUTH_OPENAI_API_BASE: upstreamBase,
      OAUTH_BEHAVIOR_ENABLED: "false",
      CODEX_HOME: codexHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const findings: string[] = []

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const accountA = await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Key Issue Audit A",
        email: "key-issue-a@example.com",
        accountId: "org-key-issue-a",
        accessToken: "key-issue-token-a",
        refreshToken: "key-issue-refresh-a",
        expiresAt: Date.now() + 3600_000,
        organizationId: "org-key-issue-a",
        issueVirtualKey: false,
      }),
    })
    await requestJSON<SyncResponse>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Key Issue Audit B",
        email: "key-issue-b@example.com",
        accountId: "org-key-issue-b",
        accessToken: "key-issue-token-b",
        refreshToken: "key-issue-refresh-b",
        expiresAt: Date.now() + 3600_000,
        organizationId: "org-key-issue-b",
        issueVirtualKey: false,
      }),
    })

    capturedRequests.length = 0

    const issued = await requestJSON<IssueKeyResponse>(`${bridgeOrigin}/api/virtual-keys/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        routingMode: "pool",
        name: "Key Issue Audit Pool Key",
      }),
    })

    assertCondition(issued.key?.startsWith("ocsk_live_"), "pool key issue failed")
    assertCondition(issued.record?.id, "pool key issue did not return record id")

    const chatModels = await requestJSON<ChatModelsResponse>(`${bridgeOrigin}/api/chat/models`)
    const chatModelsList = Array.isArray(chatModels.models) ? chatModels.models : Array.isArray(chatModels.data) ? chatModels.data : []
    const chatGpt55 = chatModelsList.find((item) => String(item?.id ?? item?.slug ?? "") === "gpt-5.5")
    assertCondition(chatGpt55, "chat models should expose gpt-5.5")
    assertCondition(
      typeof chatGpt55.base_instructions === "string" && String(chatGpt55.base_instructions).trim().length > 0,
      "chat models gpt-5.5 should expose official base_instructions",
    )
    assertCondition(
      String(chatGpt55.availability_nux?.message || "").includes("GPT-5.5 is now available in Codex"),
      "chat models gpt-5.5 should expose official availability_nux message",
    )

    const cursorUpdated = await requestJSON<UpdateKeyResponse>(
      `${bridgeOrigin}/api/virtual-keys/${encodeURIComponent(issued.record.id)}/settings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routingMode: "pool",
          accountScope: "all",
          clientMode: "cursor",
          wireApi: "chat_completions",
          fixedModel: "gpt-5.5",
          fixedReasoningEffort: "xhigh",
        }),
      },
    )
    assertCondition(cursorUpdated.record?.routingMode === "pool", "settings update should keep pool routing")
    assertCondition(cursorUpdated.record?.clientMode === "cursor", "settings update should switch key to cursor mode")
    assertCondition(cursorUpdated.record?.wireApi === "chat_completions", "settings update should switch wire API")
    assertCondition(cursorUpdated.record?.fixedModel === "gpt-5.5", "settings update should persist fixed model")
    assertCondition(cursorUpdated.record?.fixedReasoningEffort === "xhigh", "settings update should persist fixed reasoning")

    const singleUpdated = await requestJSON<UpdateKeyResponse>(
      `${bridgeOrigin}/api/virtual-keys/${encodeURIComponent(issued.record.id)}/settings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: accountA.account.id,
          routingMode: "single",
          accountScope: "all",
          clientMode: "codex",
          wireApi: "responses",
          fixedModel: null,
          fixedReasoningEffort: null,
        }),
      },
    )
    assertCondition(singleUpdated.record?.routingMode === "single", "settings update should switch key to single routing")
    assertCondition(singleUpdated.record?.accountId === accountA.account.id, "settings update should bind selected account")
    assertCondition(singleUpdated.record?.clientMode === "codex", "settings update should switch key back to codex mode")
    assertCondition(singleUpdated.record?.wireApi === "responses", "settings update should switch wire API back to responses")
    assertCondition(!singleUpdated.record?.fixedModel, "settings update should clear fixed model")

    const configured = await requestJSON<ConfigureCodexResponse>(
      `${bridgeOrigin}/api/virtual-keys/${encodeURIComponent(issued.record.id)}/configure-codex`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiBase: `${bridgeOrigin}/v1`,
          restartCodexApp: false,
        }),
      },
    )
    assertCondition(configured.success === true, "configure-codex should succeed")
    const configuredToml = await readFile(path.join(codexHome, "config.toml"), "utf8")
    assertCondition(
      configuredToml.includes('approval_policy = "on-request"'),
      "configure-codex should set approval_policy=on-request for direct key mode",
    )
    assertCondition(
      configuredToml.includes('sandbox_mode = "workspace-write"'),
      "configure-codex should set sandbox_mode=workspace-write for direct key mode",
    )
    assertCondition(
      !configuredToml.includes('sandbox = "elevated"'),
      "configure-codex should remove elevated Windows sandbox leftovers",
    )
    assertCondition(
      configuredToml.includes('[windows]') && configuredToml.includes('sandbox = "unelevated"'),
      "configure-codex should switch key mode to unelevated Windows sandbox",
    )
    assertCondition(
      !configuredToml.includes("model_catalog_json"),
      "configure-codex should rely on gateway /v1/models instead of injecting local model_catalog_json",
    )
    const configuredGlobalState = JSON.parse(await readFile(path.join(codexHome, ".codex-global-state.json"), "utf8"))
    const configuredAtomState = configuredGlobalState["electron-persisted-atom-state"] || {}
    assertCondition(
      configuredAtomState["agent-mode-by-host-id"]?.local === "full-access",
      "configure-codex should preserve existing Codex App local agent mode",
    )
    assertCondition(
      configuredAtomState["skip-full-access-confirm"] === true,
      "configure-codex should preserve existing global sandbox flags",
    )
    const configuredStateDb = new Database(stateDbPath, { readonly: true })
    const configuredThread = configuredStateDb
      .query("select sandbox_policy, approval_mode from threads where id = ?")
      .get("thread-key-mode-audit") as { sandbox_policy: string; approval_mode: string } | null
    configuredStateDb.close()
    assertCondition(
      configuredThread?.sandbox_policy === '{"type":"danger-full-access"}',
      "configure-codex should preserve existing thread sandbox policy",
    )
    assertCondition(
      configuredThread?.approval_mode === "never",
      "configure-codex should preserve existing thread approval mode",
    )
    assertCondition(
      !configured.modelCatalogPath,
      "configure-codex should not return a local model catalog path after switching to gateway /v1/models",
    )
    assertCondition(configured.modelsCachePath === modelsCachePath, "configure-codex should report the models cache path")
    assertCondition(
      !(await Bun.file(modelsCachePath).exists()),
      "configure-codex should clear stale Codex models_cache.json so fast-capable gateway models can be fetched",
    )
    assertCondition(
      configured.backups?.modelsCachePath && (await Bun.file(configured.backups.modelsCachePath).exists()),
      "configure-codex should backup stale models_cache.json before clearing it",
    )

    await Bun.sleep(250)

    const modelFetchCount = capturedRequests.filter((item) => item.path === "/v1/models").length
    if (modelFetchCount !== 0) {
      findings.push(`configure-codex should not force direct /v1/models probes during local key apply actual=${modelFetchCount}`)
    }
  } finally {
    await stopChildProcess(child)
    upstreamServer.stop(true)
    await rm(tempDataDir, { recursive: true, force: true })
  }

  const reportDir = path.join(process.cwd(), "_tmp", "parity")
  await mkdir(reportDir, { recursive: true })
  const reportLines = [
    "# Virtual Key Issue Audit",
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
    "virtual-key-issue-audit.md",
    `${reportLines.join("\n")}\n`,
  )

  if (findings.length > 0) {
    console.error(`virtual-key-issue-audit failed. Report: ${reportPath}`)
    process.exitCode = 1
    return
  }

  console.log(`virtual-key-issue-audit passed. Report: ${reportPath}`)
}

await main()
