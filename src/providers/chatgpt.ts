import { setTimeout as sleep } from "node:timers/promises"
import type { OAuthProvider } from "./base"
import { LocalCallbackServer } from "../oauth/callback-server"
import { resolveCodexClientVersion } from "../codex-version"
import { buildCodexUserAgent } from "../codex-identity"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const POLL_MARGIN_MS = 3000
const CODEX_ORIGINATOR = process.env.OAUTH_CODEX_ORIGINATOR ?? "codex_cli_rs"
const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const USER_AGENT = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)
const FORCED_WORKSPACE_ID = String(process.env.OAUTH_CODEX_ALLOWED_WORKSPACE_ID ?? "").trim()

type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

type ProfileClaims = {
  email?: string
}

type AuthClaims = {
  chatgpt_plan_type?: string
  chatgpt_user_id?: string
  user_id?: string
  chatgpt_account_id?: string
  organization_id?: string
  project_id?: string
  completed_platform_onboarding?: boolean
  is_org_owner?: boolean
}

type Claims = {
  email?: string
  chatgpt_account_id?: string
  organization_id?: string
  project_id?: string
  completed_platform_onboarding?: boolean
  is_org_owner?: boolean
  "https://api.openai.com/profile"?: ProfileClaims
  "https://api.openai.com/auth"?: AuthClaims
}

function base64UrlEncode(input: ArrayBuffer) {
  const bytes = new Uint8Array(input)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function generatePKCE() {
  // Match codex-official: 64 random bytes -> base64url(no padding) verifier.
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)).buffer)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(hash) }
}

function parseClaims(token?: string): Claims | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Claims
  } catch {
    return null
  }
}

function extractAccountAndEmail(tokens: TokenResponse) {
  const idClaims = parseClaims(tokens.id_token)
  const idAuth = idClaims?.["https://api.openai.com/auth"] as AuthClaims | undefined
  const accountId = normalizeIdentity(idClaims?.chatgpt_account_id) || normalizeIdentity(idAuth?.chatgpt_account_id)
  const email = normalizeIdentity(idClaims?.email) || normalizeIdentity(idClaims?.["https://api.openai.com/profile"]?.email)

  return {
    accountId,
    email,
    chatgptUserId: normalizeIdentity(idAuth?.chatgpt_user_id) || normalizeIdentity(idAuth?.user_id),
    chatgptPlanType: normalizeIdentity(idAuth?.chatgpt_plan_type),
    organizationId: normalizeIdentity(idAuth?.organization_id) || normalizeIdentity(idClaims?.organization_id),
    projectId: normalizeIdentity(idAuth?.project_id) || normalizeIdentity(idClaims?.project_id),
    completedPlatformOnboarding:
      typeof idAuth?.completed_platform_onboarding === "boolean"
        ? idAuth.completed_platform_onboarding
        : typeof idClaims?.completed_platform_onboarding === "boolean"
          ? idClaims.completed_platform_onboarding
          : undefined,
    isOrgOwner:
      typeof idAuth?.is_org_owner === "boolean"
        ? idAuth.is_org_owner
        : typeof idClaims?.is_org_owner === "boolean"
          ? idClaims.is_org_owner
          : undefined,
  }
}

function normalizeIdentity(value?: string | null) {
  const normalized = String(value ?? "").trim()
  return normalized.length > 0 ? normalized : undefined
}

function encodeQueryPairs(pairs: Array<[string, string]>) {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")
}

function buildAccountKey(details: { accountId?: string; email?: string }) {
  const accountId = normalizeIdentity(details.accountId)
  const email = normalizeIdentity(details.email)?.toLowerCase()
  if (email && accountId) return `${email}::${accountId}`
  return email || accountId || crypto.randomUUID()
}

function ensureWorkspaceAllowed(accountId?: string) {
  if (!FORCED_WORKSPACE_ID) return
  if (!accountId) {
    throw new Error(
      `Login is restricted to workspace id ${FORCED_WORKSPACE_ID}, but token is missing chatgpt_account_id.`,
    )
  }
  if (accountId !== FORCED_WORKSPACE_ID) {
    throw new Error(`Login is restricted to workspace id ${FORCED_WORKSPACE_ID}.`)
  }
}

function buildAuthMetadata(
  flow: string,
  details: {
    chatgptUserId?: string
    chatgptPlanType?: string
    organizationId?: string
    projectId?: string
    completedPlatformOnboarding?: boolean
    isOrgOwner?: boolean
  },
) {
  return {
    issuer: ISSUER,
    flow,
    chatgptUserId: details.chatgptUserId,
    chatgptPlanType: details.chatgptPlanType,
    organizationId: details.organizationId,
    projectId: details.projectId,
    completedPlatformOnboarding: details.completedPlatformOnboarding,
    isOrgOwner: details.isOrgOwner,
  }
}

function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string) {
  const pairs: Array<[string, string]> = [
    ["response_type", "code"],
    ["client_id", CLIENT_ID],
    ["redirect_uri", redirectUri],
    ["scope", "openid profile email offline_access api.connectors.read api.connectors.invoke"],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"],
    ["state", state],
    ["originator", CODEX_ORIGINATOR],
  ]
  if (FORCED_WORKSPACE_ID) {
    pairs.push(["allowed_workspace_id", FORCED_WORKSPACE_ID])
  }
  return `${ISSUER}/oauth/authorize?${encodeQueryPairs(pairs)}`
}

