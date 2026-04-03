export function createLogsView(deps) {
  const {
    S,
    api,
    beginSync,
    finishSyncSuccess,
    finishSyncError,
    coerceAuditSummary,
    requestLogStatusMeta,
    formatRequestLogAccount,
    formatRequestLogKey,
    formatLatencyMs,
    formatCompactNumber,
    formatUsd,
    dt,
    esc,
    makeId,
    renderTodayStats,
    renderSettingsReadOnly,
  } = deps

  function drawRequestLogsTable() {
    const tbody = document.getElementById("requestLogsTableBody")
    const meta = document.getElementById("requestLogsMeta")
    const summary = document.getElementById("requestLogsSummary")
    const pageInfo = document.getElementById("requestLogsPageInfo")
    const prevBtn = document.getElementById("requestLogPrev")
    const nextBtn = document.getElementById("requestLogNext")
    const statusSelect = document.getElementById("requestLogStatusFilter")
    const pageSizeSelect = document.getElementById("requestLogPageSize")
    if (!tbody || !meta || !summary || !pageInfo || !prevBtn || !nextBtn) return
    if (statusSelect) statusSelect.value = String(S.requestLogStatus || "all")
    if (pageSizeSelect) pageSizeSelect.value = String(S.requestLogPageSize || 20)

    const pageSize = Math.max(1, Math.floor(Number(S.requestLogPageSize || 20)))
    const total = Math.max(0, Math.floor(Number(S.requestLogsTotal || 0)))
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    if (S.requestLogPage > totalPages) S.requestLogPage = totalPages
    if (S.requestLogPage < 1) S.requestLogPage = 1
    const pageRows = Array.isArray(S.requestLogs) ? S.requestLogs : []

    if (S.requestLogBusyVisible && !pageRows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-placeholder">正在同步请求日志...</td></tr>'
    } else if (S.requestLogError && !pageRows.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-placeholder">请求日志读取失败：${esc(S.requestLogError)}</td></tr>`
    } else if (!pageRows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-placeholder">暂无匹配的请求日志</td></tr>'
    } else {
      tbody.innerHTML = pageRows
        .map((row) => {
          const statusMeta = requestLogStatusMeta(row)
          const model = String(row?.model || "").trim() || "-"
          const reasoningEffort = String(row?.reasoningEffort || "").trim()
          const errorText = String(row?.error || "").trim()
          const totalTokens = Math.max(0, Math.floor(Number(row?.totalTokens || 0)))
          const inputTokens = Math.max(0, Math.floor(Number(row?.inputTokens || 0)))
          const cachedTokens = Math.max(0, Math.floor(Number(row?.cachedInputTokens || 0)))
          const tokenText =
            totalTokens > 0 || inputTokens > 0 || cachedTokens > 0
              ? `${formatCompactNumber(totalTokens)} / ${formatCompactNumber(inputTokens)} / ${formatCompactNumber(cachedTokens)}`
              : "-"
          const estimatedCostText =
            row?.estimatedCostUsd === null || row?.estimatedCostUsd === undefined
              ? "-"
              : formatUsd(row.estimatedCostUsd)
          return `
            <tr>
              <td>${esc(dt(row?.at))}</td>
              <td><div><strong>${esc(String(row?.method || "-").toUpperCase())}</strong></div><div class="muted">${esc(String(row?.route || "-"))}</div></td>
              <td><div>${esc(formatRequestLogAccount(row?.accountId))}</div><div class="muted">${esc(formatRequestLogKey(row?.virtualKeyId))}</div></td>
              <td><div>${esc(model)}</div><div class="muted">${esc(reasoningEffort || "-")}</div></td>
              <td><span class="${statusMeta.className}">${esc(statusMeta.text)}</span></td>
              <td>${esc(formatLatencyMs(row?.latencyMs))}</td>
              <td class="mono">${esc(tokenText)}</td>
              <td class="mono">${esc(estimatedCostText)}</td>
              <td class="request-error" title="${esc(errorText)}">${esc(errorText || "-")}</td>
            </tr>
          `
        })
        .join("")
    }

    const summaryMetrics = coerceAuditSummary(S.auditSummary)
    if (meta) {
      if (S.requestLogError) meta.textContent = `请求日志读取失败：${S.requestLogError}`
      else if (S.requestLogBusyVisible) meta.textContent = "请求日志同步中..."
      else meta.textContent = `已加载 ${formatCompactNumber(pageRows.length)} 条 / 总计 ${formatCompactNumber(total)} 条，更新时间 ${dt(S.requestLogsLoadedAt || Date.now())}`
    }
    if (summary) {
      summary.textContent = `筛选命中 ${formatCompactNumber(summaryMetrics.filteredCount || total)} 条，成功 ${formatCompactNumber(summaryMetrics.successCount)}，异常 ${formatCompactNumber(summaryMetrics.errorCount)}，Token ${formatCompactNumber(summaryMetrics.totalTokens)}`
    }
    if (pageInfo) pageInfo.textContent = `第 ${S.requestLogPage} / ${totalPages} 页`
    prevBtn.disabled = S.requestLogPage <= 1
    nextBtn.disabled = S.requestLogPage >= totalPages
  }

  async function loadRequestLogs(options = {}) {
    const silent = options.silent === true
    if (S.requestLogLoading) return
    if (!silent) beginSync()
    S.requestLogLoading = true
    S.requestLogBusyVisible = !silent
    S.requestLogError = ""
    if (!silent) {
      drawRequestLogsTable()
      renderTodayStats()
      renderSettingsReadOnly()
    }
    try {
      const query = new URLSearchParams()
      if (S.requestLogQuery) query.set("query", String(S.requestLogQuery || "").trim())
      query.set("statusGroup", String(S.requestLogStatus || "all"))
      query.set("page", String(Math.max(1, Math.floor(Number(S.requestLogPage || 1)))))
      query.set("pageSize", String(Math.max(1, Math.floor(Number(S.requestLogPageSize || 20)))))
      const output = await api(`/api/audits?${query.toString()}`)
      S.requestLogs = Array.isArray(output?.logs)
        ? output.logs.map((item) => ({
            id: item?.id || makeId(),
            at: Number(item?.at || 0),
            route: String(item?.route || ""),
            method: String(item?.method || ""),
            providerId: String(item?.providerId || ""),
            accountId: String(item?.accountId || ""),
            virtualKeyId: String(item?.virtualKeyId || ""),
            model: String(item?.model || ""),
            sessionId: String(item?.sessionId || ""),
            requestHash: String(item?.requestHash || ""),
            requestBytes: Math.max(0, Math.floor(Number(item?.requestBytes || 0))),
            responseBytes: Math.max(0, Math.floor(Number(item?.responseBytes || 0))),
            statusCode: Math.max(0, Math.floor(Number(item?.statusCode || 0))),
            latencyMs: Math.max(0, Math.floor(Number(item?.latencyMs || 0))),
            upstreamRequestId: String(item?.upstreamRequestId || ""),
            error: String(item?.error || ""),
            clientTag: String(item?.clientTag || ""),
            inputTokens: Math.max(0, Math.floor(Number(item?.inputTokens || 0))),
            cachedInputTokens: Math.max(0, Math.floor(Number(item?.cachedInputTokens || 0))),
            outputTokens: Math.max(0, Math.floor(Number(item?.outputTokens || 0))),
            totalTokens: Math.max(0, Math.floor(Number(item?.totalTokens || 0))),
            reasoningOutputTokens: Math.max(0, Math.floor(Number(item?.reasoningOutputTokens || 0))),
            estimatedCostUsd:
              item?.estimatedCostUsd === null || item?.estimatedCostUsd === undefined
                ? null
                : Number(item.estimatedCostUsd || 0),
            reasoningEffort: String(item?.reasoningEffort || ""),
          }))
        : []
      S.requestLogsTotal = Math.max(0, Math.floor(Number(output?.total || 0)))
      S.requestLogPage = Math.max(1, Math.floor(Number(output?.page || S.requestLogPage || 1)))
      S.requestLogPageSize = Math.max(1, Math.floor(Number(output?.pageSize || S.requestLogPageSize || 20)))
      S.auditSummary = coerceAuditSummary(output?.summary)
      S.requestLogsLoadedAt = Date.now()
      if (!silent) finishSyncSuccess()
    } catch (error) {
      S.requestLogError = error instanceof Error ? error.message : String(error)
      if (!silent) finishSyncError("请求日志同步失败，正在重试...")
      if (options.rethrow) throw error
    } finally {
      S.requestLogLoading = false
      S.requestLogBusyVisible = false
      drawRequestLogsTable()
      renderTodayStats()
      renderSettingsReadOnly()
    }
  }

  return {
    drawRequestLogsTable,
    loadRequestLogs,
  }
}
