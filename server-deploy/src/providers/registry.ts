import { createChatGPTProvider } from "./chatgpt"
import { LocalCallbackServer } from "../oauth/callback-server"
import type { OAuthProvider, OAuthProviderMethod } from "./base"
import { toPublicProvider } from "./base"

export class ProviderRegistry {
  private readonly providers: OAuthProvider[]

  constructor(callbackServer: LocalCallbackServer) {
    // Keep outbound OAuth flow aligned with Codex official behavior.
    this.providers = [createChatGPTProvider(callbackServer)]
  }

  listPublic() {
    return this.providers.map(toPublicProvider)
  }

  getProvider(providerId: string) {
    return this.providers.find((provider) => provider.id === providerId)
  }

  getMethod(providerId: string, methodId: string): { provider: OAuthProvider; method: OAuthProviderMethod } {
    const provider = this.getProvider(providerId)
    if (!provider) throw new Error(`Unknown provider: ${providerId}`)
    const method = provider.methods.find((item) => item.id === methodId)
    if (!method) throw new Error(`Unknown method "${methodId}" for provider "${providerId}"`)
    return { provider, method }
  }
}
