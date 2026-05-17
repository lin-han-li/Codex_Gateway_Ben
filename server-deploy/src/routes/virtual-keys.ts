import type { Hono } from "hono"
import os from "node:os"
import path from "node:path"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { launchOfficialCodexApp, shutdownOfficialCodexApp } from "../codex-local-auth"
import {
  CODEX_HTTP_PROVIDER_ID,
  LEGACY_CODEX_THREAD_PROVIDER_IDS,
  migrateCodexThreadProvidersForHttpCompat,
} from "../codex-thread-provider-compat"

function timestampForFilename() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_")
}

function toTomlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

const CODEX_GATEWAY_HTTP_PROVIDER_ID = CODEX_HTTP_PROVIDER_ID
const CODEX_MANAGED_PROVIDER_IDS = [CODEX_GATEWAY_HTTP_PROVIDER_ID, ...LEGACY_CODEX_THREAD_PROVIDER_IDS]

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

async function backupAndRemoveFileIfExists(filePath: string, stamp: string) {
  const backupPath = await backupFileIfExists(filePath, stamp)
  if (!backupPath) return null
  await rm(filePath, { force: true })
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

function normalizeTomlSectionName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/["']/g, "")
}

function splitRootAndSections(raw: string) {
  const lines = raw.split(/\r?\n/)
  const root: string[] = []
  const sections: string[] = []
  let section = ""
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (sectionMatch) section = normalizeTomlSectionName(sectionMatch[1] ?? "")
    if (section) sections.push(line)
    else root.push(line)
  }
  return {
    root: root.join("\n").trim(),
    sections: sections.join("\n").trim(),
  }
}

function withoutGatewayManagedConfigLines(raw: string) {
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  const recoveredRoot: string[] = []
  let section = ""
  let skipGatewayProviderBlock = false
  const managedProviderSections = new Set(CODEX_MANAGED_PROVIDER_IDS.map((id) => `model_providers.${id}`))

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (sectionMatch) {
      section = normalizeTomlSectionName(sectionMatch[1] ?? "")
      skipGatewayProviderBlock = managedProviderSections.has(section)
      if (skipGatewayProviderBlock) continue
      kept.push(line)
      continue
    }
    if (skipGatewayProviderBlock) {
      if (/^\s*(?:model|model_reasoning_effort|model_reasoning_summary|model_verbosity|personality)\s*=/.test(line)) {
        recoveredRoot.push(line)
      }
      continue
    }
    if (
      !section &&
      /^\s*(?:openai_base_url|model_catalog_json|model_provider|cli_auth_credentials_store|approval_policy|sandbox_mode)\s*=/.test(
        line,
      )
    ) {
      continue
    }
    kept.push(line)
  }

  return [...recoveredRoot, ...kept].join("\n").trimStart()
}

