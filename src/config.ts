import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"

function resolveDataDir() {
  if (process.env.OAUTH_APP_DATA_DIR) {
    return path.resolve(process.env.OAUTH_APP_DATA_DIR)
  }

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    return path.join(localAppData, "OAuthMultiLoginApp", "data")
  }

  return path.join(os.homedir(), ".oauth-multi-login-app", "data")
}

function resolveWebDir() {
  if (process.env.OAUTH_APP_WEB_DIR) {
    return path.resolve(process.env.OAUTH_APP_WEB_DIR)
  }

  const projectRoot = path.resolve(import.meta.dir, "..")
  const executableDir = path.dirname(process.execPath)
  const candidates = [
    path.join(projectRoot, "src", "web"),
    path.join(projectRoot, "web"),
    path.join(process.cwd(), "src", "web"),
    path.join(executableDir, "web"),
  ]

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) {
      return candidate
    }
  }

  return candidates[0]
}

const dataDir = resolveDataDir()
const webDir = resolveWebDir()

export const AppConfig = {
  name: "Codex Gateway",
  host: process.env.OAUTH_APP_HOST ?? "127.0.0.1",
  port: Number(process.env.OAUTH_APP_PORT ?? "4777"),
  adminToken: process.env.OAUTH_APP_ADMIN_TOKEN ?? "",
  encryptionKey: process.env.OAUTH_APP_ENCRYPTION_KEY ?? "",
  dataDir,
  webDir,
  indexHtmlPath: path.join(webDir, "index.html"),
  dbFile: path.join(dataDir, "accounts.db"),
  settingsFile: path.join(dataDir, "settings.json"),
  bootstrapLogFile: process.env.OAUTH_BOOT_LOG_FILE ? path.resolve(process.env.OAUTH_BOOT_LOG_FILE) : path.join(dataDir, "bootstrap.log"),
  sessionTtlMs: 60 * 60 * 1000,
}

export async function ensureAppDirs() {
  await mkdir(AppConfig.dataDir, { recursive: true })
}
