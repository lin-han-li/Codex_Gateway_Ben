import type { Hono } from "hono"

export type LoginRouteDeps = {
  loginSessions: {
    start: (input: any) => Promise<any>
    get: (id: string) => any
    submitCode: (id: string, code: string) => Promise<any>
  }
  parseStartLoginInput: (raw: unknown) => any
  parseCodeInput: (raw: unknown) => { code: string }
  errorMessage: (error: unknown) => string
}

export function registerLoginRoutes(app: Hono, deps: LoginRouteDeps) {
  app.post("/api/login/start", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.parseStartLoginInput(raw)
      const session = await deps.loginSessions.start(input)
      return c.json({ session })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })

  app.get("/api/login/sessions/:id", async (c) => {
    const id = c.req.param("id")
    const session = deps.loginSessions.get(id)
    if (!session) {
      return c.json({ error: "Login session not found" }, 404)
    }
    return c.json({ session })
  })

  app.post("/api/login/sessions/:id/code", async (c) => {
    const id = c.req.param("id")
    try {
      const raw = await c.req.json()
      const input = deps.parseCodeInput(raw)
      const session = await deps.loginSessions.submitCode(id, input.code)
      return c.json({ session })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })
}
