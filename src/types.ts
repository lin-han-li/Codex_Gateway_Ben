export type AuthMode = "auto" | "code"

export type MethodField = {
  key: string
  label: string
  placeholder?: string
  required?: boolean
}

export type PublicProviderMethod = {
  id: string
  label: string
  mode: AuthMode
  fields?: MethodField[]
}

export type PublicProvider = {
  id: string
  name: string
  methods: PublicProviderMethod[]
}

export type StartAuthResult = {
  mode: AuthMode
  url: string
  instructions: string
  complete: (code?: string) => Promise<LoginResult>
}

export type LoginResult = {
  providerId: string
  methodId: string
  displayName: string
  accountKey: string
  email?: string
  accountId?: string
  enterpriseUrl?: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  metadata?: Record<string, unknown>
}

export type StoredAccount = {
  id: string
  providerId: string
  providerName: string
  methodId: string
  displayName: string
  accountKey: string
  email: string | null
  accountId: string | null
  enterpriseUrl: string | null
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  isActive: boolean
  metadata: Record<string, unknown>
  promptTokens: number
  completionTokens: number
  totalTokens: number
  createdAt: number
  updatedAt: number
}

export type RefreshResult = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  accountId?: string
}
