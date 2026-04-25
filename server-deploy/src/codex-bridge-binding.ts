function normalizeNonEmpty(value: unknown) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : ""
}

function normalizeLower(value: unknown) {
  const normalized = normalizeNonEmpty(value).toLowerCase()
  return normalized || ""
}

function parseJwtPayload(token?: string | null) {
  const value = normalizeNonEmpty(token)
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 3) return null

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function asObjectRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function pushBindingKey(keys: string[], prefix: string, value: unknown) {
  const normalized = prefix === "email" ? normalizeLower(value) : normalizeNonEmpty(value)
  if (!normalized) return
  const key = `${prefix}:${normalized}`
  if (!keys.includes(key)) keys.push(key)
}

export function buildCodexOAuthBridgeBindingKeys(input: {
  accessToken?: string | null
  idToken?: string | null
  accountId?: string | null
  email?: string | null
}) {
  const keys: string[] = []
  for (const token of [input.accessToken, input.idToken]) {
    const payload = parseJwtPayload(token)
    const auth = asObjectRecord(payload?.["https://api.openai.com/auth"])
    const profile = asObjectRecord(payload?.["https://api.openai.com/profile"])
    pushBindingKey(keys, "account", auth?.chatgpt_account_id)
    pushBindingKey(keys, "account", auth?.account_id)
    pushBindingKey(keys, "account", auth?.organization_id)
    pushBindingKey(keys, "user", auth?.chatgpt_user_id)
    pushBindingKey(keys, "user", auth?.user_id)
    pushBindingKey(keys, "user", payload?.sub)
    pushBindingKey(keys, "email", profile?.email)
    pushBindingKey(keys, "email", payload?.email)
  }
  pushBindingKey(keys, "account", input.accountId)
  pushBindingKey(keys, "email", input.email)
  return keys
}

