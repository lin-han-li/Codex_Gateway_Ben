import type { Hono } from "hono"
import os from "node:os"
import path from "node:path"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { restartOfficialCodexApp } from "../codex-local-auth"
import { loadCodexInstructionsText } from "../codex-version"

const CODEX_GATEWAY_BASE_INSTRUCTIONS =
  (await loadCodexInstructionsText().catch(() => ({ content: "You are Codex, a coding agent based on GPT-5." }))).content ||
  "You are Codex, a coding agent based on GPT-5."

const CODEX_GATEWAY_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
]

function buildCodexGatewayModelInfo(
  id: string,
  displayName: string,
  priority: number,
  defaultReasoningLevel: string,
  additionalSpeedTiers: string[] = [],
  overrides: Record<string, unknown> = {},
) {
  const model = {
    slug: id,
    id,
    object: "model",
    created: 0,
    owned_by: "openai",
    display_name: displayName,
    displayName,
    description: `${displayName} via Codex Gateway`,
    default_reasoning_level: defaultReasoningLevel,
    defaultReasoningEffort: defaultReasoningLevel,
    supported_reasoning_levels: CODEX_GATEWAY_REASONING_LEVELS,
    supportedReasoningEfforts: CODEX_GATEWAY_REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    hidden: false,
    supported_in_api: true,
    priority,
    additional_speed_tiers: additionalSpeedTiers,
    additionalSpeedTiers,
    availability_nux: null,
    availabilityNux: null,
    upgrade: null,
    upgradeInfo: null,
    base_instructions: CODEX_GATEWAY_BASE_INSTRUCTIONS,
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    reasoning_summary_format: "experimental",
    minimal_client_version: "0.98.0",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    auto_compact_token_limit: null,
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: id === "gpt-5.4" ? 1000000 : 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    inputModalities: ["text", "image"],
    supports_search_tool: true,
    supportsPersonality: true,
    isDefault: id === "gpt-5.5",
    ...overrides,
  }
  const defaultEffort = String(model.default_reasoning_level || defaultReasoningLevel)
  return {
    ...model,
    defaultReasoningEffort: defaultEffort,
    hidden: String(model.visibility || "list").toLowerCase() === "hide",
    additionalSpeedTiers: Array.isArray(model.additional_speed_tiers) ? model.additional_speed_tiers : additionalSpeedTiers,
    inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities : ["text", "image"],
  }
}

const CODEX_GATEWAY_ALL_PLANS = [
  "business",
  "edu",
  "education",
  "enterprise",
  "enterprise_cbp_usage_based",
  "finserv",
  "free",
  "free_workspace",
  "go",
  "hc",
  "k12",
  "plus",
  "pro",
  "prolite",
  "quorum",
  "self_serve_business_usage_based",
  "team",
]

const CODEX_GATEWAY_PAID_PLANS = CODEX_GATEWAY_ALL_PLANS.filter((plan) => plan !== "free" && plan !== "free_workspace" && plan !== "k12")

