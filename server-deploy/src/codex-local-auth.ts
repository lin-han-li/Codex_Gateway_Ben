import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import type { StoredAccount } from "./types"

export type CodexLocalAuthTokens = {
  accessToken: string
  refreshToken: string
  idToken: string
  accountId?: string | null
}

export type CodexAppRestartResult = {
  status: "skipped" | "restarted" | "failed"
  message?: string
  appId?: string | null
  closed?: number
  forced?: number
  started?: boolean
  stderr?: string
}

export type CodexAppControlResult = {
  status: "skipped" | "completed" | "failed"
  message?: string
  appId?: string | null
  closed?: number
  forced?: number
  started?: boolean
  remaining?: number
  stderr?: string
}

export type CodexLocalAuthWriteResult = {
  codexHome: string
  authPath: string
  authBackupPath: string | null
  configPath: string
  configBackupPath: string | null
  configUpdated: boolean
  appRestart: CodexAppRestartResult
}

function normalizeNonEmpty(value: unknown) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : ""
}

function assertJwtLike(value: string, label: string) {
  if (value.split(".").length !== 3) {
    throw new Error(`${label} must be a JWT with three dot-separated parts`)
  }
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_")
}

async function fileExists(filePath: string) {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}

async function backupFileIfExists(filePath: string, backupPath: string) {
  if (!(await fileExists(filePath))) return null
  await copyFile(filePath, backupPath)
  return backupPath
}

export function resolveCodexHome(explicitCodexHome?: string | null) {
  const explicit = normalizeNonEmpty(explicitCodexHome)
  if (explicit) return path.resolve(explicit)
  const envHome = normalizeNonEmpty(process.env.CODEX_HOME)
  if (envHome) return path.resolve(envHome)
  return path.join(os.homedir(), ".codex")
}

export function buildCodexChatGptAuthJson(input: {
  accessToken: string
  refreshToken: string
  idToken: string
  accountId?: string | null
}) {
  const accessToken = normalizeNonEmpty(input.accessToken)
  const refreshToken = normalizeNonEmpty(input.refreshToken)
  const idToken = normalizeNonEmpty(input.idToken)
  if (!accessToken) throw new Error("Codex local login requires an access token")
  if (!refreshToken) throw new Error("Codex local login requires a refresh token")
  if (!idToken) throw new Error("Codex local login requires an id token")
  assertJwtLike(idToken, "id_token")

  const tokens: Record<string, string> = {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
  }
  const accountId = normalizeNonEmpty(input.accountId)
  if (accountId) tokens.account_id = accountId

  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens,
    last_refresh: new Date().toISOString(),
  }
}

