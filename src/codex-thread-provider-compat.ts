import { Database } from "bun:sqlite"
import path from "node:path"
import { copyFile, readFile } from "node:fs/promises"

export const CODEX_HTTP_PROVIDER_ID = "codex-gateway-http"
export const LEGACY_CODEX_THREAD_PROVIDER_IDS = ["openai", "codex-official-http"]

export type CodexThreadProviderMigrationResult = {
  statePath: string
  updated: number
  backupPath: string | null
  skipped?: string
}

async function fileExists(filePath: string) {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ")
}

export async function migrateCodexThreadProvidersForHttpCompat(input: {
  codexHome: string
  stamp: string
  targetProviderId?: string
  legacyProviderIds?: string[]
}): Promise<CodexThreadProviderMigrationResult> {
  const targetProviderId = input.targetProviderId ?? CODEX_HTTP_PROVIDER_ID
  const legacyProviderIds = input.legacyProviderIds ?? LEGACY_CODEX_THREAD_PROVIDER_IDS
  const statePath = path.join(input.codexHome, "state_5.sqlite")
  if (!(await fileExists(statePath))) {
    return { statePath, updated: 0, backupPath: null, skipped: "state db not found" }
  }
  if (legacyProviderIds.length === 0) {
    return { statePath, updated: 0, backupPath: null, skipped: "no legacy provider ids" }
  }

  const db = new Database(statePath)
  let dbClosed = false
  try {
    const columns = db.query("pragma table_info(threads)").all() as Array<{ name?: string }>
    if (!columns.some((column) => column.name === "model_provider")) {
      return { statePath, updated: 0, backupPath: null, skipped: "threads.model_provider not found" }
    }

    const where = placeholders(legacyProviderIds.length)
    const countRow = db
      .query(`select count(*) as count from threads where model_provider in (${where})`)
      .get(...legacyProviderIds) as { count?: number } | null
    const pending = Number(countRow?.count ?? 0)
    if (pending <= 0) {
      return { statePath, updated: 0, backupPath: null, skipped: "no legacy provider threads" }
    }

    const parsed = path.parse(statePath)
    const backupPath = path.join(parsed.dir, `${parsed.name}.provider-compat.backup.${input.stamp}${parsed.ext}`)
    db.close()
    dbClosed = true
    await copyFile(statePath, backupPath)

    const writeDb = new Database(statePath)
    try {
      writeDb
        .query(`update threads set model_provider = ? where model_provider in (${where})`)
        .run(...([targetProviderId, ...legacyProviderIds] as [string, ...string[]]))
      return { statePath, updated: pending, backupPath }
    } finally {
      writeDb.close()
    }
  } finally {
    if (!dbClosed) db.close()
  }
}
