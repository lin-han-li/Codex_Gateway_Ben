export function createDashboardView(deps) {
  const {
    S,
    api,
    beginSync,
    finishSyncSuccess,
    finishSyncError,
    coerceDashboardMetrics,
    normalizeTokenDelta,
    drawStats,
    drawTokenUsage,
    formatCompactNumber,
    formatUsd,
    dt,
    renderSettingsReadOnly,
  } = deps

  async function loadDashboardMetrics(options = {}) {
    const silent = options.silent === true
    if (!silent) beginSync()
    try {
      const output = await api("/api/dashboard/metrics")
      const metricsPayload = output?.metrics || {}
      S.dashboardMetrics = coerceDashboardMetrics(metricsPayload)
      S.usageTotals = {
        promptTokens: normalizeTokenDelta(metricsPayload?.usageTotals?.promptTokens),
        completionTokens: normalizeTokenDelta(metricsPayload?.usageTotals?.completionTokens),
        totalTokens: normalizeTokenDelta(metricsPayload?.usageTotals?.totalTokens),
        estimatedCostUsd: Math.max(0, Number(metricsPayload?.usageTotals?.estimatedCostUsd || 0)),
        updatedAt: normalizeTokenDelta(metricsPayload?.usageTotals?.updatedAt),
      }
      drawStats()
      drawTokenUsage()
      renderTodayStats()
      renderSettingsReadOnly()
      if (!silent) finishSyncSuccess()
    } catch (error) {
      if (!silent) finishSyncError("仪表盘统计同步失败，正在重试...")
      throw error
    }
  }

  function renderTodayStats() {
    const metrics = coerceDashboardMetrics(S.dashboardMetrics)
    const pool = metrics.poolRemaining || {}
    const hint = document.getElementById("todayStatsHint")
    const todayTokensEl = document.getElementById("todayTokens")
    const cachedTokensEl = document.getElementById("todayCachedTokens")
    const reasoningTokensEl = document.getElementById("todayReasoningTokens")
    const estimatedCostEl = document.getElementById("todayEstimatedCost")
    const requestCountEl = document.getElementById("todayRequestCount")
    if (todayTokensEl) todayTokensEl.textContent = formatCompactNumber(metrics.todayTokens)
    if (cachedTokensEl) cachedTokensEl.textContent = formatCompactNumber(metrics.cachedInputTokens)
    if (reasoningTokensEl) reasoningTokensEl.textContent = formatCompactNumber(metrics.reasoningOutputTokens)
    if (estimatedCostEl) {
      estimatedCostEl.textContent = formatUsd(metrics.estimatedCostUsd)
      estimatedCostEl.dataset.unpriced = metrics.unpricedRequestCount > 0 ? "true" : "false"
    }
    if (requestCountEl) requestCountEl.textContent = formatCompactNumber(metrics.todayRequestCount)

    const todayTokensMeta = document.getElementById("todayTokensMeta")
    if (todayTokensMeta) {
      todayTokensMeta.textContent = `输入 - 缓存 + 输出 | 时区 ${metrics.statsTimezone || "-"}`
    }
    const cachedTokensMeta = document.getElementById("todayCachedTokensMeta")
    if (cachedTokensMeta) {
      cachedTokensMeta.textContent =
        metrics.cachedInputTokens > 0 ? "上下文缓存命中" : "今日暂无缓存命中"
    }
    const reasoningTokensMeta = document.getElementById("todayReasoningTokensMeta")
    if (reasoningTokensMeta) {
      reasoningTokensMeta.textContent =
        metrics.reasoningOutputTokens > 0 ? "模型思考输出" : "今日暂无推理输出"
    }
    const estimatedCostMeta = document.getElementById("todayEstimatedCostMeta")
    if (estimatedCostMeta) {
      estimatedCostMeta.textContent =
        metrics.unpricedRequestCount > 0
          ? `部分未估价（${formatCompactNumber(metrics.unpricedRequestCount)}）`
          : "按内置价格表估算"
    }
    const requestCountMeta = document.getElementById("todayRequestCountMeta")
    if (requestCountMeta) requestCountMeta.textContent = "请求日志计数"

    const primaryProgress = document.getElementById("todayPoolPrimaryBar")
    const secondaryProgress = document.getElementById("todayPoolSecondaryBar")
    const primaryValue = document.getElementById("todayPoolPrimaryValue")
    const secondaryValue = document.getElementById("todayPoolSecondaryValue")
    const poolKnownValue = document.getElementById("todayPoolMeta")
    if (primaryProgress) {
      primaryProgress.style.width = `${Math.max(0, Math.min(100, Number(pool.primaryRemainPercent || 0)))}%`
    }
    if (secondaryProgress) {
      secondaryProgress.style.width = `${Math.max(0, Math.min(100, Number(pool.secondaryRemainPercent || 0)))}%`
    }
    if (primaryValue) {
      primaryValue.textContent = pool.primaryRemainPercent == null ? "-" : `${Math.round(Number(pool.primaryRemainPercent))}%`
    }
    if (secondaryValue) {
      secondaryValue.textContent = pool.secondaryRemainPercent == null ? "-" : `${Math.round(Number(pool.secondaryRemainPercent))}%`
    }
    if (poolKnownValue) {
      poolKnownValue.textContent = `已知额度账号 ${formatCompactNumber(pool.quotaKnownAccountCount)} / 可路由账号 ${formatCompactNumber(pool.eligibleAccountCount)}`
    }

    if (!hint) return
    if (S.requestLogError) {
      hint.textContent = `请求日志读取失败：${S.requestLogError}`
      return
    }
    if (S.requestLogBusyVisible && !S.requestLogsLoadedAt) {
      hint.textContent = "正在同步请求日志与今日统计..."
      return
    }
    hint.textContent = `统计范围：今日 00:00 至今 | 时区 ${metrics.statsTimezone || "-"} | 请求 ${formatCompactNumber(metrics.todayRequestCount)} | 更新时间 ${dt(S.requestLogsLoadedAt || Date.now())}`
  }

  return {
    loadDashboardMetrics,
    renderTodayStats,
  }
}
