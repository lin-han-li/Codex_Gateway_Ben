export function createSettingsView(deps) {
  const {
    S,
    api,
    beginRequest,
    isLatestRequest,
    beginSync,
    finishSyncSuccess,
    finishSyncError,
    hydrateSettingsFromApi,
    refreshSettingsUi,
    coerceDashboardMetrics,
    formatCompactNumber,
    formatUsd,
    dt,
  } = deps

  async function loadSettings(options = {}) {
    const requestId = beginRequest("settings")
    const silent = options.silent === true
    if (!silent) beginSync()
    try {
      const output = await api("/api/settings")
      if (!isLatestRequest("settings", requestId)) return
      const settings = output?.settings || {}
      hydrateSettingsFromApi(settings)
      refreshSettingsUi()
      if (!silent) finishSyncSuccess()
    } catch (error) {
      if (!silent) finishSyncError("设置同步失败，正在重试...")
      throw error
    }
  }

  function renderSettingsReadOnly() {
    const metrics = coerceDashboardMetrics(S.dashboardMetrics)
    const serviceSummary = S.settings.serviceStatusSummary || metrics.serviceStatusSummary || null
    const preferredOrigin = document.getElementById("preferredOrigin")
    if (preferredOrigin) preferredOrigin.textContent = S.settings.preferredClientServiceAddress || "-"
    const guardState = document.getElementById("settingsGuardState")
    if (guardState) guardState.textContent = S.settings.managementAuthEnabled ? "已启用" : "未启用"
    const storedAdminToken = document.getElementById("settingsStoredAdminToken")
    if (storedAdminToken) storedAdminToken.textContent = S.adminToken ? "已保存" : "未保存"
    const encryptionState = document.getElementById("settingsEncryptionState")
    if (encryptionState) encryptionState.textContent = S.settings.encryptionKeyConfigured ? "已配置" : "未配置"
    const storedEncryptionKey = document.getElementById("settingsStoredEncryptionKey")
    if (storedEncryptionKey) storedEncryptionKey.textContent = S.encryptionKey ? "已保存" : "未保存"
    const statTimezone = document.getElementById("settingsStatTimezone")
    if (statTimezone) statTimezone.textContent = S.settings.statsTimezone || metrics.statsTimezone || "-"
    const statPricingMode = document.getElementById("settingsStatPricingMode")
    if (statPricingMode) statPricingMode.textContent = S.settings.pricingMode || metrics.pricingMode || "-"
    const statCatalogVersion = document.getElementById("settingsStatCatalogVersion")
    if (statCatalogVersion) statCatalogVersion.textContent = S.settings.pricingCatalogVersion || metrics.pricingCatalogVersion || "-"
    const statTodayTokens = document.getElementById("settingsStatTodayTokens")
    if (statTodayTokens) statTodayTokens.textContent = formatCompactNumber(metrics.todayTokens)
    const statCachedTokens = document.getElementById("settingsStatCachedTokens")
    if (statCachedTokens) statCachedTokens.textContent = formatCompactNumber(metrics.cachedInputTokens)
    const statReasoningTokens = document.getElementById("settingsStatReasoningTokens")
    if (statReasoningTokens) statReasoningTokens.textContent = formatCompactNumber(metrics.reasoningOutputTokens)
    const statEstimatedCost = document.getElementById("settingsStatEstimatedCost")
    if (statEstimatedCost) statEstimatedCost.textContent = formatUsd(metrics.estimatedCostUsd)
    const statUnpriced = document.getElementById("settingsStatUnpriced")
    if (statUnpriced) statUnpriced.textContent = formatCompactNumber(metrics.unpricedRequestCount)
    const syncState = document.getElementById("settingsSyncState")
    if (syncState) {
      syncState.textContent = String(
        S.ui.syncMessage || (S.ui.syncState === "ready" ? "已同步" : "同步中"),
      )
    }
    const realtimeState = document.getElementById("settingsRealtimeState")
    if (realtimeState) {
      realtimeState.textContent = S.usageEventReady
        ? "SSE 已连接"
        : S.usageFallbackActive
          ? "轮询刷新中"
          : S.service
            ? "未连接"
            : "离线"
    }
    const requestLogState = document.getElementById("settingsRequestLogState")
    if (requestLogState) {
      requestLogState.textContent = S.requestLogError
        ? `异常：${S.requestLogError}`
        : S.requestLogLoading
          ? "同步中"
          : S.requestLogsLoadedAt
            ? `已加载 ${formatCompactNumber(S.requestLogsTotal)} 条 · ${dt(S.requestLogsLoadedAt)}`
            : "未加载"
    }
    const systemLogState = document.getElementById("settingsSystemLogState")
    if (systemLogState) systemLogState.textContent = `${formatCompactNumber(S.logs.length)} 条`
    const restartState = document.getElementById("settingsRestartState")
    if (restartState) restartState.textContent = serviceSummary?.restartRequired === false ? "否" : "是"
  }

  return {
    loadSettings,
    renderSettingsReadOnly,
  }
}