const CODEX_GATEWAY_MODEL_CATALOG: Record<string, Record<string, unknown>> = {
  "gpt-5.5": buildCodexGatewayModelInfo("gpt-5.5", "GPT-5.5", 0, "medium", ["fast"], {
    description: "Frontier model for complex coding, research, and real-world work.",
    minimal_client_version: "0.124.0",
    available_in_plans: CODEX_GATEWAY_ALL_PLANS,
  }),
  "gpt-5.4": buildCodexGatewayModelInfo("gpt-5.4", "gpt-5.4", 2, "xhigh", ["fast"], {
    description: "Strong model for everyday coding.",
    max_context_window: 1000000,
    available_in_plans: CODEX_GATEWAY_PAID_PLANS,
  }),
  "gpt-5.4-mini": buildCodexGatewayModelInfo("gpt-5.4-mini", "GPT-5.4-Mini", 4, "medium", [], {
    description: "Small, fast, and cost-efficient model for simpler coding tasks.",
    default_verbosity: "medium",
    available_in_plans: CODEX_GATEWAY_ALL_PLANS,
  }),
  "gpt-5.3-codex": buildCodexGatewayModelInfo("gpt-5.3-codex", "gpt-5.3-codex", 6, "medium", [], {
    description: "Coding-optimized model.",
    web_search_tool_type: "text",
    available_in_plans: CODEX_GATEWAY_PAID_PLANS,
    upgrade: {
      model: "gpt-5.4",
      migration_markdown:
        "Introducing GPT-5.4\n\nCodex just got an upgrade with GPT-5.4, our most capable model for professional work. It outperforms prior models while being more token efficient, with notable improvements on long-running tasks, tool calling, computer use, and frontend development.\n\nLearn more: https://openai.com/index/introducing-gpt-5-4\n\nYou can always keep using GPT-5.3-Codex if you prefer.\n",
    },
  }),
  "gpt-5.2": buildCodexGatewayModelInfo("gpt-5.2", "gpt-5.2", 10, "medium", [], {
    description: "Optimized for professional work and long-running agents.",
    minimal_client_version: "0.0.1",
    default_reasoning_summary: "auto",
    reasoning_summary_format: "none",
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10000 },
    supports_image_detail_original: false,
    available_in_plans: CODEX_GATEWAY_ALL_PLANS,
    upgrade: {
      model: "gpt-5.4",
      migration_markdown:
        "Introducing GPT-5.4\n\nCodex just got an upgrade with GPT-5.4, our most capable model for professional work. It outperforms prior models while being more token efficient, with notable improvements on long-running tasks, tool calling, computer use, and frontend development.\n\nLearn more: https://openai.com/index/introducing-gpt-5-4\n\nYou can always keep using GPT-5.3-Codex if you prefer.\n",
    },
  }),
  "codex-auto-review": buildCodexGatewayModelInfo("codex-auto-review", "Codex Auto Review", 29, "medium", [], {
    description: "Automatic approval review model for Codex.",
    visibility: "hide",
    max_context_window: 1000000,
    available_in_plans: CODEX_GATEWAY_PAID_PLANS,
  }),
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_")
}

function toTomlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function normalizeNonEmpty(value: unknown) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : ""
}

function normalizeEpochMs(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const numeric = typeof value === "number" ? value : Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function resolveCodexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex")
}

async function readTextIfExists(filePath: string) {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return ""
  }
}

async function backupFileIfExists(filePath: string, stamp: string) {
  try {
    await readFile(filePath)
  } catch {
    return null
  }
  const parsed = path.parse(filePath)
  const backupPath = path.join(parsed.dir, `${parsed.name}.backup.${stamp}${parsed.ext}`)
  await copyFile(filePath, backupPath)
  return backupPath
}

async function readCurrentCodexAuthBinding(authPath: string) {
  let raw = ""
  try {
    raw = await readFile(authPath, "utf8")
  } catch {
    throw new Error("Codex is not logged in. Please click an account Codex login button first, then run direct configuration.")
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Codex auth.json is not valid JSON. Please re-login Codex first.")
  }
  if (parsed?.auth_mode !== "chatgpt") {
    throw new Error("Codex direct configuration requires ChatGPT/OAuth login mode. Please login with an account Codex button first.")
  }
  const tokens = parsed?.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {}
  const accessToken = normalizeNonEmpty(tokens.access_token)
  if (!accessToken) {
    throw new Error("Codex auth.json is missing access_token. Please re-login Codex first.")
  }
  return {
    accessToken,
    idToken: normalizeNonEmpty(tokens.id_token),
    accountId: normalizeNonEmpty(tokens.account_id),
  }
}

function withoutGatewayManagedConfigLines(raw: string) {
  return raw
    .replace(/^\s*openai_base_url\s*=.*(?:\r?\n)?/gm, "")
    .replace(/^\s*model_catalog_json\s*=.*(?:\r?\n)?/gm, "")
    .replace(/^\s*cli_auth_credentials_store\s*=.*(?:\r?\n)?/gm, "")
    .trimStart()
}

function ensureFastModeFeature(raw: string) {
  const lines = raw.split(/\r?\n/)
  let featuresIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line))
  if (featuresIndex < 0) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim()) lines.push("")
    lines.push("[features]", "fast_mode = true")
    return `${lines.join("\n").trimStart()}\n`
  }

  let nextSection = lines.length
  for (let index = featuresIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      nextSection = index
      break
    }
  }
  const fastIndex = lines.findIndex(
    (line, index) => index > featuresIndex && index < nextSection && /^\s*fast_mode\s*=/.test(line),
  )
  if (fastIndex >= 0) {
    lines[fastIndex] = "fast_mode = true"
  } else {
    lines.splice(featuresIndex + 1, 0, "fast_mode = true")
  }
  return `${lines.join("\n").trimStart()}\n`
}

