const path = require("node:path")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")
const crypto = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")
const { TextDecoder } = require("node:util")
const { app, BrowserWindow, shell, dialog } = require("electron")

let serverProcess = null
let serverBaseUrl = null
let serverManagementToken = ""
let attachedServerProcessId = null
let isQuitting = false
let mainWindow = null
let serverLogTail = []
let serverRestartInProgress = false
let suppressExitNotification = false
const WINDOW_DEFAULT_WIDTH = 1200
const WINDOW_DEFAULT_HEIGHT = 820
const WINDOW_MIN_WIDTH = 1120
const WINDOW_MIN_HEIGHT = 720
const DEFAULT_PACKAGED_LOOPBACK_PORT = 65260
const REQUIRED_NO_PROXY_LOOPBACK_ENTRIES = ["localhost", "127.0.0.1"]
const UTF16LE_DECODER = new TextDecoder("utf-16le")
const GBK_DECODER = (() => {
  try {
    return new TextDecoder("gbk")
  } catch {
    return null
  }
})()

function resolveBootstrapLogPath() {
  return path.join(resolveDataDir(), "bootstrap.log")
}

function appendBootstrapLog(level, message) {
  try {
    const entry = JSON.stringify({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: Date.now(),
      level,
      source: "bootstrap",
      message,
    })
    fs.appendFileSync(resolveBootstrapLogPath(), `${entry}\n`, "utf8")
  } catch {}
}

function pushServerTail(message) {
  serverLogTail.push(message)
  if (serverLogTail.length > 12) {
    serverLogTail = serverLogTail.slice(-12)
  }
}

function getServerTailText() {
  return serverLogTail.filter(Boolean).slice(-6).join("\n")
}

function prepareBootstrapLog() {
  serverLogTail = []
  try {
    fs.mkdirSync(resolveDataDir(), { recursive: true })
    const logPath = resolveBootstrapLogPath()
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath)
      if (stat.size > 1024 * 1024) {
        const archived = `${logPath}.${Date.now()}`
        fs.renameSync(logPath, archived)
      }
    }
    fs.openSync(logPath, "a").close()
    appendBootstrapLog("info", "=== desktop bootstrap session started ===")
  } catch {}
}

function resolveServerOutputLevel(line, fallbackLevel) {
  if (fallbackLevel !== "error") return fallbackLevel
  if (/\[oauth-multi-login\]\s+pool consistency observe\b/i.test(line)) {
    return "info"
  }
  if (
    /\[oauth-multi-login\]\s+pool consistency constrained\b/i.test(line) &&
    /\bno routing exclusion applied\b/i.test(line)
  ) {
    return "info"
  }
  if (/\[oauth-multi-login\]\s+pool consistency warn\b/i.test(line)) {
    return "warn"
  }
  if (/\[oauth-multi-login\]\s+upstream retry\b/i.test(line)) {
    return "warn"
  }
  return fallbackLevel
}

function looksMisdecodedText(text) {
  const value = String(text ?? "")
  return (
    value.includes("\ufffd") ||
    /(?:锟斤拷|鏈|宸插|杩愯|绂荤|鍚屾|鍦板潃|鍒囨崲|澶嶅埗|涓嶅彲|鏌ョ湅|鏀惰捣)/.test(value)
  )
}

function decodeProcessText(value) {
  if (value == null) return ""
  if (typeof value === "string") return value.replace(/^\ufeff/, "")
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (!buffer.length) return ""
  const utf8Text = buffer.toString("utf8").replace(/^\ufeff/, "")
  if (!looksMisdecodedText(utf8Text)) return utf8Text
  for (const decoder of [GBK_DECODER, UTF16LE_DECODER]) {
    if (!decoder) continue
    const decoded = decoder.decode(buffer).replace(/^\ufeff/, "")
    if (!looksMisdecodedText(decoded)) return decoded
  }
  return utf8Text
}

function recordServerOutput(chunk, level) {
  const text = decodeProcessText(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const normalizedChunk = text.trim()
  const collapsePoolConsistencySoftSignal =
    level === "error" &&
    (/\[oauth-multi-login\]\s+pool consistency warn\b/i.test(normalizedChunk) ||
      (/\[oauth-multi-login\]\s+pool consistency constrained\b/i.test(normalizedChunk) &&
        /\bno routing exclusion applied\b/i.test(normalizedChunk)))
  const lines = collapsePoolConsistencySoftSignal
    ? [normalizedChunk.replace(/\s+/g, " ").trim()]
    : normalizedChunk
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)

  for (const line of lines) {
    pushServerTail(line)
    appendBootstrapLog(resolveServerOutputLevel(line, level), line)
  }
}

function buildDetailedError(message) {
  const tail = getServerTailText()
  const logPath = resolveBootstrapLogPath()
  if (!tail) {
    return `${message}\n\n日志文件: ${logPath}`
  }
  return `${message}\n\n最近输出:\n${tail}\n\n日志文件: ${logPath}`
}

function resolveServerBinaryName() {
  return process.platform === "win32" ? "oauth-server.exe" : "oauth-server"
}

function resolveServerExePath() {
  const binaryName = resolveServerBinaryName()
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "server", binaryName)
  }
  return path.join(__dirname, "..", "build", "server", binaryName)
}

function resolveWebDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web")
  }
  return path.join(__dirname, "..", "src", "web")
}

function resolveDesktopIconPath() {
  const iconDir = app.isPackaged ? path.join(process.resourcesPath, "icons") : path.join(__dirname, "..", "build", "icons")
  for (const candidate of ["512x512.png", "256x256.png", "128x128.png", "64x64.png", "32x32.png"]) {
    const absolutePath = path.join(iconDir, candidate)
    if (fs.existsSync(absolutePath)) {
      return absolutePath
    }
  }
  return null
}

function resolveDataDir() {
  return path.join(app.getPath("userData"), "data")
}

