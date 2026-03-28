import os from "node:os"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

function sanitizeHeaderValue(value: string) {
  return value.replace(/[^A-Za-z0-9._/-]/g, "_")
}

function sanitizeUserAgent(raw: string, fallback: string) {
  const validHeaderValue = /^[\x20-\x7E]+$/
  if (validHeaderValue.test(raw)) return raw
  const sanitized = raw.replace(/[^\x20-\x7E]/g, "_")
  if (sanitized && validHeaderValue.test(sanitized)) return sanitized
  return fallback
}

function noneIfWhitespace(value?: string | null) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : undefined
}

function formatTerminalVersion(name: string, version?: string) {
  return version ? `${name}/${version}` : name
}

function detectTerminalUserAgentToken() {
  const termProgram = noneIfWhitespace(process.env.TERM_PROGRAM)
  const termProgramVersion = noneIfWhitespace(process.env.TERM_PROGRAM_VERSION)
  if (termProgram) {
    return sanitizeHeaderValue(formatTerminalVersion(termProgram, termProgramVersion))
  }

  const weztermVersion = noneIfWhitespace(process.env.WEZTERM_VERSION)
  if (weztermVersion) return sanitizeHeaderValue(formatTerminalVersion("WezTerm", weztermVersion))

  if (process.env.ITERM_SESSION_ID || process.env.ITERM_PROFILE || process.env.ITERM_PROFILE_NAME) {
    return "iTerm.app"
  }

  if (process.env.TERM_SESSION_ID) return "Apple_Terminal"

  const term = noneIfWhitespace(process.env.TERM)
  if (process.env.KITTY_WINDOW_ID || term?.includes("kitty")) return "kitty"
  if (process.env.ALACRITTY_SOCKET || term === "alacritty") return "Alacritty"

  const konsoleVersion = noneIfWhitespace(process.env.KONSOLE_VERSION)
  if (konsoleVersion) return sanitizeHeaderValue(formatTerminalVersion("Konsole", konsoleVersion))

  if (process.env.GNOME_TERMINAL_SCREEN) return "gnome-terminal"

  const vteVersion = noneIfWhitespace(process.env.VTE_VERSION)
  if (vteVersion) return sanitizeHeaderValue(formatTerminalVersion("VTE", vteVersion))

  if (process.env.WT_SESSION) return "WindowsTerminal"
  if (term) return sanitizeHeaderValue(term)
  return "unknown"
}

function normalizeArchitecture() {
  switch (os.arch()) {
    case "x64":
      return "x86_64"
    case "ia32":
      return "x86"
    default:
      return os.arch() || "unknown"
  }
}

function detectWindowsVersion() {
  const release = os.release()
  const [majorRaw, minorRaw, buildRaw] = release.split(".")
  const major = Number(majorRaw)
  const minor = Number(minorRaw)
  const build = Number(buildRaw)
  if (Number.isInteger(major) && major >= 10 && Number.isInteger(build) && build >= 22000) return "11"
  if (Number.isInteger(major) && Number.isInteger(minor)) return `${major}.${minor}`
  return release || "unknown"
}

function detectMacVersion() {
  try {
    return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() || os.release()
  } catch {
    return os.release() || "unknown"
  }
}

function detectLinuxInfo() {
  const osReleasePath = "/etc/os-release"
  if (!existsSync(osReleasePath)) return null

  try {
    const content = readFileSync(osReleasePath, "utf8")
    const rows = content.split(/\r?\n/)
    const map = new Map<string, string>()
    for (const row of rows) {
      const index = row.indexOf("=")
      if (index <= 0) continue
      const key = row.slice(0, index).trim()
      const raw = row.slice(index + 1).trim()
      const value = raw.replace(/^"(.*)"$/, "$1")
      map.set(key, value)
    }
    const name = noneIfWhitespace(map.get("NAME")) ?? "Linux"
    const version = noneIfWhitespace(map.get("VERSION_ID")) ?? os.release() ?? "unknown"
    return { osType: name, osVersion: version }
  } catch {
    return null
  }
}

function detectOsTypeAndVersion() {
  switch (process.platform) {
    case "win32":
      return { osType: "Windows", osVersion: detectWindowsVersion() }
    case "darwin":
      return { osType: "Mac OS", osVersion: detectMacVersion() }
    case "linux": {
      const linux = detectLinuxInfo()
      if (linux) return linux
      return { osType: "Linux", osVersion: os.release() || "unknown" }
    }
    default:
      return { osType: os.type() || process.platform, osVersion: os.release() || "unknown" }
  }
}

export function buildCodexUserAgent(originator: string, version: string) {
  const { osType, osVersion } = detectOsTypeAndVersion()
  const architecture = normalizeArchitecture()
  const terminal = detectTerminalUserAgentToken()
  const candidate = `${originator}/${version} (${osType} ${osVersion}; ${architecture}) ${terminal}`
  return sanitizeUserAgent(candidate, `${originator}/${version}`)
}