function buildCodexGatewayModelCatalog(row: { fixedModel?: unknown; fixed_model?: unknown }) {
  const fixedModel = String(row.fixedModel ?? row.fixed_model ?? "").trim()
  if (fixedModel) {
    const known = CODEX_GATEWAY_MODEL_CATALOG[fixedModel]
    return {
      models: [known ?? buildCodexGatewayModelInfo(fixedModel, fixedModel, 0, "medium", [])],
    }
  }
  return { models: Object.values(CODEX_GATEWAY_MODEL_CATALOG) }
}

async function writeCodexGatewayConfigForVirtualKey(input: {
  row: Record<string, unknown>
  apiBase: string
  restartCodexApp?: boolean
}) {
  const codexHome = resolveCodexHome()
  await mkdir(codexHome, { recursive: true })

  const stamp = `${timestampForFilename()}.${process.pid}`
  const configPath = path.join(codexHome, "config.toml")
  const authPath = path.join(codexHome, "auth.json")
  const modelCatalogPath = path.join(codexHome, "codex-gateway-models.json")
  const [configBackupPath, modelCatalogBackupPath] = await Promise.all([
    backupFileIfExists(configPath, stamp),
    backupFileIfExists(modelCatalogPath, stamp),
  ])

  const modelCatalog = buildCodexGatewayModelCatalog(input.row)
  const modelCatalogJson = `${JSON.stringify(modelCatalog, null, 2)}\n`
  await writeFile(modelCatalogPath, modelCatalogJson, "utf8")

  const existingConfig = withoutGatewayManagedConfigLines(await readTextIfExists(configPath))
  const configHeader = [
    'cli_auth_credentials_store = "file"',
    `openai_base_url = ${toTomlString(input.apiBase)}`,
    `model_catalog_json = ${toTomlString(modelCatalogPath)}`,
  ].join("\n")
  const nextConfig = ensureFastModeFeature(existingConfig ? `${configHeader}\n${existingConfig}` : `${configHeader}\n`)
  await writeFile(configPath, nextConfig, "utf8")

  const appRestart = input.restartCodexApp === false ? null : restartOfficialCodexApp()
  return {
    codexHome,
    configPath,
    authPath,
    modelCatalogPath,
    backups: {
      configPath: configBackupPath,
      authPath: null,
      modelCatalogPath: modelCatalogBackupPath,
    },
    appRestart,
    authPreserved: true,
  }
}

export type VirtualKeysRouteDeps = {
  accountStore: any
  IssueVirtualKeySchema: { parse: (raw: unknown) => any }
  RenameVirtualKeySchema: { parse: (raw: unknown) => any }
  RenewVirtualKeySchema: { parse: (raw: unknown) => any }
  getCachedPoolConsistencyResult: (providerId: string, now?: number, options?: { preferredPlanCohort?: "free" | "paid" | "business" | "unknown" | null }) => any
  hasSensitiveActionConfirmation: (c: any) => boolean
  errorMessage: (error: unknown) => string
  setCodexOAuthBridgeBinding?: (input: {
    virtualKeyId: string
    accessToken?: string | null
    idToken?: string | null
    accountId?: string | null
    email?: string | null
  }) => Promise<{ keys: string[]; updatedAt: number }>
}