function composeCodexGatewayConfig(input: {
  header: string
  preserved: string
  providerBlock: string
}) {
  const { root, sections } = splitRootAndSections(input.preserved)
  return [
    input.header.trim(),
    root,
    "",
    input.providerBlock.trim(),
    sections ? `\n${sections}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n")
    .trimStart()
}

function setWindowsSandboxMode(raw: string, mode: "elevated" | "unelevated" | null) {
  const lines = raw.split(/\r?\n/)
  let section = ""
  let windowsSectionIndex = -1
  const kept: string[] = []
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (sectionMatch) {
      section = sectionMatch[1]?.trim().toLowerCase() ?? ""
      if (section === "windows") windowsSectionIndex = kept.length
      kept.push(line)
      continue
    }
    if (section === "windows" && /^\s*sandbox\s*=/.test(line)) continue
    kept.push(line)
  }
  if (mode) {
    if (windowsSectionIndex >= 0) {
      kept.splice(windowsSectionIndex + 1, 0, `sandbox = "${mode}"`)
    } else {
      if (kept.length > 0 && kept[kept.length - 1]?.trim()) kept.push("")
      kept.push("[windows]", `sandbox = "${mode}"`)
    }
  }
  return kept.join("\n").trimStart()
}

function preserveCodexState(statePath: string, kind: "thread" | "global") {
  return {
    updated: false,
    statePath,
    skipped:
      kind === "thread"
        ? "preserved existing Codex thread sandbox state"
        : "preserved existing Codex App global sandbox state",
  }
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

async function writeCodexGatewayConfigForVirtualKey(input: {
  row: Record<string, unknown>
  apiBase: string
  restartCodexApp?: boolean
  resolveCodexModelCatalogPayload?: (fixedModelId?: string | null) => Record<string, unknown>
}) {
  const codexHome = resolveCodexHome()
  await mkdir(codexHome, { recursive: true })

  const stamp = `${timestampForFilename()}.${process.pid}`
  const configPath = path.join(codexHome, "config.toml")
  const authPath = path.join(codexHome, "auth.json")
  const modelsCachePath = path.join(codexHome, "models_cache.json")
  const configBackupPath = await backupFileIfExists(configPath, stamp)

  const appShutdown = input.restartCodexApp === false ? null : shutdownOfficialCodexApp()
  if (appShutdown?.status === "failed") {
    throw new Error(appShutdown.message || "Failed to stop Official Codex App before applying key mode")
  }

  const existingConfig = setWindowsSandboxMode(withoutGatewayManagedConfigLines(await readTextIfExists(configPath)), "unelevated")
  const configHeader = [
    'cli_auth_credentials_store = "file"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    `model_provider = ${toTomlString(CODEX_GATEWAY_HTTP_PROVIDER_ID)}`,
  ].join("\n")
  const providerBlock = [
    `[model_providers.${CODEX_GATEWAY_HTTP_PROVIDER_ID}]`,
    'name = "Codex Gateway HTTP"',
    `base_url = ${toTomlString(input.apiBase)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
  ].join("\n")
  const mergedConfig = composeCodexGatewayConfig({
    header: configHeader,
    preserved: existingConfig,
    providerBlock,
  })
  const nextConfig = ensureFastModeFeature(mergedConfig)
  await writeFile(configPath, nextConfig, "utf8")
  const modelsCacheBackupPath = await backupAndRemoveFileIfExists(modelsCachePath, stamp)
  const threadProviderMigration = await migrateCodexThreadProvidersForHttpCompat({
    codexHome,
    stamp,
    targetProviderId: CODEX_GATEWAY_HTTP_PROVIDER_ID,
  })
  const threadSandboxReset = preserveCodexState(path.join(codexHome, "state_5.sqlite"), "thread")
  const globalAgentModeReset = preserveCodexState(path.join(codexHome, ".codex-global-state.json"), "global")

  const appLaunch = input.restartCodexApp === false ? null : launchOfficialCodexApp()
  const appRestart =
    input.restartCodexApp === false
      ? null
      : {
          status: appLaunch?.status === "failed" ? "failed" : "restarted",
          message: appLaunch?.message,
          appId: appLaunch?.appId ?? appShutdown?.appId ?? null,
          closed: Number(appShutdown?.closed ?? 0),
          forced: Number(appShutdown?.forced ?? 0),
          started: Boolean(appLaunch?.started),
          stderr: [appShutdown?.stderr, appLaunch?.stderr].filter(Boolean).join(" | ") || undefined,
        }
  return {
    codexHome,
    configPath,
    authPath,
    modelCatalogPath: null,
    modelsCachePath,
    backups: {
      configPath: configBackupPath,
      authPath: null,
      modelCatalogPath: null,
      modelsCachePath: modelsCacheBackupPath,
    },
    threadProviderMigration,
    threadSandboxReset,
    globalAgentModeReset,
    appRestart,
    authPreserved: true,
  }
}

export type VirtualKeysRouteDeps = {
  accountStore: any
  IssueVirtualKeySchema: { parse: (raw: unknown) => any }
  RenameVirtualKeySchema: { parse: (raw: unknown) => any }
  RenewVirtualKeySchema: { parse: (raw: unknown) => any }
  UpdateVirtualKeySchema: { parse: (raw: unknown) => any }
  getCachedPoolConsistencyResult: (providerId: string, now?: number, options?: { preferredPlanCohort?: "free" | "paid" | "business" | "unknown" | null }) => any
  hasSensitiveActionConfirmation: (c: any) => boolean
  errorMessage: (error: unknown) => string
  resolveCodexModelCatalogPayload?: (fixedModelId?: string | null) => Record<string, unknown>
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

  const updateVirtualKeySettings = async (c: any) => {
    try {
      const id = c.req.param("id")
      const current = deps.accountStore.getVirtualApiKeyByID(id)
      if (!current) return c.json({ error: "Virtual API key not found" }, 404)
      const raw = await c.req.json()
      const input = deps.UpdateVirtualKeySchema.parse(raw)
      const normalizedClientMode = input.clientMode ?? current.clientMode ?? "codex"
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
      const nextProviderId = input.providerId ?? current.providerId
      const nextRoutingMode = input.routingMode ?? current.routingMode
      const nextAccountScope = input.accountScope ?? current.accountScope
      if (nextRoutingMode === "pool") {
        const preferredPlanCohort =
          nextAccountScope === "free" ? "free" : nextAccountScope === "member" ? "paid" : null
        const cachedPoolConsistency = deps.getCachedPoolConsistencyResult(nextProviderId, Date.now(), {
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
      const record = deps.accountStore.updateVirtualApiKeySettings(id, {
        ...input,
        providerId: nextProviderId,
        routingMode: nextRoutingMode,
        accountScope: nextAccountScope,
        clientMode: normalizedClientMode,
        wireApi: normalizedWireApi,
      })
      return c.json({ success: true, record })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  }

  app.post("/api/virtual-keys/:id/settings", updateVirtualKeySettings)
  app.patch("/api/virtual-keys/:id", updateVirtualKeySettings)

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
        resolveCodexModelCatalogPayload: deps.resolveCodexModelCatalogPayload,
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
