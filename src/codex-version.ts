import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FALLBACK_CODEX_CLIENT_VERSION = "0.115.0"

function normalizeVersion(raw?: string | null) {
  const value = String(raw ?? "").trim()
  if (!value) return undefined
  const withoutPrefix = value.replace(/^rust-v/i, "").replace(/^v/i, "")
  if (!VERSION_PATTERN.test(withoutPrefix)) return undefined
  return withoutPrefix
}

function listTagVersions(repoRoot: string, pattern: string) {
  const result = spawnSync("git", ["-C", repoRoot, "tag", "--list", pattern, "--sort=-version:refname"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) return []
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => normalizeVersion(line))
    .filter((line): line is string => Boolean(line))
}

function describeTagVersion(repoRoot: string) {
  const result = spawnSync("git", ["-C", repoRoot, "describe", "--tags", "--abbrev=0"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0) return undefined
  return normalizeVersion(result.stdout)
}

function resolveVersionFromGitRepo(repoRoot: string) {
  const rustVersions = listTagVersions(repoRoot, "rust-v*")
  if (rustVersions.length > 0) {
    const stable = rustVersions.find((item) => !item.includes("-"))
    return stable ?? rustVersions[0]
  }

  const genericVersions = listTagVersions(repoRoot, "v*")
  if (genericVersions.length > 0) {
    const stable = genericVersions.find((item) => !item.includes("-"))
    return stable ?? genericVersions[0]
  }

  return describeTagVersion(repoRoot)
}

function collectCodexOfficialRoots() {
  const candidates = [
    process.env.OAUTH_CODEX_OFFICIAL_ROOT,
    path.resolve(process.cwd(), "codex-official"),
    path.resolve(process.cwd(), "../codex-official"),
    path.resolve(import.meta.dir, "../../codex-official"),
  ]

  const seen = new Set<string>()
  const roots: string[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = path.resolve(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    if (!existsSync(normalized)) continue
    if (!existsSync(path.join(normalized, ".git"))) continue
    roots.push(normalized)
  }
  return roots
}

function resolveFromLocalCodexOfficial() {
  const roots = collectCodexOfficialRoots()
  for (const root of roots) {
    const version = resolveVersionFromGitRepo(root)
    if (version) return version
  }
  return undefined
}

function resolveOverrideVersion() {
  const override = normalizeVersion(process.env.OAUTH_CODEX_CLIENT_VERSION)
  if (override) return override
  return undefined
}

export function resolveCodexClientVersion() {
  return resolveOverrideVersion() ?? resolveFromLocalCodexOfficial() ?? FALLBACK_CODEX_CLIENT_VERSION
}

