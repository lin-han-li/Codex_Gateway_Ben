import { createAccountsView } from "./views/accounts.js"
import { createDashboardView } from "./views/dashboard.js"
import { createKeysView } from "./views/keys.js"
import { createLogsView } from "./views/logs.js"
import { createSettingsView } from "./views/settings.js"
import { createTestChatView } from "./views/test-chat.js"

export function initWebAppModules(deps) {
  const safeCreateView = (label, factory, factoryDeps) => {
    try {
      return factory(factoryDeps) || {}
    } catch (error) {
      const msg = error instanceof Error ? error.stack || error.message : String(error)
      console.warn(`[web-app:${label}]`, msg)
      return {}
    }
  }

  const placeholders = {
    renderSettingsReadOnly: () => {},
    renderTodayStats: () => {},
  }

  const settingsView = safeCreateView("settings", createSettingsView, {
    ...deps,
    ...placeholders,
  })
  const accountsView = safeCreateView("accounts", createAccountsView, deps)
  const dashboardView = safeCreateView("dashboard", createDashboardView, {
    ...deps,
    renderSettingsReadOnly: settingsView.renderSettingsReadOnly,
  })
  const logsView = safeCreateView("logs", createLogsView, {
    ...deps,
    renderTodayStats: dashboardView.renderTodayStats,
    renderSettingsReadOnly: settingsView.renderSettingsReadOnly,
  })
  const keysView = safeCreateView("keys", createKeysView, deps)
  const testChatView = safeCreateView("test-chat", createTestChatView, deps)

  return {
    ...accountsView,
    ...dashboardView,
    ...logsView,
    ...settingsView,
    ...keysView,
    ...testChatView,
  }
}
