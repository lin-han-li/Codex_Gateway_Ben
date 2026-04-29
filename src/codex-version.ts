import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FALLBACK_CODEX_CLIENT_VERSION = "0.125.0"
const FALLBACK_CODEX_PROMPT = "You are Codex, a coding agent based on GPT-5."
const OFFICIAL_PROMPT_RELATIVE_PATHS = [
  path.join("codex-rs", "core", "prompt.md"),
  path.join("codex-rs", "core", "prompt_with_apply_patch_instructions.md"),
]
const OFFICIAL_MODELS_RELATIVE_PATHS = [
  path.join("codex-rs", "models-manager", "models.json"),
  path.join("codex-rs", "core", "models.json"),
]

export type CodexOfficialAssetSourceKind = "env_override" | "official_checkout" | "fallback"

export type CodexOfficialAssetSource = {
  kind: CodexOfficialAssetSourceKind
  path: string | null
}

export type CodexOfficialAssetBundle = {
  clientVersion: string
  clientVersionSource: CodexOfficialAssetSource
  prompt: string
  promptSource: CodexOfficialAssetSource
  modelsFile: string | null
  modelsSource: CodexOfficialAssetSource
}

function normalizeVersion(raw?: string | null) {
  const value = String(raw ?? "").trim()
  if (!value) return undefined
  const withoutPrefix = value.replace(/^rust-v/i, "").replace(/^v/i, "")
  if (!VERSION_PATTERN.test(withoutPrefix)) return undefined
  const [major = 0, minor = 0, patch = 0] = withoutPrefix
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
  if (major === 0 && minor === 0 && patch > 999) return undefined
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

export function collectCodexOfficialRoots() {
  const candidates = [
    process.env.OAUTH_CODEX_OFFICIAL_ROOT,
    path.resolve(process.cwd(), "codex_office_source"),
    path.resolve(process.cwd(), "codex-official"),
    path.resolve(process.cwd(), "../codex_office_source"),
    path.resolve(process.cwd(), "../codex-official"),
    path.resolve(import.meta.dir, "../../codex_office_source"),
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

function resolveVersionFromLocalCodexOfficial() {
  const roots = collectCodexOfficialRoots()
  for (const root of roots) {
    const version = resolveVersionFromGitRepo(root)
    if (version) {
      return {
        version,
        source: {
          kind: "official_checkout" as const,
          path: root,
        },
      }
    }
  }
  return undefined
}

function resolvePromptFromOfficialRoots() {
  for (const root of collectCodexOfficialRoots()) {
    for (const relativePath of OFFICIAL_PROMPT_RELATIVE_PATHS) {
      const candidate = path.join(root, relativePath)
      if (!existsSync(candidate)) continue
      return {
        path: candidate,
        source: {
          kind: "official_checkout" as const,
          path: candidate,
        },
      }
    }
  }
  return undefined
}

function resolveModelsFileFromOfficialRoots() {
  for (const root of collectCodexOfficialRoots()) {
    for (const relativePath of OFFICIAL_MODELS_RELATIVE_PATHS) {
      const candidate = path.join(root, relativePath)
      if (!existsSync(candidate)) continue
      return {
        path: candidate,
        source: {
          kind: "official_checkout" as const,
          path: candidate,
        },
      }
    }
  }
  return undefined
}

export function resolveCodexOfficialAssetBundle(): CodexOfficialAssetBundle {
  const overrideVersion = resolveOverrideVersion()
  const localVersion = resolveVersionFromLocalCodexOfficial()
  const promptOverride = String(process.env.OAUTH_CODEX_PROMPT_FILE ?? "").trim()
  const promptOfficial = resolvePromptFromOfficialRoots()
  const modelsOverride = String(process.env.OAUTH_CODEX_MODELS_FILE ?? "").trim()
  const modelsOfficial = resolveModelsFileFromOfficialRoots()

  return {
    clientVersion: overrideVersion ?? localVersion?.version ?? FALLBACK_CODEX_CLIENT_VERSION,
    clientVersionSource: overrideVersion
      ? { kind: "env_override", path: "OAUTH_CODEX_CLIENT_VERSION" }
      : localVersion?.source ?? { kind: "fallback", path: null },
    prompt: FALLBACK_CODEX_PROMPT,
    promptSource: promptOverride
      ? { kind: "env_override", path: promptOverride }
      : promptOfficial?.source ?? { kind: "fallback", path: null },
    modelsFile: modelsOverride || modelsOfficial?.path || null,
    modelsSource: modelsOverride
      ? { kind: "env_override", path: modelsOverride }
      : modelsOfficial?.source ?? { kind: "fallback", path: null },
  }
}

export function loadCodexOfficialAssetStatus() {
  return resolveCodexOfficialAssetBundle()
}

export async function loadCodexInstructionsText() {
  const bundle = resolveCodexOfficialAssetBundle()
  if (bundle.promptSource.kind !== "fallback" && bundle.promptSource.path && existsSync(bundle.promptSource.path)) {
    const { readFile } = await import("node:fs/promises")
    try {
      const content = (await readFile(bundle.promptSource.path, "utf8")).trim()
      if (content.length > 0) {
        return {
          content,
          source: bundle.promptSource,
        }
      }
    } catch {
      // ignore and fall through to fallback
    }
  }
  return {
    content: FALLBACK_CODEX_PROMPT,
    source: { kind: "fallback" as const, path: null },
  }
}

export function resolveCodexModelsFilePath() {
  const bundle = resolveCodexOfficialAssetBundle()
  return {
    path: bundle.modelsFile,
    source: bundle.modelsSource,
  }
}

export function resolveCodexRuntimeAssetStatus() {
  const bundle = resolveCodexOfficialAssetBundle()
  return {
    clientVersion: bundle.clientVersion,
    clientVersionSource: bundle.clientVersionSource,
    promptSource: bundle.promptSource,
    modelsSource: bundle.modelsSource,
    modelsFile: bundle.modelsFile,
  }
}

function resolveFromLocalCodexOfficial() {
  return resolveVersionFromLocalCodexOfficial()?.version
}

function resolveOverrideVersion() {
  const override = normalizeVersion(process.env.OAUTH_CODEX_CLIENT_VERSION)
  if (override) return override
  return undefined
}

export function resolveCodexClientVersion() {
  return resolveOverrideVersion() ?? resolveFromLocalCodexOfficial() ?? FALLBACK_CODEX_CLIENT_VERSION
}

export function toWholeCodexClientVersion(version?: string | null) {
  const normalized = normalizeVersion(version)
  if (!normalized) return FALLBACK_CODEX_CLIENT_VERSION
  return normalized.split("-")[0] || FALLBACK_CODEX_CLIENT_VERSION
}

