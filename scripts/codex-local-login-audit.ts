import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import { writeCodexLocalAuth } from "../src/codex-local-auth"
import type { StoredAccount } from "../src/types"

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function base64UrlJson(input: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url")
}

function fakeJwt(email: string, accountId: string, plan: string) {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson({
      email,
      chatgpt_account_id: accountId,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: plan,
      },
    }),
    "signature",
  ].join(".")
}

function makeAccount(input: {
  id: string
  email: string
  accountId: string
  accessToken: string
  refreshToken: string
  idToken: string
}): StoredAccount {
  return {
    id: input.id,
    providerId: "chatgpt",
    providerName: "ChatGPT",
    methodId: "browser",
    displayName: input.email,
    accountKey: `${input.email}::${input.accountId}`,
    email: input.email,
    accountId: input.accountId,
    enterpriseUrl: null,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken: input.idToken,
    expiresAt: Date.now() + 3600_000,
    isActive: true,
    metadata: {},
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-local-login-audit-"))
  const codexHome = path.join(tempRoot, ".codex")
  const oldAuth = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "old-key" }, null, 2)
  const oldConfig = [
    'openai_base_url = "http://127.0.0.1:65260/v1"',
    'model_provider = "codex-gateway-http"',
    'model_catalog_json = "C:\\\\Users\\\\test\\\\.codex\\\\codex-gateway-models.json"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'model = "gpt-5.4"',
    'cli_auth_credentials_store = "auto"',
    "",
    "[model_providers.codex-gateway-http]",
    'name = "Codex Gateway HTTP"',
    'base_url = "http://127.0.0.1:65260/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    "",
    "[model_providers.codex-official-http]",
    'name = "Stale Official HTTP"',
    'base_url = "http://stale-official.invalid/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = true",
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
  ].join("\n")
  const idTokenA = fakeJwt("a@example.com", "account-a", "plus")
  const idTokenB = fakeJwt("b@example.com", "account-b", "team")
  const accountA = makeAccount({
    id: "account-a-local",
    email: "a@example.com",
    accountId: "account-a",
    accessToken: "access-a",
    refreshToken: "refresh-a",
    idToken: idTokenA,
  })
  const accountB = makeAccount({
    id: "account-b-local",
    email: "b@example.com",
    accountId: "account-b",
    accessToken: "access-b",
    refreshToken: "refresh-b",
    idToken: idTokenB,
  })

  await mkdir(codexHome, { recursive: true })
  await writeFile(path.join(codexHome, "auth.json"), oldAuth, "utf8")
  await writeFile(path.join(codexHome, "config.toml"), oldConfig, "utf8")
  const stateDbPath = path.join(codexHome, "state_5.sqlite")
  const stateDb = new Database(stateDbPath)
  stateDb.run("create table threads (id text primary key, model_provider text not null)")
  stateDb.run("insert into threads (id, model_provider) values (?, ?)", ["legacy-openai", "openai"])
  stateDb.run("insert into threads (id, model_provider) values (?, ?)", ["legacy-official", "codex-official-http"])
  stateDb.run("insert into threads (id, model_provider) values (?, ?)", ["current-gateway", "codex-gateway-http"])
  stateDb.close()

  const first = await writeCodexLocalAuth({
    account: accountA,
    tokens: {
      accessToken: accountA.accessToken,
      refreshToken: accountA.refreshToken ?? "",
      idToken: accountA.idToken ?? "",
      accountId: accountA.accountId,
    },
    codexHome,
    restartCodexApp: false,
    apiBase: "http://127.0.0.1:65260/v1",
  })
  const firstAuth = JSON.parse(await readFile(path.join(codexHome, "auth.json"), "utf8"))
  assertCondition(firstAuth.auth_mode === "chatgpt", "first auth_mode should be chatgpt")
  assertCondition(firstAuth.OPENAI_API_KEY === null, "OPENAI_API_KEY should be null in chatgpt mode")
  assertCondition(firstAuth.tokens.access_token === "access-a", "first access token mismatch")
  assertCondition(firstAuth.tokens.refresh_token === "refresh-a", "first refresh token mismatch")
  assertCondition(firstAuth.tokens.id_token === idTokenA, "first id token mismatch")
  assertCondition(firstAuth.tokens.account_id === "account-a", "first account id mismatch")
  assertCondition(first.authBackupPath, "first switch should create auth backup")
  assertCondition((await readFile(first.authBackupPath!, "utf8")).includes("old-key"), "backup should contain old auth")
  assertCondition(first.configUpdated, "config should be updated from auto to file")
  assertCondition(first.configBackupPath, "config backup should exist")
  const config = await readFile(path.join(codexHome, "config.toml"), "utf8")
  assertCondition(config.includes('cli_auth_credentials_store = "file"'), "config should force file credential store")
  assertCondition(!config.includes("openai_base_url"), "local OAuth login should remove API base URL override")
  assertCondition(
    config.includes('model_provider = "codex-gateway-http"'),
    "local OAuth login should keep the shared HTTP-only provider id for thread list compatibility",
  )
  assertCondition(
    config.includes("[model_providers.codex-gateway-http]"),
    "local OAuth login should write the shared HTTP-only provider block",
  )
  assertCondition(
    config.includes('base_url = "http://127.0.0.1:65260/v1"'),
    "local OAuth login should direct the shared provider to the gateway for account routing",
  )
  assertCondition(
    config.includes("supports_websockets = false") && !config.includes('base_url = "http://stale-official.invalid/v1"'),
    "local OAuth login should keep account mode HTTP-only without stale provider values",
  )
  assertCondition(
    !config.includes('base_url = "https://api.openai.com/v1"'),
    "local OAuth login should not route Codex account mode directly to OpenAI API scopes",
  )
  assertCondition(!config.includes("[model_providers.codex-official-http]"), "local OAuth login should remove old split provider")
  const migratedStateDb = new Database(stateDbPath, { readonly: true })
  const providerRows = migratedStateDb.query("select id, model_provider from threads order by id").all() as Array<{
    id: string
    model_provider: string
  }>
  migratedStateDb.close()
  assertCondition(
    providerRows.every((row) => row.model_provider === "codex-gateway-http"),
    "local OAuth login should migrate legacy thread provider ids to the shared HTTP-only provider",
  )
  assertCondition(
    first.threadProviderMigration?.updated === 2 && first.threadProviderMigration.backupPath,
    "local OAuth login should report a backed-up provider compatibility migration",
  )
  assertCondition(!config.includes("model_catalog_json"), "local OAuth login should remove gateway model catalog override")
  assertCondition(!config.includes("approval_policy"), "local OAuth login should remove gateway approval policy override")
  assertCondition(!config.includes("sandbox_mode"), "local OAuth login should remove gateway sandbox mode override")
  assertCondition(config.includes('sandbox = "elevated"'), "local OAuth login should preserve existing official Windows sandbox mode")

  const second = await writeCodexLocalAuth({
    account: accountB,
    tokens: {
      accessToken: accountB.accessToken,
      refreshToken: accountB.refreshToken ?? "",
      idToken: accountB.idToken ?? "",
      accountId: accountB.accountId,
    },
    codexHome,
    restartCodexApp: false,
    apiBase: "http://127.0.0.1:65260/v1",
  })
  const secondAuth = JSON.parse(await readFile(path.join(codexHome, "auth.json"), "utf8"))
  assertCondition(secondAuth.tokens.access_token === "access-b", "second access token mismatch")
  assertCondition(secondAuth.tokens.refresh_token === "refresh-b", "second refresh token mismatch")
  assertCondition(secondAuth.tokens.id_token === idTokenB, "second id token mismatch")
  assertCondition(secondAuth.tokens.account_id === "account-b", "second account id mismatch")
  assertCondition(second.authBackupPath, "second switch should create auth backup")
  assertCondition((await readFile(second.authBackupPath!, "utf8")).includes("access-a"), "second backup should contain previous auth")

  const visibleResult = JSON.stringify({ first, second })
  for (const secret of ["access-a", "refresh-a", idTokenA, "access-b", "refresh-b", idTokenB]) {
    assertCondition(!visibleResult.includes(secret), `result should not expose secret: ${secret.slice(0, 12)}`)
  }

  console.log("[codex-local-login-audit] passed")
  console.log(`[codex-local-login-audit] temp=${tempRoot}`)
  await rm(tempRoot, { recursive: true, force: true })
}

main().catch((error) => {
  console.error("[codex-local-login-audit] failed")
  console.error(error)
  process.exitCode = 1
})