function extractAuthorizationCode(input: string) {
  const value = String(input ?? "").trim()
  if (!value) {
    throw new Error("Authorization code is required")
  }

  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value)
    const code = parsed.searchParams.get("code")
    if (!code) throw new Error("No code parameter found in callback URL")
    return {
      code,
      state: parsed.searchParams.get("state") ?? undefined,
    }
  }

  if (value.includes("code=")) {
    const query = value.startsWith("?") ? value.slice(1) : value
    const params = new URLSearchParams(query)
    const code = params.get("code")
    if (!code) throw new Error("No code parameter found in callback URL")
    return {
      code,
      state: params.get("state") ?? undefined,
    }
  }

  return {
    code: value,
    state: undefined,
  }
}

async function exchangeCodeForTokens(code: string, redirectUri: string, verifier: string): Promise<TokenResponse> {
  const body = encodeQueryPairs([
    ["grant_type", "authorization_code"],
    ["code", code],
    ["redirect_uri", redirectUri],
    ["client_id", CLIENT_ID],
    ["code_verifier", verifier],
  ])
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return (await response.json()) as TokenResponse
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      originator: CODEX_ORIGINATOR,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return (await response.json()) as TokenResponse
}

export function createChatGPTProvider(callbackServer: LocalCallbackServer): OAuthProvider {
  return {
    id: "chatgpt",
    name: "ChatGPT",
    methods: [
      {
        id: "browser",
        label: "ChatGPT Pro/Plus (browser)",
        mode: "auto",
        start: async () => {
          await callbackServer.ensureRunning()
          const pkce = await generatePKCE()
          const state = callbackServer.createState()
          const callbackPromise = callbackServer.waitForCode(state)
          const authUrl = buildAuthorizeUrl(callbackServer.redirectUrl, pkce.challenge, state)

          return {
            mode: "auto",
            url: authUrl,
            instructions: "Complete authorization in your browser. This window will close automatically.",
            complete: async () => {
              const code = await callbackPromise
              const tokens = await exchangeCodeForTokens(code, callbackServer.redirectUrl, pkce.verifier)
              await callbackServer.stop()
              const details = extractAccountAndEmail(tokens)
              ensureWorkspaceAllowed(details.accountId)
              return {
                providerId: "chatgpt",
                methodId: "browser",
                displayName: details.email || details.accountId || "ChatGPT Account",
                accountKey: buildAccountKey(details),
                email: details.email,
                accountId: details.accountId,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                metadata: buildAuthMetadata("pkce-browser", details),
              }
            },
          }
        },
      },
      {
        id: "manual-code",
        label: "ChatGPT Pro/Plus (manual code)",
        mode: "code",
        start: async () => {
          await callbackServer.stop().catch(() => undefined)
          const pkce = await generatePKCE()
          // Match codex-official state style: 32 random bytes base64url(no padding).
          const state = callbackServer.createState()
          const redirectUri = callbackServer.redirectUrl
          const authUrl = buildAuthorizeUrl(redirectUri, pkce.challenge, state)

          return {
            mode: "code",
            url: authUrl,
            instructions: "Complete authorization in your browser, then paste the callback URL (or code) here.",
            complete: async (rawCode?: string) => {
              const authPayload = extractAuthorizationCode(rawCode ?? "")
              if (authPayload.state && authPayload.state !== state) {
                throw new Error("Invalid state - potential CSRF attack")
              }
              const tokens = await exchangeCodeForTokens(authPayload.code, redirectUri, pkce.verifier)
              const details = extractAccountAndEmail(tokens)
              ensureWorkspaceAllowed(details.accountId)
              return {
                providerId: "chatgpt",
                methodId: "manual-code",
                displayName: details.email || details.accountId || "ChatGPT Account",
                accountKey: buildAccountKey(details),
                email: details.email,
                accountId: details.accountId,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                metadata: buildAuthMetadata("pkce-manual-code", details),
              }
            },
          }
        },
      },
      {
        id: "headless",
        label: "ChatGPT Pro/Plus (headless)",
        mode: "auto",
        start: async () => {
          const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ client_id: CLIENT_ID }),
          })
          if (!response.ok) {
            throw new Error("Failed to initiate device authorization")
          }
          const payload = (await response.json()) as {
            device_auth_id: string
            user_code: string
            interval: string
          }
          const intervalMs = Math.max(1, Number.parseInt(payload.interval, 10) || 5) * 1000
          return {
            mode: "auto",
            url: `${ISSUER}/codex/device`,
            instructions: `Enter code: ${payload.user_code}`,
            complete: async () => {
              while (true) {
                const pollResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    device_auth_id: payload.device_auth_id,
                    user_code: payload.user_code,
                  }),
                })

                if (pollResponse.ok) {
                  const pollData = (await pollResponse.json()) as {
                    authorization_code: string
                    code_verifier: string
                  }
                  const tokens = await exchangeCodeForTokens(
                    pollData.authorization_code,
                    `${ISSUER}/deviceauth/callback`,
                    pollData.code_verifier,
                  )
                  const details = extractAccountAndEmail(tokens)
                  ensureWorkspaceAllowed(details.accountId)
                  return {
                    providerId: "chatgpt",
                    methodId: "headless",
                    displayName: details.email || details.accountId || "ChatGPT Account",
                    accountKey: buildAccountKey(details),
                    email: details.email,
                    accountId: details.accountId,
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    metadata: buildAuthMetadata("device-headless", details),
                  }
                }

                if (pollResponse.status !== 403 && pollResponse.status !== 404) {
                  throw new Error("Device authorization failed")
                }

                await sleep(intervalMs + POLL_MARGIN_MS)
              }
            },
          }
        },
      },
    ],
    refresh: async (account) => {
      if (!account.refreshToken) {
        return null
      }
      const tokens = await refreshAccessToken(account.refreshToken)
      const details = extractAccountAndEmail(tokens)
      const nextAccountId = details.accountId ?? account.accountId ?? undefined
      ensureWorkspaceAllowed(nextAccountId)
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? account.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId: nextAccountId,
      }
    },
  }
}