function resolveSettingsFilePath(dataDir) {
  return path.join(dataDir, "settings.json")
}

function resolveCompatibilityStatePath(dataDir) {
  return path.join(dataDir, "compatibility-state.json")
}

function parseSettingsJson(raw) {
  const text = String(raw ?? "").replace(/^\uFEFF/, "").trim()
  if (!text) return {}
  return JSON.parse(text)
}

function readSettingsObject(dataDir) {
  const settingsFile = resolveSettingsFilePath(dataDir)
  if (!fs.existsSync(settingsFile)) {
    return null
  }
  const content = fs.readFileSync(settingsFile, "utf8")
  return parseSettingsJson(content)
}

function readCompatibilityState(dataDir) {
  const filePath = resolveCompatibilityStatePath(dataDir)
  if (!fs.existsSync(filePath)) {
    return {}
  }
  const content = fs.readFileSync(filePath, "utf8")
  return parseSettingsJson(content)
}

function writeCompatibilityState(dataDir, nextState) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(resolveCompatibilityStatePath(dataDir), `${JSON.stringify(nextState, null, 2)}\n`, "utf8")
}

function persistResolvedLocalBinding(dataDir, host, port) {
  const normalizedHost = host === "localhost" ? "127.0.0.1" : host
  const nextAddress = `${formatLocalAddress(normalizedHost, port)}/`
  let settings = {}
  try {
    settings = readSettingsObject(dataDir) ?? {}
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    appendBootstrapLog("warn", `Skipped persisting local service address because settings.json could not be read: ${detail}`)
    return false
  }
  if (String(settings.localServiceAddress ?? "").trim() === nextAddress) {
    return false
  }
  settings.localServiceAddress = nextAddress
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(resolveSettingsFilePath(dataDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
  appendBootstrapLog("info", `Persisted local service address: ${nextAddress}`)
  return true
}

function quotePowerShellLiteral(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`
}

function writeDesktopServerLauncher({ exePath, dataDir, webDir, bindHost, port, serverBuildId }) {
  if (process.platform !== "win32" || !app.isPackaged) return
  try {
    const launcherPath = path.join(app.getPath("userData"), "run-oauth-server.ps1")
    const settingsPath = resolveSettingsFilePath(dataDir)
    const bootstrapLogPath = resolveBootstrapLogPath()
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$settingsPath = ${quotePowerShellLiteral(settingsPath)}`,
      "$settings = if (Test-Path -LiteralPath $settingsPath) { Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }",
      `$env:OAUTH_APP_HOST = ${quotePowerShellLiteral(bindHost)}`,
      `$env:OAUTH_APP_PORT = ${quotePowerShellLiteral(String(port))}`,
      `$env:OAUTH_APP_DATA_DIR = ${quotePowerShellLiteral(dataDir)}`,
      `$env:OAUTH_APP_WEB_DIR = ${quotePowerShellLiteral(webDir)}`,
      `$env:OAUTH_BOOT_LOG_FILE = ${quotePowerShellLiteral(bootstrapLogPath)}`,
      `$env:OAUTH_APP_SERVER_BUILD_ID = ${quotePowerShellLiteral(serverBuildId || "")}`,
      "$env:OAUTH_APP_ADMIN_TOKEN = ''",
      "if ($settings.PSObject.Properties['adminToken']) { $env:OAUTH_APP_ADMIN_TOKEN = [string]$settings.adminToken }",
      "$env:OAUTH_APP_ENCRYPTION_KEY = ''",
      "if ($settings.PSObject.Properties['encryptionKey']) { $env:OAUTH_APP_ENCRYPTION_KEY = [string]$settings.encryptionKey }",
      `$env:OAUTH_APP_SERVER_EXE = ${quotePowerShellLiteral(exePath)}`,
      `$env:OAUTH_APP_INSTANCE_ID = ${quotePowerShellLiteral(`launcher-${Date.now()}`)}`,
      `& ${quotePowerShellLiteral(exePath)}`,
      "",
    ].join("\r\n")
    fs.writeFileSync(launcherPath, script, "utf8")
    appendBootstrapLog("info", `Updated desktop server launcher: ${launcherPath}`)
  } catch (error) {
    appendBootstrapLog("warn", `Failed to update desktop server launcher: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function formatLocalAddress(host, port) {
  return `http://${host}:${port}`
}

function resolvePowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || "C:\\Windows").trim() || "C:\\Windows"
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

function runPowerShellJson(command, extraEnv = {}) {
  const result = spawnSync(
    resolvePowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "buffer",
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${decodeProcessText(result.stderr) || decodeProcessText(result.stdout) || `exit ${result.status}`}`.trim()
    throw new Error(detail || `exit ${result.status}`)
  }
  const output = decodeProcessText(result.stdout).trim()
  return output ? JSON.parse(output) : null
}

function runPowerShell(command, extraEnv = {}) {
  const result = spawnSync(
    resolvePowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "buffer",
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${decodeProcessText(result.stderr) || decodeProcessText(result.stdout) || `exit ${result.status}`}`.trim()
    throw new Error(detail || `exit ${result.status}`)
  }
}

function computeServerBuildId(exePath) {
  try {
    const hash = crypto.createHash("sha256")
    hash.update(fs.readFileSync(exePath))
    return hash.digest("hex").slice(0, 16)
  } catch (error) {
    appendBootstrapLog("warn", `Failed to compute server build id: ${error instanceof Error ? error.message : String(error)}`)
    return ""
  }
}

function stopExistingOAuthServerProcesses() {
  if (process.platform !== "win32" || !app.isPackaged) return null
  const command = `
$ErrorActionPreference = 'Continue'
$stopped = @()
$failed = @()
$remaining = @()
$processes = @(Get-CimInstance Win32_Process -Filter "Name='oauth-server.exe'" -ErrorAction SilentlyContinue)
$launcherParents = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { [string]$_.CommandLine -like '*run-oauth-server.ps1*' })
$targets = @()
foreach ($p in $processes) {
  $targets += $p
  $parentId = [int]$p.ParentProcessId
  if ($parentId -gt 0) {
    $parent = @(Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue | Where-Object { [string]$_.CommandLine -like '*run-oauth-server.ps1*' })
    $targets += $parent
  }
}
$targets += $launcherParents
$seen = @{}
foreach ($p in $targets) {
  if ($null -eq $p -or $seen.ContainsKey([string]$p.ProcessId)) { continue }
  $seen[[string]$p.ProcessId] = $true
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    $stopped += [pscustomobject]@{
      pid = [int]$p.ProcessId
      path = [string]$p.ExecutablePath
      commandLine = [string]$p.CommandLine
    }
  } catch {
    $firstError = [string]$_.Exception.Message
    try {
      & taskkill.exe /PID ([string]$p.ProcessId) /T /F 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $stopped += [pscustomobject]@{
          pid = [int]$p.ProcessId
          path = [string]$p.ExecutablePath
          commandLine = [string]$p.CommandLine
        }
        continue
      }
    } catch {}
    $failed += [pscustomobject]@{
      pid = [int]$p.ProcessId
      path = [string]$p.ExecutablePath
      commandLine = [string]$p.CommandLine
      error = $firstError
    }
  }
}
Start-Sleep -Milliseconds 800
$after = @(Get-CimInstance Win32_Process -Filter "Name='oauth-server.exe'" -ErrorAction SilentlyContinue)
foreach ($p in $after) {
  $ports = @()
  try {
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $p.ProcessId } | Select-Object -ExpandProperty LocalPort)
  } catch {}
  $remaining += [pscustomobject]@{
    pid = [int]$p.ProcessId
    parentPid = [int]$p.ParentProcessId
    path = [string]$p.ExecutablePath
    commandLine = [string]$p.CommandLine
    ports = @($ports)
  }
}
[pscustomobject]@{
  stopped = @($stopped)
  failed = @($failed)
  remaining = @($remaining)
} | ConvertTo-Json -Compress -Depth 6
`
  try {
    return runPowerShellJson(command)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function parseNoProxyEntries(rawValue) {
  const seen = new Set()
  const values = []
  for (const token of String(rawValue ?? "").split(/[,\n;]+/)) {
    const value = token.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    values.push(value)
  }
  return values
}

function ensureLoopbackEntries(rawValue) {
  const values = parseNoProxyEntries(rawValue)
  const seen = new Set(values.map((item) => item.toLowerCase()))
  const addedEntries = []
  for (const required of REQUIRED_NO_PROXY_LOOPBACK_ENTRIES) {
    const key = required.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    values.push(required)
    addedEntries.push(required)
  }
  return {
    changed: addedEntries.length > 0,
    addedEntries,
    value: values.join(","),
  }
}

function hasProxyEnvironmentHints(snapshot) {
  const processProxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
  const processHasProxy = processProxyKeys.some((key) => String(process.env[key] ?? "").trim())
  return (
    processHasProxy ||
    Boolean(String(snapshot?.httpProxy ?? "").trim()) ||
    Boolean(String(snapshot?.httpsProxy ?? "").trim()) ||
    Boolean(String(snapshot?.allProxy ?? "").trim()) ||
    (Number(snapshot?.proxyEnable ?? 0) === 1 && Boolean(String(snapshot?.proxyServer ?? "").trim()))
  )
}

function buildLoopbackNoProxyReasons(snapshot) {
  return {
    processHttpProxy: String(process.env.HTTP_PROXY ?? process.env.http_proxy ?? "").trim(),
    processHttpsProxy: String(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "").trim(),
    processAllProxy: String(process.env.ALL_PROXY ?? process.env.all_proxy ?? "").trim(),
    userHttpProxy: String(snapshot?.httpProxy ?? "").trim(),
    userHttpsProxy: String(snapshot?.httpsProxy ?? "").trim(),
    userAllProxy: String(snapshot?.allProxy ?? "").trim(),
    systemProxyEnabled: Number(snapshot?.proxyEnable ?? 0) === 1,
    systemProxyServer: String(snapshot?.proxyServer ?? "").trim(),
  }
}

function ensureUserLoopbackNoProxyCompatibility(dataDir, bindHost) {
  if (process.platform !== "win32" || !app.isPackaged) return false
  if (!isLoopbackHost(bindHost)) return false
  const readCommand = [
    "$envReg = Get-ItemProperty 'HKCU:\\Environment' -ErrorAction SilentlyContinue",
    "$inet = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue",
    "[pscustomobject]@{",
    "  noProxy = [string]($envReg.NO_PROXY)",
    "  httpProxy = [string]($envReg.HTTP_PROXY)",
    "  httpsProxy = [string]($envReg.HTTPS_PROXY)",
    "  allProxy = [string]($envReg.ALL_PROXY)",
    "  proxyEnable = if ($null -ne $inet) { [int]($inet.ProxyEnable) } else { 0 }",
    "  proxyServer = if ($null -ne $inet) { [string]($inet.ProxyServer) } else { '' }",
    "} | ConvertTo-Json -Compress",
  ].join("\n")
  try {
    const snapshot = runPowerShellJson(readCommand) ?? {}
    const currentValue = String(snapshot.noProxy ?? "")
    const reasons = buildLoopbackNoProxyReasons(snapshot)
    if (!hasProxyEnvironmentHints(snapshot)) {
      appendBootstrapLog("info", "Skipped loopback NO_PROXY compatibility fix because no proxy environment was detected")
      const previousState = readCompatibilityState(dataDir)
      writeCompatibilityState(dataDir, {
        ...previousState,
        loopbackNoProxy: {
          originalValue: currentValue,
          appliedValue: currentValue,
          addedEntries: [],
          changed: false,
          checkedAt: Date.now(),
          reasons,
          source: "auto-loopback-no-proxy",
          status: "skipped_no_proxy_signal",
        },
      })
      return false
    }
    const merged = ensureLoopbackEntries(currentValue)
    const processMerged = ensureLoopbackEntries(process.env.NO_PROXY ?? process.env.no_proxy ?? currentValue)
    process.env.NO_PROXY = processMerged.value
    process.env.no_proxy = processMerged.value
    if (!merged.changed) {
      appendBootstrapLog("info", `Loopback NO_PROXY entries already present at user level: ${merged.value}`)
      const previousState = readCompatibilityState(dataDir)
      writeCompatibilityState(dataDir, {
        ...previousState,
        loopbackNoProxy: {
          originalValue: currentValue,
          appliedValue: merged.value,
          addedEntries: [],
          changed: false,
          checkedAt: Date.now(),
          reasons,
          source: "auto-loopback-no-proxy",
          status: "already_present",
        },
      })
      return false
    }
    const writeCommand = `
$ErrorActionPreference = 'Stop'
$value = [string]$env:OAUTH_APP_NEXT_NO_PROXY
[Environment]::SetEnvironmentVariable('NO_PROXY', $value, 'User')
if (-not ('EnvBroadcast' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EnvBroadcast {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
}
$result = [UIntPtr]::Zero
[void][EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result)
`
    runPowerShell(writeCommand, { OAUTH_APP_NEXT_NO_PROXY: merged.value })
    const previousState = readCompatibilityState(dataDir)
    writeCompatibilityState(dataDir, {
      ...previousState,
      loopbackNoProxy: {
        originalValue: currentValue,
        appliedValue: merged.value,
        addedEntries: merged.addedEntries,
        changed: true,
        appliedAt: Date.now(),
        checkedAt: Date.now(),
        reasons,
        source: "auto-loopback-no-proxy",
        status: "updated",
      },
    })
    appendBootstrapLog(
      "info",
      `Updated user-level NO_PROXY with loopback entries: ${merged.value} (new terminals may need to be reopened)`,
    )
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const previousState = readCompatibilityState(dataDir)
    writeCompatibilityState(dataDir, {
      ...previousState,
      loopbackNoProxy: {
        changed: false,
        checkedAt: Date.now(),
        error: detail,
        source: "auto-loopback-no-proxy",
        status: "update_failed",
      },
    })
    appendBootstrapLog(
      "warn",
      `Failed to apply loopback NO_PROXY compatibility fix: ${detail}`,
    )
    return false
  }
}

function redactSensitiveUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ""))
    if (url.searchParams.has("admin_token")) {
      const token = String(url.searchParams.get("admin_token") || "")
      url.searchParams.set("admin_token", token ? `${token.slice(0, 8)}...` : "")
    }
    return url.toString()
  } catch {
    return String(rawUrl ?? "")
  }
}

