import { createHash } from "node:crypto"

export const ACCOUNT_BOUND_PROMPT_CACHE_KEYS_LOWER = new Set([
  "prompt_cache_key",
  "promptcachekey",
  "prompt-cache-key",
  "x-prompt-cache-key",
])

export const ACCOUNT_BOUND_SESSION_KEYS_LOWER = new Set([
  "session_id",
  "sessionid",
  "session-id",
  "x-session-id",
  "conversation_id",
  "conversationid",
  "conversation-id",
  "thread_id",
  "threadid",
  "thread-id",
  ...ACCOUNT_BOUND_PROMPT_CACHE_KEYS_LOWER,
])

export function isPromptCacheFieldKey(fieldKey?: string | null) {
  const normalized = String(fieldKey ?? "").trim().toLowerCase()
  return normalized.length > 0 && ACCOUNT_BOUND_PROMPT_CACHE_KEYS_LOWER.has(normalized)
}

export function isAccountBoundSessionFieldKey(fieldKey?: string | null) {
  const normalized = String(fieldKey ?? "").trim().toLowerCase()
  return normalized.length > 0 && ACCOUNT_BOUND_SESSION_KEYS_LOWER.has(normalized)
}

export function bindClientIdentifierToAccount(input: {
  accountId?: string | null
  fieldKey?: string | null
  value?: unknown
}) {
  const accountId = String(input.accountId ?? "").trim()
  const value = String(input.value ?? "").trim()
  if (!accountId || !value) return value

  const kind = isPromptCacheFieldKey(input.fieldKey) ? "prompt-cache" : "session"
  const prefix = kind === "prompt-cache" ? "pc_" : "sess_"
  const digest = createHash("sha256")
    .update("account-bound-session-v1")
    .update("|")
    .update(accountId)
    .update("|")
    .update(kind)
    .update("|")
    .update(value)
    .digest("hex")

  return `${prefix}${digest.slice(0, 40)}`
}
