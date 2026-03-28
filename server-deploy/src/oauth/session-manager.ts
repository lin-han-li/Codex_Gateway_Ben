import { AppConfig } from "../config"
import { AccountStore } from "../store/db"
import { ProviderRegistry } from "../providers/registry"
import type { AuthMode } from "../types"

export type LoginSessionStatus = "pending" | "waiting_code" | "completed" | "failed"

export type PublicLoginSession = {
  id: string
  providerId: string
  providerName: string
  methodId: string
  methodLabel: string
  mode: AuthMode
  status: LoginSessionStatus
  authorizationUrl: string
  instructions: string
  accountId?: string
  error?: string
  createdAt: number
  updatedAt: number
}

type InternalLoginSession = PublicLoginSession & {
  complete: (code?: string) => Promise<import("../types").LoginResult>
}

type SessionListener = (session: PublicLoginSession) => void

export class LoginSessionManager {
  private readonly sessions = new Map<string, InternalLoginSession>()
  private readonly listeners = new Set<SessionListener>()

  constructor(
    private readonly store: AccountStore,
    private readonly providers: ProviderRegistry,
  ) {}

  subscribe(listener: SessionListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(input: { providerId: string; methodId: string; options?: Record<string, string> }) {
    this.cleanup()
    const { provider, method } = this.providers.getMethod(input.providerId, input.methodId)
    const auth = await method.start(input.options)
    const now = Date.now()
    const id = crypto.randomUUID()
    const session: InternalLoginSession = {
      id,
      providerId: provider.id,
      providerName: provider.name,
      methodId: method.id,
      methodLabel: method.label,
      mode: auth.mode,
      status: auth.mode === "code" ? "waiting_code" : "pending",
      authorizationUrl: auth.url,
      instructions: auth.instructions,
      createdAt: now,
      updatedAt: now,
      complete: auth.complete,
    }
    this.sessions.set(id, session)
    this.notify(session)

    if (auth.mode === "auto") {
      this.execute(session).catch(() => {
        // no-op, status is set in execute()
      })
    }

    return this.snapshot(session)
  }

  get(id: string) {
    this.cleanup()
    const session = this.sessions.get(id)
    if (!session) return null
    return this.snapshot(session)
  }

  async submitCode(id: string, code: string) {
    const session = this.sessions.get(id)
    if (!session) throw new Error("Login session not found")
    if (session.mode !== "code") throw new Error("This session does not accept code input")
    if (session.status !== "waiting_code") throw new Error(`Cannot submit code in session state: ${session.status}`)

    session.status = "pending"
    session.updatedAt = Date.now()
    this.notify(session)
    await this.execute(session, code)
    return this.snapshot(session)
  }

  private async execute(session: InternalLoginSession, code?: string) {
    try {
      const loginResult = await session.complete(code)
      const accountId = this.store.save({
        ...loginResult,
        providerName: session.providerName,
      })
      session.status = "completed"
      session.accountId = accountId
      session.error = undefined
      session.updatedAt = Date.now()
      this.notify(session)
    } catch (error) {
      session.status = "failed"
      session.error = error instanceof Error ? error.message : String(error)
      session.updatedAt = Date.now()
      this.notify(session)
    }
  }

  private snapshot(session: InternalLoginSession): PublicLoginSession {
    return {
      id: session.id,
      providerId: session.providerId,
      providerName: session.providerName,
      methodId: session.methodId,
      methodLabel: session.methodLabel,
      mode: session.mode,
      status: session.status,
      authorizationUrl: session.authorizationUrl,
      instructions: session.instructions,
      accountId: session.accountId,
      error: session.error,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
  }

  private cleanup() {
    const now = Date.now()
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt > AppConfig.sessionTtlMs) {
        this.sessions.delete(id)
      }
    }
  }

  private notify(session: InternalLoginSession) {
    const snapshot = this.snapshot(session)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore listener errors
      }
    }
  }
}
