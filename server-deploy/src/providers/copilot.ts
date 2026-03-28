import { setTimeout as sleep } from "node:timers/promises"
import type { OAuthProvider } from "./base"

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const POLL_MARGIN_MS = 3000

function normalizeDomain(input: string) {
  return input.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  }
}

async function fetchGitHubProfile(domain: string, token: string) {
  const url = domain === "github.com" ? "https://api.github.com/user" : `https://${domain}/api/v3/user`
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "oauth-multi-login-app",
    },
  }).catch(() => undefined)
  if (!response?.ok) return null
  return (await response.json()) as { id?: number; login?: string; email?: string; name?: string }
}

async function startDeviceFlow(domain: string, enterprise = false) {
  const urls = getUrls(domain)
  const deviceResponse = await fetch(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "oauth-multi-login-app",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  })
  if (!deviceResponse.ok) {
    throw new Error(`Failed to start device flow (${deviceResponse.status})`)
  }
  const deviceData = (await deviceResponse.json()) as {
    verification_uri: string
    user_code: string
    device_code: string
    interval: number
  }

  return {
    mode: "auto" as const,
    url: deviceData.verification_uri,
    instructions: `Enter code: ${deviceData.user_code}`,
    complete: async () => {
      let intervalMs = Math.max(1, deviceData.interval || 5) * 1000
      const deadline = Date.now() + 10 * 60 * 1000

      while (Date.now() < deadline) {
        const tokenResponse = await fetch(urls.accessTokenUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": "oauth-multi-login-app",
          },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            device_code: deviceData.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        })
        if (!tokenResponse.ok) {
          throw new Error(`Token polling failed (${tokenResponse.status})`)
        }
        const payload = (await tokenResponse.json()) as {
          access_token?: string
          error?: string
          interval?: number
        }

        if (payload.access_token) {
          const profile = await fetchGitHubProfile(domain, payload.access_token)
          const accountKey =
            profile?.id?.toString() ||
            profile?.login ||
            (enterprise ? `copilot-enterprise-${domain}` : `copilot-${domain}`) + "-" + crypto.randomUUID()
          const displayName = profile?.name || profile?.login || (enterprise ? `${domain} Copilot` : "GitHub Copilot")
          return {
            providerId: "github-copilot",
            methodId: enterprise ? "enterprise" : "github",
            displayName,
            accountKey,
            email: profile?.email,
            accessToken: payload.access_token,
            refreshToken: payload.access_token,
            enterpriseUrl: enterprise ? domain : undefined,
            metadata: {
              domain,
              enterprise,
              flow: "device-code",
            },
          }
        }

        if (payload.error === "authorization_pending") {
          await sleep(intervalMs + POLL_MARGIN_MS)
          continue
        }

        if (payload.error === "slow_down") {
          intervalMs = ((payload.interval && payload.interval > 0 ? payload.interval : deviceData.interval + 5) || 10) * 1000
          await sleep(intervalMs + POLL_MARGIN_MS)
          continue
        }

        throw new Error(payload.error ? `Authorization failed: ${payload.error}` : "Authorization failed")
      }

      throw new Error("Device authorization timed out")
    },
  }
}

export function createCopilotProvider(): OAuthProvider {
  return {
    id: "github-copilot",
    name: "GitHub Copilot",
    methods: [
      {
        id: "github",
        label: "GitHub.com Device Login",
        mode: "auto",
        start: () => startDeviceFlow("github.com", false),
      },
      {
        id: "enterprise",
        label: "Enterprise Device Login",
        mode: "auto",
        fields: [
          {
            key: "enterpriseUrl",
            label: "Enterprise URL or domain",
            placeholder: "company.ghe.com",
            required: true,
          },
        ],
        start: (options) => {
          const raw = options?.enterpriseUrl
          if (!raw) {
            throw new Error("enterpriseUrl is required")
          }
          return startDeviceFlow(normalizeDomain(raw), true)
        },
      },
    ],
    refresh: async () => {
      // GitHub device flow token in this scenario has no refresh endpoint in our flow.
      return null
    },
  }
}