export function registerVirtualKeysRoutes(app: Hono, deps: VirtualKeysRouteDeps) {
  app.get("/api/virtual-keys", (c) => {
    const accountId = c.req.query("accountId")
    const keys: any[] = deps.accountStore.listVirtualApiKeys(accountId)
    const accounts: any[] = deps.accountStore.list()
    const accountMap = new Map<string, any>(accounts.map((item: any) => [item.id, item]))
    const rows = keys.map((item: any) => {
      const account = item.accountId ? accountMap.get(item.accountId) : undefined
      return {
        ...item,
        account: account
          ? {
              id: account.id,
              providerId: account.providerId,
              providerName: account.providerName,
              displayName: account.displayName,
              email: account.email,
              accountId: account.accountId,
            }
          : null,
      }
    })
    return c.json({ keys: rows })
  })

  app.post("/api/virtual-keys/issue", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.IssueVirtualKeySchema.parse(raw)
      const normalizedClientMode = input.clientMode === "cursor" ? "cursor" : "codex"
      const normalizedWireApi =
        input.wireApi ??
        (normalizedClientMode === "cursor" ? "chat_completions" : "responses")
      const isValidCombo =
        (normalizedClientMode === "codex" && normalizedWireApi === "responses") ||
        (normalizedClientMode === "cursor" && normalizedWireApi === "chat_completions")
      if (!isValidCombo) {
        return c.json(
          {
            error:
              "Invalid virtual key mode. Codex keys must use responses, and Cursor keys must use chat_completions.",
          },
          400,
        )
      }
      if (input.routingMode === "pool") {
        const preferredPlanCohort =
          input.accountScope === "free" ? "free" : input.accountScope === "member" ? "paid" : null
        const cachedPoolConsistency = deps.getCachedPoolConsistencyResult(input.providerId, Date.now(), {
          preferredPlanCohort,
        })
        if (cachedPoolConsistency && !cachedPoolConsistency.ok) {
          return c.json(
            {
              error: cachedPoolConsistency.message,
              code: cachedPoolConsistency.code,
              details: cachedPoolConsistency.details,
            },
            409,
          )
        }
      }
      const result = deps.accountStore.createVirtualApiKey({
        accountId: input.accountId,
        providerId: input.providerId,
        routingMode: input.routingMode,
        accountScope: input.accountScope,
        clientMode: normalizedClientMode,
        wireApi: normalizedWireApi,
        name: input.name,
        fixedModel: input.fixedModel,
        fixedReasoningEffort: input.fixedReasoningEffort,
        validityDays: input.validityDays,
      })
      return c.json({
        key: result.key,
        record: result.record,
      })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/name", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.RenameVirtualKeySchema.parse(raw)
      const record = deps.accountStore.renameVirtualApiKey(c.req.param("id"), input.name)
      return c.json({ success: true, record })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/renew", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.RenewVirtualKeySchema.parse(raw)
      const record = deps.accountStore.renewVirtualApiKey(c.req.param("id"), input.validityDays)
      return c.json({ success: true, record })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/revoke", (c) => {
    try {
      deps.accountStore.revokeVirtualApiKey(c.req.param("id"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/restore", (c) => {
    try {
      deps.accountStore.restoreVirtualApiKey(c.req.param("id"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/reveal", (c) => {
    if (!deps.hasSensitiveActionConfirmation(c)) {
      return c.json({ error: "Sensitive action confirmation required" }, 400)
    }
    try {
      const id = c.req.param("id")
      const key = deps.accountStore.revealVirtualApiKey(id)
      if (!key) return c.json({ error: "Virtual API key not found" }, 404)
      if (String(key).startsWith("encv1:")) {
        return c.json({ error: "Virtual API key cannot be decrypted. Please renew or issue a new key." }, 409)
      }
      return c.json({ key })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.post("/api/virtual-keys/:id/configure-codex", async (c) => {
    try {
      const id = c.req.param("id")
      const row = deps.accountStore.getVirtualApiKeyByID(id)
      if (!row) return c.json({ error: "Virtual API key not found" }, 404)
      if (row.isRevoked) return c.json({ error: "Virtual API key is revoked" }, 409)
      const expiresAt = normalizeEpochMs(row.expiresAt)
      if (expiresAt && expiresAt <= Date.now()) {
        return c.json({ error: "Virtual API key is expired" }, 409)
      }
      if (row.clientMode === "cursor" || row.wireApi === "chat_completions") {
        return c.json({ error: "Cursor keys cannot be configured for Codex App/CLI. Please use a Codex key." }, 400)
      }

      const rawBody = await c.req.json().catch(() => ({}))
      const restartCodexApp = rawBody?.restartCodexApp !== false
      const requestOrigin = new URL(c.req.url).origin
      const configuredBase = String(rawBody?.apiBase ?? `${requestOrigin}/v1`).trim()
      const apiBase = configuredBase.endsWith("/") ? configuredBase.slice(0, -1) : configuredBase
      const codexHome = resolveCodexHome()
      const authPath = path.join(codexHome, "auth.json")
      const currentAuth = await readCurrentCodexAuthBinding(authPath)
      const binding = deps.setCodexOAuthBridgeBinding
        ? await deps.setCodexOAuthBridgeBinding({
            virtualKeyId: String(row.id ?? id),
            ...currentAuth,
          })
        : null
      const result = await writeCodexGatewayConfigForVirtualKey({
        row,
        apiBase,
        restartCodexApp,
      })
      return c.json({ success: true, ...result, bridgeBinding: binding })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.delete("/api/virtual-keys/:id", (c) => {
    try {
      deps.accountStore.deleteVirtualApiKey(c.req.param("id"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })
}
