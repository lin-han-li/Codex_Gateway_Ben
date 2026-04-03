import type { Hono } from "hono"

type AuditStore = {
  listRequestAuditsPaginated: (input: {
    query: string
    statusFilter: string
    page: number
    pageSize: number
  }) => {
    items: unknown[]
    total: number
    page: number
    pageSize: number
  }
  summarizeRequestAudits: (input: {
    query: string
    statusFilter: string
  }) => unknown
  clearRequestAudits: () => void
}

export type AuditsRouteDeps = {
  accountStore: AuditStore
  normalizeAuditLog: (item: unknown) => unknown
  clearAuditOverlays: () => void
  parseHeaderNumber: (value: string | null | undefined) => number
}

export function registerAuditRoutes(app: Hono, deps: AuditsRouteDeps) {
  app.get("/api/audits", (c) => {
    const query = String(c.req.query("query") ?? c.req.query("q") ?? "").trim()
    const statusGroup = String(c.req.query("statusGroup") ?? c.req.query("status") ?? c.req.query("statusFamily") ?? "all").trim()
    const page = Math.max(1, deps.parseHeaderNumber(c.req.query("page") ?? "1") || 1)
    const pageSize = Math.min(200, Math.max(1, deps.parseHeaderNumber(c.req.query("pageSize") ?? "20") || 20))
    const result = deps.accountStore.listRequestAuditsPaginated({
      query,
      statusFilter: statusGroup,
      page,
      pageSize,
    })
    const logs = result.items.map((item) => deps.normalizeAuditLog(item))
    const summary = deps.accountStore.summarizeRequestAudits({
      query,
      statusFilter: statusGroup,
    })
    return c.json({
      logs,
      items: logs,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.page * result.pageSize < result.total,
      summary,
      filters: {
        query,
        statusGroup,
      },
    })
  })

  app.get("/api/audits/summary", (c) => {
    const query = String(c.req.query("query") ?? c.req.query("q") ?? "").trim()
    const statusGroup = String(c.req.query("statusGroup") ?? c.req.query("status") ?? c.req.query("statusFamily") ?? "all").trim()
    const summary = deps.accountStore.summarizeRequestAudits({
      query,
      statusFilter: statusGroup,
    })
    const summaryRecord = summary as Record<string, unknown>
    return c.json({
      summary,
      total: summaryRecord.filteredCount,
      filters: {
        query,
        statusGroup,
      },
    })
  })

  app.post("/api/audits/clear", (c) => {
    deps.accountStore.clearRequestAudits()
    deps.clearAuditOverlays()
    return c.json({ success: true })
  })
}