async function ensureCodexFileCredentialStore(codexHome: string) {
  const configPath = path.join(codexHome, "config.toml")
  const desiredLine = 'cli_auth_credentials_store = "file"'
  const stamp = timestampForFilename()
  const configBackupPath = path.join(codexHome, `config.backup.${stamp}.${process.pid}.toml`)
  let raw = ""
  let exists = false
  try {
    raw = await readFile(configPath, "utf8")
    exists = true
  } catch {
    exists = false
  }

  const originalRaw = raw
  raw = raw
    .replace(/^\s*openai_base_url\s*=.*(?:\r?\n)?/gm, "")
    .replace(/^\s*model_catalog_json\s*=.*(?:\r?\n)?/gm, "")
    .replace(/^\s*approval_policy\s*=.*(?:\r?\n)?/gm, "")
    .replace(/^\s*sandbox_mode\s*=.*(?:\r?\n)?/gm, "")

  const linePattern = /^\s*cli_auth_credentials_store\s*=\s*["']?(?:file|keyring|auto|ephemeral)["']?\s*$/m
  let next: string
  if (linePattern.test(raw)) {
    next = raw.replace(linePattern, desiredLine)
  } else {
    next = raw.trim().length > 0 ? `${desiredLine}\n${raw}` : `${desiredLine}\n`
  }

  if (next === originalRaw) {
    return { configPath, configBackupPath: null, configUpdated: false }
  }
  if (exists) await copyFile(configPath, configBackupPath)
  await writeFile(configPath, next, "utf8")
  return { configPath, configBackupPath: exists ? configBackupPath : null, configUpdated: true }
}

export async function writeCodexLocalAuth(input: {
  account: StoredAccount
  tokens: CodexLocalAuthTokens
  codexHome?: string | null
  restartCodexApp?: boolean
}) {
  const codexHome = resolveCodexHome(input.codexHome)
  await mkdir(codexHome, { recursive: true })

  const authPath = path.join(codexHome, "auth.json")
  const stamp = timestampForFilename()
  const authBackupPath = path.join(codexHome, `auth.backup.${stamp}.${process.pid}.json`)
  const tempPath = path.join(codexHome, `auth.json.tmp.${stamp}.${process.pid}`)
  const rollbackPath = path.join(codexHome, `auth.rollback.${stamp}.${process.pid}.json`)

  const configResult = await ensureCodexFileCredentialStore(codexHome)
  const backupPath = await backupFileIfExists(authPath, authBackupPath)
  const authJson = buildCodexChatGptAuthJson({
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
    idToken: input.tokens.idToken,
    accountId: input.tokens.accountId ?? input.account.accountId,
  })
  const serialized = `${JSON.stringify(authJson, null, 2)}\n`
  JSON.parse(serialized)

  try {
    await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" })
    JSON.parse(await readFile(tempPath, "utf8"))
    await rm(authPath, { force: true })
    await rename(tempPath, authPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (backupPath) {
      await copyFile(backupPath, authPath).catch(() => undefined)
    } else {
      await rm(authPath, { force: true }).catch(() => undefined)
    }
    await rm(rollbackPath, { force: true }).catch(() => undefined)
    throw error
  }

  const appRestart = input.restartCodexApp === false ? skippedRestart("restart disabled") : restartOfficialCodexApp()
  return {
    codexHome,
    authPath,
    authBackupPath: backupPath,
    configPath: configResult.configPath,
    configBackupPath: configResult.configBackupPath,
    configUpdated: configResult.configUpdated,
    appRestart,
  } satisfies CodexLocalAuthWriteResult
}

function skippedRestart(message: string): CodexAppRestartResult {
  return {
    status: "skipped",
    message,
    appId: null,
    closed: 0,
    forced: 0,
    started: false,
  }
}

function skippedControl(message: string): CodexAppControlResult {
  return {
    status: "skipped",
    message,
    appId: null,
    closed: 0,
    forced: 0,
    started: false,
    remaining: 0,
  }
}

function controlOfficialCodexApp(action: "stop" | "start" | "restart"): CodexAppControlResult {
  if (process.platform !== "win32") {
    return skippedControl("Codex App control is only implemented on Windows")
  }

  const script = `
$ErrorActionPreference = 'Stop'
$action = '${action}'
$result = [ordered]@{
  status = 'skipped'
  message = ''
  appId = $null
  closed = 0
  forced = 0
  started = $false
  remaining = 0
}
try {
  $pkg = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) {
    $result.appId = "$($pkg.PackageFamilyName)!App"
  } else {
    $startApp = Get-StartApps -Name 'Codex' -ErrorAction SilentlyContinue | Where-Object { $_.AppID -like 'OpenAI.Codex*' } | Select-Object -First 1
    if ($startApp) { $result.appId = $startApp.AppID }
  }

  function Get-CodexTargets {
    @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      ($_.ProcessName -in @('Codex', 'codex')) -and (
        ($_.Path -like '*WindowsApps*OpenAI.Codex*') -or
        ($_.MainWindowTitle -eq 'Codex')
      )
    })
  }

  if ($action -in @('stop', 'restart')) {
    $targets = @(Get-CodexTargets)
    foreach ($p in $targets) {
      try {
        if ($p.MainWindowHandle -ne 0 -and $p.CloseMainWindow()) { $result.closed += 1 }
      } catch {}
    }

    Start-Sleep -Milliseconds 800
    foreach ($p in $targets) {
      try { Wait-Process -Id $p.Id -Timeout 8 -ErrorAction SilentlyContinue } catch {}
    }

    $remaining = @(Get-CodexTargets)
    foreach ($p in $remaining) {
      try {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        $result.forced += 1
      } catch {}
    }

    Start-Sleep -Milliseconds 400
    $remaining = @(Get-CodexTargets)
    $result.remaining = $remaining.Count
    if ($result.remaining -gt 0) {
      $result.status = 'failed'
      $result.message = 'Official Codex background processes are still running'
      $result | ConvertTo-Json -Compress
      exit 1
    }
  }

  if ($action -in @('start', 'restart')) {
    if ($result.appId) {
      Start-Process explorer.exe "shell:AppsFolder\\$($result.appId)"
      $result.started = $true
      $result.status = 'completed'
      $result.message = 'Official Codex App started'
    } else {
      $result.status = 'failed'
      $result.message = 'Official Codex App was not found'
    }
  } else {
    $result.status = 'completed'
    $result.message = 'Official Codex App stopped'
  }
} catch {
  $result.status = 'failed'
  $result.message = $_.Exception.Message
}
$result | ConvertTo-Json -Compress
`

  const child = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  })
  const stdout = String(child.stdout || "").trim()
  const stderr = String(child.stderr || "").trim()
  if (child.error) {
    return {
      status: "failed",
      message: child.error.message,
      stderr,
    }
  }
  try {
    const parsed = JSON.parse(stdout || "{}") as CodexAppControlResult
    return {
      status: parsed.status === "completed" || parsed.status === "failed" ? parsed.status : "skipped",
      message: normalizeNonEmpty(parsed.message) || (child.status === 0 ? undefined : `PowerShell exited with ${child.status}`),
      appId: parsed.appId ?? null,
      closed: Number(parsed.closed ?? 0),
      forced: Number(parsed.forced ?? 0),
      started: Boolean(parsed.started),
      remaining: Number(parsed.remaining ?? 0),
      stderr: stderr || undefined,
    }
  } catch {
    return {
      status: "failed",
      message: stdout || `PowerShell exited with ${child.status}`,
      stderr,
    }
  }
}

export function shutdownOfficialCodexApp(): CodexAppControlResult {
  return controlOfficialCodexApp("stop")
}

export function launchOfficialCodexApp(): CodexAppControlResult {
  return controlOfficialCodexApp("start")
}

export function restartOfficialCodexApp(): CodexAppRestartResult {
  const result = controlOfficialCodexApp("restart")
  return {
    status: result.status === "completed" ? "restarted" : result.status,
    message: result.message,
    appId: result.appId ?? null,
    closed: Number(result.closed ?? 0),
    forced: Number(result.forced ?? 0),
    started: Boolean(result.started),
    stderr: result.stderr,
  }
}