function parseIPv4(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
  const octets = host.split(".").map((part) => Number(part))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null
  return octets
}

function isPrivateLanIPv4(host) {
  const octets = parseIPv4(host)
  if (!octets) return false
  const [a, b] = octets
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

function isAllowedLocalBindHost(host) {
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(host)) return true
  return isPrivateLanIPv4(host)
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1"
}

function parseLocalServiceAddress(raw) {
  const value = String(raw ?? "").trim()
  if (!value) return null

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("本地服务地址格式无效，应为 http://主机:端口")
  }

  if (parsed.protocol !== "http:") {
    throw new Error("本地服务地址必须使用 http 协议")
  }

  const host = parsed.hostname.toLowerCase()
  if (!isAllowedLocalBindHost(host)) {
    throw new Error("本地服务地址主机仅允许 localhost / 127.0.0.1 / 0.0.0.0 / 局域网 IPv4")
  }

  if (!parsed.port) {
    throw new Error("本地服务地址必须包含端口")
  }

  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("本地服务端口必须在 1-65535")
  }

  return { host, port }
}

function loadLocalBinding(dataDir) {
  try {
    const data = readSettingsObject(dataDir)
    if (!data) return null
    const localServiceAddress = data?.localServiceAddress
    return parseLocalServiceAddress(localServiceAddress)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendBootstrapLog("warn", `Failed to load local service address setting: ${message}`)
    return null
  }
}

