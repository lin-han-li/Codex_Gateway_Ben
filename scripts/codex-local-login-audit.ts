import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
  const oldConfig =
    'openai_base_url = "http://127.0.0.1:65260/v1"\nmodel_catalog_json = "C:\\\\Users\\\\test\\\\.codex\\\\codex-gateway-models.json"\nmodel = "gpt-5.4"\ncli_auth_credentials_store = "auto"\n'
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
  assertCondition(!config.includes("model_catalog_json"), "local OAuth login should remove gateway model catalog override")

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
