import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type PluginInput = unknown

type Hooks = {
  auth?: {
    provider: string
    loader: (getAuth: () => Promise<unknown>) => Promise<{ apiKey?: string; baseURL?: string }>
  }
}

type OAuthAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
}

type CacheRecord = {
  version: 1
  entries: Record<
    string,
    {
      apiKey: string
      baseURL: string
      updatedAt: number
    }
  >
}

type SyncResponse = {
  baseURL: string
  virtualKey?: {
    key: string
  }
}

const BRIDGE_ORIGIN = process.env.CODEX_BRIDGE_ORIGIN ?? "http://127.0.0.1:4777"
const BRIDGE_ADMIN_TOKEN = process.env.CODEX_BRIDGE_ADMIN_TOKEN ?? ""
const CACHE_FILE = process.env.CODEX_BRIDGE_CACHE_FILE ?? path.join(os.homedir(), ".codex", "virtual-key-bridge-cache.json")

async function readCache(): Promise<CacheRecord> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8")
    const data = JSON.parse(raw) as CacheRecord
    if (data && data.version === 1 && data.entries && typeof data.entries === "object") {
      return data
    }
  } catch {
    // ignore invalid cache
  }
  return { version: 1, entries: {} }
}

async function writeCache(data: CacheRecord) {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true })
  await writeFile(CACHE_FILE, JSON.stringify(data, null, 2), "utf8")
}

function cacheSlot(auth: OAuthAuth) {
  return auth.accountId ? `openai:${auth.accountId}` : "openai:default"
}

async function syncBridge(auth: OAuthAuth): Promise<{ apiKey: string; baseURL: string }> {
  const response = await fetch(`${BRIDGE_ORIGIN}/api/bridge/oauth/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BRIDGE_ADMIN_TOKEN ? { "x-admin-token": BRIDGE_ADMIN_TOKEN } : {}),
    },
    body: JSON.stringify({
      providerId: "chatgpt",
      providerName: "ChatGPT",
      methodId: "codex-oauth",
      displayName: auth.accountId ? `Codex OAuth (${auth.accountId})` : "Codex OAuth",
      accountId: auth.accountId,
      accessToken: auth.access,
      refreshToken: auth.refresh,
      expiresAt: auth.expires,
      issueVirtualKey: true,
      keyName: "Codex Bridge Key",
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as SyncResponse & { error?: string }
  if (!response.ok) {
    throw new Error(payload.error || `Bridge sync failed (${response.status})`)
  }
  if (!payload.virtualKey?.key) {
    throw new Error("Bridge did not return virtual key")
  }
  if (!payload.baseURL) {
    throw new Error("Bridge did not return baseURL")
  }

  return {
    apiKey: payload.virtualKey.key,
    baseURL: payload.baseURL,
  }
}

export async function CodexVirtualKeyBridgePlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "openai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || typeof auth !== "object" || (auth as { type?: string }).type !== "oauth") {
          return {}
        }

        const oauth = auth as OAuthAuth
        const slot = cacheSlot(oauth)
        const cache = await readCache()
        let entry = cache.entries[slot]

        if (!entry) {
          const synced = await syncBridge(oauth)
          entry = {
            apiKey: synced.apiKey,
            baseURL: synced.baseURL,
            updatedAt: Date.now(),
          }
          cache.entries[slot] = entry
          await writeCache(cache)
        }

        return {
          apiKey: entry.apiKey,
          baseURL: entry.baseURL,
        }
      },
    },
  }
}
