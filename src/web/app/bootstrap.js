import { createAccountsView } from "./views/accounts.js"
import { createDashboardView } from "./views/dashboard.js"
import { createKeysView } from "./views/keys.js"
import { createLogsView } from "./views/logs.js"
import { createSettingsView } from "./views/settings.js"
import { createTestChatView } from "./views/test-chat.js"

export function initWebAppModules(deps) {
  const placeholders = {
    renderSettingsReadOnly: () => {},
    renderTodayStats: () => {},
  }

  const settingsView = createSettingsView({
    ...deps,
    ...placeholders,
  })
  const accountsView = createAccountsView(deps)
  const dashboardView = createDashboardView({
    ...deps,
    renderSettingsReadOnly: settingsView.renderSettingsReadOnly,
  })
  const logsView = createLogsView({
    ...deps,
    renderTodayStats: dashboardView.renderTodayStats,
    renderSettingsReadOnly: settingsView.renderSettingsReadOnly,
  })
  const keysView = createKeysView(deps)
  const testChatView = createTestChatView(deps)

  return {
    ...accountsView,
    ...dashboardView,
    ...logsView,
    ...settingsView,
    ...keysView,
    ...testChatView,
  }
}
