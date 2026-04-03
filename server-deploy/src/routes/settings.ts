import type { Hono } from "hono"

export type SettingsRouteDeps<TInput> = {
  getSettings: () => unknown
  parseUpdateSettingsInput: (raw: unknown) => TInput
  saveSettings: (input: TInput) => Promise<{ settings: unknown; warnings: string[] }>
  errorMessage: (error: unknown) => string
}

export function registerSettingsRoutes<TInput>(app: Hono, deps: SettingsRouteDeps<TInput>) {
  app.get("/api/settings", (c) => c.json({ settings: deps.getSettings() }))

  app.post("/api/settings", async (c) => {
    try {
      const raw = await c.req.json()
      const input = deps.parseUpdateSettingsInput(raw)
      const output = await deps.saveSettings(input)
      return c.json({
        success: true,
        settings: output.settings,
        warnings: output.warnings,
      })
    } catch (error) {
      return c.json({ error: deps.errorMessage(error) }, 400)
    }
  })
}
