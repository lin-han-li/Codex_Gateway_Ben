import type { Hono } from "hono"

export type DashboardRouteDeps = {
  buildDashboardMetrics: () => unknown
}

export function registerDashboardRoutes(app: Hono, deps: DashboardRouteDeps) {
  app.get("/api/dashboard/metrics", (c) => c.json({ metrics: deps.buildDashboardMetrics() }))
}
