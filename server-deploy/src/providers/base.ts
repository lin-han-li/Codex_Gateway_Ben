import type { PublicProvider, PublicProviderMethod, RefreshResult, StartAuthResult, StoredAccount } from "../types"

export type OAuthProviderMethod = {
  id: string
  label: string
  mode: "auto" | "code"
  fields?: PublicProviderMethod["fields"]
  start: (options?: Record<string, string>) => Promise<StartAuthResult>
}

export type OAuthProvider = {
  id: string
  name: string
  methods: OAuthProviderMethod[]
  refresh?: (account: StoredAccount) => Promise<RefreshResult | null>
}

export function toPublicProvider(provider: OAuthProvider): PublicProvider {
  return {
    id: provider.id,
    name: provider.name,
    methods: provider.methods.map((method) => ({
      id: method.id,
      label: method.label,
      mode: method.mode,
      fields: method.fields,
    })),
  }
}