function loadSavedAdminToken(dataDir) {
  try {
    const data = readSettingsObject(dataDir)
    if (!data) return ""
    return String(data?.adminToken ?? "").trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendBootstrapLog("warn", `Failed to load saved admin token from settings: ${message}`)
    return ""
  }
}

function loadSavedEncryptionKey(dataDir) {
  try {
    const data = readSettingsObject(dataDir)
    if (!data) return ""
    return String(data?.encryptionKey ?? "").trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendBootstrapLog("warn", `Failed to load saved encryption key from settings: ${message}`)
    return ""
  }
}

function assertPortAvailable(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", (error) => reject(error))
    server.listen(port, host, () => {
      server.close(() => resolve())
    })
  })
}

function getFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Failed to resolve free port"))
          return
        }
        resolve(address.port)
      })
    })
  })
}

function isAddressInUseError(error) {
  if (!error) return false
  if (typeof error === "object" && error !== null) {
    const code = error.code
    if (typeof code === "string" && code.toUpperCase() === "EADDRINUSE") {
      return true
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return /EADDRINUSE/i.test(message)
}

function isAddressNotAvailableError(error) {
  if (!error) return false
  if (typeof error === "object" && error !== null) {
    const code = error.code
    if (typeof code === "string" && code.toUpperCase() === "EADDRNOTAVAIL") {
      return true
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return /EADDRNOTAVAIL|address not available/i.test(message)
}

function requestHealth(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const status = res.statusCode ?? 0
      res.resume()
      if (status >= 200 && status < 300) {
        resolve()
        return
      }
      reject(new Error(`Health check failed with status ${status}`))
    })
    req.on("error", reject)
    req.setTimeout(2000, () => {
      req.destroy(new Error("Health check timeout"))
    })
  })
}

function requestJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = http.get(url, (res) => {
      const status = res.statusCode ?? 0
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8")
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`))
          return
        }
        try {
          resolve(body ? JSON.parse(body) : null)
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on("error", reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("JSON request timeout"))
    })
  })
}

function normalizeComparablePath(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return ""
  try {
    return path.resolve(raw).replace(/\//g, "\\").toLowerCase()
  } catch {
    return raw.replace(/\//g, "\\").toLowerCase()
  }
}

function areSamePath(left, right) {
  const normalizedLeft = normalizeComparablePath(left)
  const normalizedRight = normalizeComparablePath(right)
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}

function collectRemainingGatewayPorts(cleanupReport) {
  const ports = new Set()
  if (!cleanupReport || !Array.isArray(cleanupReport.remaining)) return []
  for (const item of cleanupReport.remaining) {
    if (!Array.isArray(item?.ports)) continue
    for (const port of item.ports) {
      const numericPort = Number(port)
      if (Number.isInteger(numericPort) && numericPort > 0 && numericPort <= 65535) {
        ports.add(numericPort)
      }
    }
  }
  return Array.from(ports).sort((left, right) => left - right)
}

function resolveRemainingProcessIdForPort(cleanupReport, port) {
  const numericPort = Number(port)
  if (!cleanupReport || !Array.isArray(cleanupReport.remaining) || !Number.isInteger(numericPort)) return null
  for (const item of cleanupReport.remaining) {
    const ports = Array.isArray(item?.ports) ? item.ports.map((value) => Number(value)) : []
    if (!ports.includes(numericPort)) continue
    const pid = Number(item?.pid)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }
  return null
}

function collectRemainingGatewayProcessIds(cleanupReport) {
  const pids = new Set()
  if (!cleanupReport || !Array.isArray(cleanupReport.remaining)) return []
  for (const item of cleanupReport.remaining) {
    for (const value of [item?.pid, item?.parentPid]) {
      const pid = Number(value)
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
  }
  return Array.from(pids).sort((left, right) => left - right)
}

function tryStopRemainingGatewayProcessesElevated(cleanupReport, dataDir) {
  if (process.platform !== "win32" || !app.isPackaged) return null
  const pids = collectRemainingGatewayProcessIds(cleanupReport)
  if (pids.length === 0) return null
  let scriptPath = ""
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    scriptPath = path.join(dataDir, `kill-stale-codex-gateway-${Date.now()}.ps1`)
    const script = [
      "$ErrorActionPreference = 'Continue'",
      `$targets = @(${pids.map((pid) => `[int]${pid}`).join(",")})`,
      "$launchers = @(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction SilentlyContinue | Where-Object { [string]$_.CommandLine -like '*run-oauth-server.ps1*' } | Select-Object -ExpandProperty ProcessId)",
      "$allTargets = @($targets + $launchers) | Where-Object { $_ -gt 0 } | Select-Object -Unique",
      "foreach ($pid in $allTargets) {",
      "  try { & taskkill.exe /PID ([string]$pid) /T /F 2>$null | Out-Null } catch {}",
      "}",
      "",
    ].join("\r\n")
    fs.writeFileSync(scriptPath, script, "utf8")
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$scriptPath = ${quotePowerShellLiteral(scriptPath)}`,
      `$powershell = ${quotePowerShellLiteral(resolvePowerShellPath())}`,
      "Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath) -Verb RunAs -Wait -WindowStyle Hidden",
    ].join("\n")
    runPowerShell(command)
    appendBootstrapLog("warn", `Requested elevated cleanup for stale Codex Gateway processes: ${pids.join(",")}`)
    return { attempted: true, pids }
  } catch (error) {
    appendBootstrapLog(
      "warn",
      `Elevated stale Codex Gateway cleanup failed or was cancelled: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { attempted: false, pids, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (scriptPath) {
      try {
        fs.unlinkSync(scriptPath)
      } catch {}
    }
  }
}

function stopWindowsProcessTreeByPid(pid) {
  const numericPid = Number(pid)
  if (process.platform !== "win32" || !Number.isInteger(numericPid) || numericPid <= 0) return false
  const result = spawnSync("taskkill", ["/PID", String(numericPid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  })
  return result.status === 0
}

async function attachToExistingGatewayService({ cleanupReport, dataDir, webDir, exePath, managementToken, expectedServerBuildId }) {
  if (!app.isPackaged) return null
  const ports = collectRemainingGatewayPorts(cleanupReport)
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`
    try {
      const health = await requestJson(`${baseUrl}/api/health`)
      const runtime = health?.runtime ?? {}
      const isGateway = health?.ok === true && health?.name === "Codex Gateway"
      const dataMatches = areSamePath(runtime.dataDir, dataDir)
      const exeMatches = areSamePath(runtime.serverExecutable, exePath)
      const webMatches = areSamePath(runtime.webDir, webDir)
      const buildIdMatches =
        !expectedServerBuildId ||
        (typeof runtime.serverBuildId === "string" && runtime.serverBuildId === expectedServerBuildId)
      if (isGateway && dataMatches && (exeMatches || webMatches) && buildIdMatches) {
        serverBaseUrl = baseUrl
        serverManagementToken = managementToken
        const healthPid = Number(health?.pid)
        attachedServerProcessId =
          Number.isInteger(healthPid) && healthPid > 0 ? healthPid : resolveRemainingProcessIdForPort(cleanupReport, port)
        appendBootstrapLog(
          "info",
          `Attached to existing Codex Gateway service at ${baseUrl} pid=${attachedServerProcessId ?? health?.pid ?? "unknown"}`,
        )
        return baseUrl
      }
      appendBootstrapLog(
        "warn",
        `Existing service at ${baseUrl} is not attachable: gateway=${isGateway}, dataMatches=${dataMatches}, exeMatches=${exeMatches}, webMatches=${webMatches}, buildIdMatches=${buildIdMatches}, expectedBuildId=${expectedServerBuildId || "-"}, actualBuildId=${runtime.serverBuildId ?? "-"}`,
      )
    } catch (error) {
      appendBootstrapLog(
        "warn",
        `Existing service probe failed at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return null
}

const HEALTH_CHECK_ATTEMPTS = 160
const HEALTH_CHECK_DELAY_MS = 250

async function waitForServer(baseUrl) {
  let lastError = null
  for (let attempt = 0; attempt < HEALTH_CHECK_ATTEMPTS; attempt += 1) {
    try {
      await requestHealth(`${baseUrl}/api/health`)
      return
    } catch (error) {
      lastError = error
      if (attempt < HEALTH_CHECK_ATTEMPTS - 1) {
        appendBootstrapLog(
          "warn",
          `Health check ${attempt + 1}/${HEALTH_CHECK_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    await delay(HEALTH_CHECK_DELAY_MS)
  }
  throw lastError ?? new Error(`Server startup timeout after ${HEALTH_CHECK_ATTEMPTS * HEALTH_CHECK_DELAY_MS}ms`)
}

function stopServer(options = {}) {
  const force = options.force === true
  if (!serverProcess) {
    const attachedPid = attachedServerProcessId
    attachedServerProcessId = null
    serverManagementToken = ""
    if (attachedPid) {
      const stopped = stopWindowsProcessTreeByPid(attachedPid)
      appendBootstrapLog(
        stopped ? "info" : "warn",
        `Stopped attached Codex Gateway service pid=${attachedPid}: ${stopped ? "ok" : "failed"}`,
      )
    }
    return
  }
  const proc = serverProcess
  serverProcess = null
  attachedServerProcessId = null
  serverManagementToken = ""

  if (process.platform === "win32" && Number(proc.pid) > 0) {
    const stopped = stopWindowsProcessTreeByPid(proc.pid)
    appendBootstrapLog(
      stopped ? "info" : "warn",
      `Stopped bundled Codex Gateway service pid=${proc.pid}: ${stopped ? "ok" : "failed"}`,
    )
    if (!stopped) {
      try {
        proc.kill("SIGKILL")
      } catch {}
    }
    return
  }

  try {
    proc.kill(force ? "SIGKILL" : "SIGTERM")
  } catch {}

  if (force) return

  setTimeout(() => {
    const stillRunning = proc.exitCode === null && proc.signalCode === null
    if (!stillRunning) return
    if (process.platform === "win32" && Number(proc.pid) > 0) {
      try {
        stopWindowsProcessTreeByPid(proc.pid)
        return
      } catch {}
    }
    try {
      proc.kill("SIGKILL")
    } catch {}
  }, 2500).unref()
}

async function startServer() {
  if (serverBaseUrl) {
    return serverBaseUrl
  }

  const exePath = resolveServerExePath()
  if (!fs.existsSync(exePath)) {
    throw new Error(`Server executable not found: ${exePath}`)
  }

  const dataDir = resolveDataDir()
  const webDir = resolveWebDir()
  fs.mkdirSync(dataDir, { recursive: true })
  prepareBootstrapLog()
  const serverBuildId = computeServerBuildId(exePath)
  appendBootstrapLog("info", "Starting bundled OAuth server")
  appendBootstrapLog("info", `Data directory: ${dataDir}`)
  appendBootstrapLog("info", `Web directory: ${webDir}`)
  appendBootstrapLog("info", `Server build id: ${serverBuildId || "unknown"}`)
  const localBinding = loadLocalBinding(dataDir)
  const savedAdminToken = loadSavedAdminToken(dataDir)
  const savedEncryptionKey = loadSavedEncryptionKey(dataDir)
  const effectiveAdminToken = String(process.env.OAUTH_APP_ADMIN_TOKEN ?? "").trim() || savedAdminToken
  const effectiveEncryptionKey = String(process.env.OAUTH_APP_ENCRYPTION_KEY ?? "").trim() || savedEncryptionKey
  let cleanupReport = stopExistingOAuthServerProcesses()
  if (cleanupReport) {
    let stoppedCount = Array.isArray(cleanupReport.stopped) ? cleanupReport.stopped.length : 0
    let failedCount = Array.isArray(cleanupReport.failed) ? cleanupReport.failed.length : 0
    let remainingCount = Array.isArray(cleanupReport.remaining) ? cleanupReport.remaining.length : 0
    appendBootstrapLog(
      failedCount > 0 || remainingCount > 0 || cleanupReport.error ? "warn" : "info",
      `Existing oauth-server cleanup: stopped=${stoppedCount}, failed=${failedCount}, remaining=${remainingCount}${
        cleanupReport.error ? `, error=${cleanupReport.error}` : ""
      }`,
    )
    if (remainingCount > 0) {
      const elevatedCleanup = tryStopRemainingGatewayProcessesElevated(cleanupReport, dataDir)
      if (elevatedCleanup?.attempted) {
        await delay(1000)
        cleanupReport = stopExistingOAuthServerProcesses()
        stoppedCount = Array.isArray(cleanupReport?.stopped) ? cleanupReport.stopped.length : 0
        failedCount = Array.isArray(cleanupReport?.failed) ? cleanupReport.failed.length : 0
        remainingCount = Array.isArray(cleanupReport?.remaining) ? cleanupReport.remaining.length : 0
        appendBootstrapLog(
          failedCount > 0 || remainingCount > 0 || cleanupReport?.error ? "warn" : "info",
          `Existing oauth-server cleanup after elevated attempt: stopped=${stoppedCount}, failed=${failedCount}, remaining=${remainingCount}${
            cleanupReport?.error ? `, error=${cleanupReport.error}` : ""
          }`,
        )
      }
    }
    if (remainingCount > 0) {
      const attachedBaseUrl = await attachToExistingGatewayService({
        cleanupReport,
        dataDir,
        webDir,
        exePath,
        managementToken: effectiveAdminToken,
        expectedServerBuildId: serverBuildId,
      })
      if (attachedBaseUrl) {
        const attachedPort = Number(new URL(attachedBaseUrl).port)
        if (Number.isInteger(attachedPort) && attachedPort > 0) {
          writeDesktopServerLauncher({ exePath, dataDir, webDir, bindHost: "127.0.0.1", port: attachedPort, serverBuildId })
        }
        ensureUserLoopbackNoProxyCompatibility(dataDir, "127.0.0.1")
        return attachedBaseUrl
      }
      const remainingDetail = cleanupReport.remaining
        .map((item) => {
          const ports = Array.isArray(item?.ports) && item.ports.length > 0 ? ` ports=${item.ports.join(",")}` : ""
          return `pid=${item?.pid ?? "unknown"}${ports}`
        })
        .join("; ")
      const remainingPorts = collectRemainingGatewayPorts(cleanupReport)
      if (remainingPorts.includes(1455)) {
        throw new Error(
          `A stale Codex Gateway oauth-server still owns the official Codex OAuth callback port 1455 and could not be stopped automatically. This would break browser login, so startup was stopped instead of falling back to a random port. Close or kill the stale process as administrator first: ${remainingDetail}`,
        )
      }
      appendBootstrapLog(
        "warn",
        `Existing oauth-server process could not be stopped and is not attachable; quarantining it and starting a fresh gateway on a free port: ${remainingDetail}`,
      )
    }
  }
  let bindHost = localBinding?.host ?? "127.0.0.1"
  let shouldPersistResolvedBinding = false
  if (bindHost === "localhost") {
    bindHost = "127.0.0.1"
    shouldPersistResolvedBinding = true
    appendBootstrapLog("info", "Normalized localhost bind host to 127.0.0.1 for a stable desktop loopback address")
  }
  const hasEncryptionKey = Boolean(effectiveEncryptionKey)
  if (!isLoopbackHost(bindHost) && !hasEncryptionKey) {
    appendBootstrapLog(
      "warn",
      `Configured bind host ${bindHost} requires OAUTH_APP_ENCRYPTION_KEY; fallback to 127.0.0.1 for safe startup`,
    )
    bindHost = "127.0.0.1"
    shouldPersistResolvedBinding = true
  }
  let localOpenHost = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost
  let port = localBinding?.port
  if (app.isPackaged && isLoopbackHost(bindHost) && port && port !== DEFAULT_PACKAGED_LOOPBACK_PORT) {
    appendBootstrapLog(
      "warn",
      `Resetting stale loopback service port ${port} to stable packaged port ${DEFAULT_PACKAGED_LOOPBACK_PORT}`,
    )
    port = DEFAULT_PACKAGED_LOOPBACK_PORT
    shouldPersistResolvedBinding = true
  }

  if (port) {
    try {
      await assertPortAvailable(bindHost, port)
      appendBootstrapLog("info", `Using configured bind address: ${formatLocalAddress(bindHost, port)}`)
      appendBootstrapLog("info", `Local UI address: ${formatLocalAddress(localOpenHost, port)}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (isAddressInUseError(error)) {
        const original = formatLocalAddress(bindHost, port)
        appendBootstrapLog("warn", `Configured local service address is occupied: ${original}; falling back to auto port`)
        port = await getFreePort(bindHost)
        shouldPersistResolvedBinding = true
        appendBootstrapLog("info", `Fallback bind address: ${formatLocalAddress(bindHost, port)}`)
        appendBootstrapLog("info", `Local UI address: ${formatLocalAddress(localOpenHost, port)}`)
      } else if (isAddressNotAvailableError(error) && !isLoopbackHost(bindHost)) {
        const original = formatLocalAddress(bindHost, port)
        bindHost = "127.0.0.1"
        localOpenHost = "127.0.0.1"
        shouldPersistResolvedBinding = true
        appendBootstrapLog(
          "warn",
          `Configured local service address is unavailable: ${original}; falling back to ${formatLocalAddress(bindHost, port)}`,
        )
        try {
          await assertPortAvailable(bindHost, port)
          appendBootstrapLog("info", `Fallback bind address: ${formatLocalAddress(bindHost, port)}`)
          appendBootstrapLog("info", `Local UI address: ${formatLocalAddress(localOpenHost, port)}`)
        } catch (fallbackError) {
          if (!isAddressInUseError(fallbackError)) {
            const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            throw new Error(`Configured local service address is unavailable (${original}); fallback to loopback failed: ${fallbackDetail}`)
          }
          appendBootstrapLog(
            "warn",
            `Loopback fallback address is occupied: ${formatLocalAddress(bindHost, port)}; falling back to auto port`,
          )
          port = await getFreePort(bindHost)
          shouldPersistResolvedBinding = true
          appendBootstrapLog("info", `Fallback bind address: ${formatLocalAddress(bindHost, port)}`)
          appendBootstrapLog("info", `Local UI address: ${formatLocalAddress(localOpenHost, port)}`)
        }
      } else {
        throw new Error(`Configured local service address is unavailable (${formatLocalAddress(bindHost, port)}): ${detail}`)
      }
    }
  } else {
    if (app.isPackaged && isLoopbackHost(bindHost)) {
      port = DEFAULT_PACKAGED_LOOPBACK_PORT
      shouldPersistResolvedBinding = true
      try {
        await assertPortAvailable(bindHost, port)
        appendBootstrapLog("info", `Using packaged default bind address: ${formatLocalAddress(bindHost, port)}`)
        appendBootstrapLog("info", `Local UI address: ${formatLocalAddress(localOpenHost, port)}`)
      } catch (error) {
        if (!isAddressInUseError(error)) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`Default local service address is unavailable (${formatLocalAddress(bindHost, port)}): ${detail}`)
        }
        appendBootstrapLog(
          "warn",
          `Packaged default bind address is occupied: ${formatLocalAddress(bindHost, port)}; falling back to auto port`,
        )
        port = await getFreePort(bindHost)
        appendBootstrapLog("info", `Fallback bind address: ${formatLocalAddress(bindHost, port)}`)
        appendBootstrapLog("info", `Local UI address: ${formatLocalAddress(localOpenHost, port)}`)
      }
    } else {
      port = await getFreePort(bindHost)
      appendBootstrapLog("info", `Using auto bind address: ${formatLocalAddress(bindHost, port)}`)
      appendBootstrapLog("info", `Local UI address: ${formatLocalAddress(localOpenHost, port)}`)
    }
  }

  const env = {
    ...process.env,
    OAUTH_APP_HOST: bindHost,
    OAUTH_APP_PORT: String(port),
    OAUTH_APP_DATA_DIR: dataDir,
    OAUTH_APP_WEB_DIR: webDir,
    OAUTH_BOOT_LOG_FILE: resolveBootstrapLogPath(),
    OAUTH_APP_ADMIN_TOKEN: effectiveAdminToken,
    OAUTH_APP_ENCRYPTION_KEY: effectiveEncryptionKey,
    OAUTH_APP_SERVER_EXE: exePath,
    OAUTH_APP_SERVER_BUILD_ID: serverBuildId,
    OAUTH_APP_INSTANCE_ID: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  }
  serverManagementToken = effectiveAdminToken
  attachedServerProcessId = null
  writeDesktopServerLauncher({ exePath, dataDir, webDir, bindHost, port, serverBuildId })

  serverProcess = spawn(exePath, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  serverProcess.stdout?.on("data", (chunk) => {
    process.stdout.write(`[server] ${decodeProcessText(chunk)}`)
    recordServerOutput(chunk, "info")
  })
  serverProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(`[server] ${decodeProcessText(chunk)}`)
    recordServerOutput(chunk, "error")
  })
  serverProcess.on("exit", (code, signal) => {
    const reason = code !== null ? `exit code ${code}` : `signal ${signal}`
    serverProcess = null
    if (isQuitting || suppressExitNotification) return
    notifyServerFailure(reason)
  })
  serverProcess.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error)
    serverProcess = null
    if (isQuitting || suppressExitNotification) return
    notifyServerFailure(`child process error: ${message}`)
  })

  serverBaseUrl = formatLocalAddress(localOpenHost, port)
  try {
    await waitForServer(serverBaseUrl)
    if (shouldPersistResolvedBinding) {
      persistResolvedLocalBinding(dataDir, bindHost, port)
    }
    if (isLoopbackHost(bindHost)) {
      ensureUserLoopbackNoProxyCompatibility(dataDir, bindHost)
    }
    appendBootstrapLog("info", `Server health check passed at ${serverBaseUrl}`)
    return serverBaseUrl
  } catch (error) {
    appendBootstrapLog("error", `Server startup health check failed: ${error instanceof Error ? error.message : String(error)}`)
    stopServer()
    serverBaseUrl = null
    throw new Error(buildDetailedError(error instanceof Error ? error.message : String(error)))
  }
}

function buildDesktopUrl(baseUrl) {
  const url = new URL(baseUrl)
  url.searchParams.set("desktop", "1")
  if (serverManagementToken) {
    url.searchParams.set("admin_token", serverManagementToken)
  }
  return url.toString()
}

async function restartServerProcess() {
  if (serverRestartInProgress) return
  serverRestartInProgress = true
  suppressExitNotification = true
  try {
    stopServer({ force: true })
    serverBaseUrl = null
    const baseUrl = await startServer()
    if (!mainWindow || mainWindow.isDestroyed()) return
    await mainWindow.loadURL(buildDesktopUrl(baseUrl))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox("Codex Gateway", `Failed to restart the OAuth server:\n${detail}`)
  } finally {
    suppressExitNotification = false
    serverRestartInProgress = false
  }
}

function notifyServerFailure(reason) {
  appendBootstrapLog("error", `Server process stopped unexpectedly (${reason})`)
  if (!mainWindow || mainWindow.isDestroyed()) {
    app.quit()
    return
  }
  const response = dialog.showMessageBoxSync(mainWindow, {
    type: "error",
    title: "Codex Gateway",
    message: "The OAuth server has stopped",
    detail: buildDetailedError(`The bundled server exited with ${reason}.`),
    buttons: ["Restart server", "Quit application"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) {
    void restartServerProcess()
  } else {
    isQuitting = true
    app.quit()
  }
}

async function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    return
  }

  const baseUrl = await startServer()
  const windowOptions = {
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    autoHideMenuBar: true,
    show: false,
  }
  const appIconPath = resolveDesktopIconPath()
  if (appIconPath && process.platform !== "darwin") {
    windowOptions.icon = appIconPath
  }

  mainWindow = new BrowserWindow(windowOptions)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  mainWindow.once("ready-to-show", () => mainWindow?.show())
  mainWindow.on("closed", () => {
    mainWindow = null
  })
  const desktopUrl = buildDesktopUrl(baseUrl)
  appendBootstrapLog(
    "info",
    `Desktop window target: ${redactSensitiveUrl(desktopUrl)} adminToken=${serverManagementToken ? "present" : "missing"}`,
  )
  await mainWindow.loadURL(desktopUrl)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.on("second-instance", () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  try {
    await createMainWindow()
  } catch (error) {
    dialog.showErrorBox("Codex Gateway", `Startup failed: ${error instanceof Error ? error.message : String(error)}`)
    app.quit()
  }
})

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      await createMainWindow()
    } catch (error) {
      dialog.showErrorBox("Codex Gateway", `Startup failed: ${error instanceof Error ? error.message : String(error)}`)
      app.quit()
    }
  }
})

app.on("before-quit", () => {
  isQuitting = true
  stopServer({ force: true })
  serverBaseUrl = null
})

process.once("exit", () => {
  try {
    stopServer({ force: true })
  } catch {}
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
