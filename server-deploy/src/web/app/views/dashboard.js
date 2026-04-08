export function createDashboardView(deps) {
  const {
    S,
    api,
    beginSync,
    finishSyncSuccess,
    finishSyncError,
    coerceDashboardMetrics,
    normalizeTokenDelta,
    coerceUsageTotalsSnapshot,
    drawStats,
    drawTokenUsage,
    formatCompactNumber,
    formatUsd,
    dt,
    renderSettingsReadOnly,
  } = deps

  function clampPercent(value) {
    const amount = Number(value)
    if (!Number.isFinite(amount)) return null
    return Math.max(0, Math.min(100, Math.round(amount)))
  }

  function isPoolMetricsMissing(pool) {
    if (!pool || typeof pool !== "object") return true
    return (
      pool.primaryRemainPercent == null &&
      pool.secondaryRemainPercent == null &&
      Number(pool.eligibleAccountCount || 0) === 0 &&
      Number(pool.quotaKnownAccountCount || 0) === 0
    )
  }

  function isPoolCandidate(account) {
    const provider = String(account?.providerId || "")
      .trim()
      .toLowerCase()
    const method = String(account?.methodId || "")
      .trim()
      .toLowerCase()
    if (method === "api" || method === "api-key") return false
    return provider === "openai" || provider === "chatgpt"
  }

  function resolveQuotaWindowRemainingPercentFromPublicQuota(quota, windowKey) {
    if (!quota || quota.status !== "ok") return null
    const entries = [quota.primary, ...(Array.isArray(quota.additional) ? quota.additional : [])]
    for (const entry of entries) {
      const remain = clampPercent(entry?.[windowKey]?.remainingPercent)
      if (remain !== null) return remain
    }
    return null
  }

  function buildPoolRemainingFallbackFromAccounts() {
    const primaryValues = []
    const secondaryValues = []
    let eligibleAccountCount = 0
    let quotaKnownAccountCount = 0

    for (const account of Array.isArray(S.accounts) ? S.accounts : []) {
      if (!isPoolCandidate(account)) continue
      const routingState = String(account?.routing?.state || "eligible")
      if (routingState !== "excluded") eligibleAccountCount += 1
      const quota = account?.quota || null
      const primaryRemainPercent = resolveQuotaWindowRemainingPercentFromPublicQuota(quota, "primary")
      const secondaryRemainPercent = resolveQuotaWindowRemainingPercentFromPublicQuota(quota, "secondary")
      if (primaryRemainPercent !== null) primaryValues.push(primaryRemainPercent)
      if (secondaryRemainPercent !== null) secondaryValues.push(secondaryRemainPercent)
      if (primaryRemainPercent !== null || secondaryRemainPercent !== null) quotaKnownAccountCount += 1
    }

    const average = (values) =>
      values.length > 0 ? Math.max(0, Math.min(100, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length))) : null

    return {
      primaryRemainPercent: average(primaryValues),
      secondaryRemainPercent: average(secondaryValues),
      knownPrimaryCount: primaryValues.length,
      knownSecondaryCount: secondaryValues.length,
      eligibleAccountCount,
      quotaKnownAccountCount,
    }
  }

  async function loadDashboardMetrics(options = {}) {
    const silent = options.silent === true
    if (!silent) beginSync()
    try {
      const output = await api("/api/dashboard/metrics")
      const metricsPayload = output?.metrics || {}
      S.dashboardMetrics = coerceDashboardMetrics(metricsPayload)
      S.usageTotals = coerceUsageTotalsSnapshot(metricsPayload?.usageTotals)
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
    const pool = isPoolMetricsMissing(metrics.poolRemaining) ? buildPoolRemainingFallbackFromAccounts() : metrics.poolRemaining || {}
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
