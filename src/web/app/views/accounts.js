function clampPercent(value) {
  if (!Number.isFinite(Number(value))) return null
  return Math.max(0, Math.min(100, Math.round(Number(value))))
}

function toneForPercent(percent, abnormalCategory) {
  if (abnormalCategory === "quota_exhausted" || percent === 0) return "danger"
  if (abnormalCategory === "soft_drained") return "warn"
  if (percent !== null && percent < 35) return "warn"
  return "good"
}

function formatQuotaDurationLabel(windowMinutes, fallbackLabel = "") {
  const minutes = Number(windowMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel
  const MINUTES_PER_HOUR = 60
  const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR
  const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY
  const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY
  const ROUNDING_BIAS_MINUTES = 3
  const normalizedMinutes = Math.max(0, Math.floor(minutes))

  if (normalizedMinutes <= MINUTES_PER_DAY + ROUNDING_BIAS_MINUTES) {
    const hours = Math.max(1, Math.floor((normalizedMinutes + ROUNDING_BIAS_MINUTES) / MINUTES_PER_HOUR))
    return `${hours}小时额度`
  }
  if (normalizedMinutes <= MINUTES_PER_WEEK + ROUNDING_BIAS_MINUTES) return "周额度"
  if (normalizedMinutes <= MINUTES_PER_MONTH + ROUNDING_BIAS_MINUTES) return "月额度"
  return "年额度"
}

function normalizeQuotaBucketLabel(value) {
  const normalized = String(value || "").trim()
  if (!normalized) return ""
  const lower = normalized.toLowerCase()
  if (
    lower.includes("codex_other") ||
    lower.includes("codex-other") ||
    lower.includes("code_review") ||
    lower.includes("code-review")
  ) {
    return "代码审查"
  }
  if (lower.includes("review") || normalized.includes("审查")) return "代码审查"
  if (lower.includes("week") || normalized.includes("周")) return ""
  if (lower.includes("hour") || normalized.includes("小时")) return ""
  if (["codex", "chatgpt", "openai", "default", "primary", "secondary", "main", "core"].includes(lower)) return ""
  return normalized
}

function buildQuotaRowLabel(entry, window, fallbackLabel) {
  const bucketLabel = normalizeQuotaBucketLabel(entry?.limitName || entry?.limitId)
  const durationLabel = formatQuotaDurationLabel(window?.windowMinutes, fallbackLabel)
  if (!bucketLabel) return durationLabel
  if (!durationLabel) return `${bucketLabel}额度`
  if (bucketLabel === "代码审查") return `${bucketLabel}${durationLabel}`
  return `${bucketLabel} ${durationLabel}`
}

function formatQuotaResetStamp(resetsAt) {
  const value = Number(resetsAt || 0)
  if (!Number.isFinite(value) || value <= 0) return "--"
  const date = new Date(value)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${month}/${day} ${hours}:${minutes}`
}

function buildQuotaRows(account) {
  const quota = account?.quota
  if (!quota || quota.status !== "ok") return []
  const rows = []

  const pushWindow = (entry, windowKey, fallbackLabel) => {
    const window = entry?.[windowKey]
    if (!window) return
    rows.push({
      label: buildQuotaRowLabel(entry, window, fallbackLabel) || fallbackLabel,
      remainingPercent: clampPercent(window.remainingPercent),
      resetText: formatQuotaResetStamp(window.resetsAt),
    })
  }

  pushWindow(quota.primary, "primary", "5小时额度")
  pushWindow(quota.primary, "secondary", "周额度")

  for (const entry of quota.additional || []) {
    pushWindow(entry, "primary", "5小时额度")
    pushWindow(entry, "secondary", "周额度")
  }

  return rows
}

function resolvePlanLabel(account) {
  return account?.quota?.planType || account?.chatgptPlanType || account?.metadata?.chatgptPlanType || "未知套餐"
}

function resolvePlanMeta(account) {
  const rawLabel = String(resolvePlanLabel(account) || "").trim()
  const normalized = rawLabel.toLowerCase()

  if (normalized.includes("team") || normalized.includes("business") || normalized.includes("enterprise")) {
    return {
      kind: "business",
      label: "Business账号",
      rawLabel: "Business账号",
    }
  }

  if (normalized.includes("plus") || normalized.includes("pro") || normalized.includes("premium")) {
    const label = normalized.includes("pro") && !normalized.includes("plus")
      ? "Pro"
      : normalized.includes("premium")
        ? "Premium"
        : "Plus"
    return {
      kind: "plus",
      label,
      rawLabel: rawLabel || label,
    }
  }

  if (normalized.includes("free") || normalized.includes("trial") || normalized.includes("starter")) {
    return {
      kind: "free",
      label: "Free",
      rawLabel: rawLabel || "Free",
    }
  }

  return {
    kind: "default",
    label: rawLabel || "Plan",
    rawLabel: rawLabel || "Plan",
  }
}

const ACCOUNT_PLAN_GROUPS = [
  {
    key: "business",
    title: "Business",
    tone: "business",
    description: "Business / Team / Enterprise",
  },
  {
    key: "plus",
    title: "PLUS",
    tone: "plus",
    description: "Plus / Pro / Premium",
  },
  {
    key: "free",
    title: "Free",
    tone: "free",
    description: "Free / Trial / Starter",
  },
]

function accountPlanGroupKey(account) {
  const kind = resolvePlanMeta(account).kind
  if (kind === "business" || kind === "plus") return kind
  return "free"
}

export function createAccountsView(deps) {
  const {
    S,
    esc,
    normalizeQuery,
    providerDisplayName,
    accountType,
    formatAccountQuota,
    getAccountStatusMeta,
    normalizeAbnormalState,
    canRefreshAccountQuota,
    renderBulkDeleteButton,
    openTestModal,
    openRefreshTokenModal,
    refreshSingleAccountQuota,
    applyRefreshedAccountQuota,
    getAccountDisplayLabel,
    runBusyAction,
    api,
    loadAccounts,
    loadVirtualKeys,
    log,
    showToast,
    toErrorMessage,
  } = deps

  function accountLabel(accountId) {
    if (typeof getAccountDisplayLabel === "function") return getAccountDisplayLabel(accountId)
    const account = (S.accounts || []).find((item) => String(item?.id || "") === String(accountId || ""))
    return account?.email || account?.accountId || account?.displayName || accountId
  }

  function quotaRefreshErrorMessage(error) {
    if (typeof toErrorMessage === "function") return toErrorMessage(error)
    return error instanceof Error ? error.message : String(error)
  }

  async function refreshAccountQuotaGroup(groupKey, triggerButton = null) {
    const group = ACCOUNT_PLAN_GROUPS.find((item) => item.key === groupKey)
    if (!group) return

    const queue = (S.accounts || [])
      .filter((account) => accountPlanGroupKey(account) === group.key && canRefreshAccountQuota(account))
      .map((account) => String(account?.id || "").trim())
      .filter(Boolean)

    if (!queue.length) {
      showToast(`当前 ${group.title} 分组没有可刷新的账号额度`, "info")
      return
    }

    await runBusyAction(
      `accounts:quota:refresh:${group.key}`,
      async () => {
        let successCount = 0
        let failureCount = 0

        for (let index = 0; index < queue.length; index += 1) {
          const accountId = queue[index]
          const currentAccount = (S.accounts || []).find((item) => String(item?.id || "") === accountId)
          const label = accountLabel(accountId)

          if (triggerButton) triggerButton.textContent = `刷新中 ${index + 1}/${queue.length}`

          if (!currentAccount || accountPlanGroupKey(currentAccount) !== group.key || !canRefreshAccountQuota(currentAccount)) {
            failureCount += 1
            log(`刷新 ${group.title} 额度已跳过：${label}`)
            continue
          }

          try {
            const output = await api(`/api/accounts/${encodeURIComponent(accountId)}/refresh-quota`, { method: "POST" })
            if (typeof applyRefreshedAccountQuota === "function") {
              applyRefreshedAccountQuota(output?.account || null, output?.dashboardMetrics || null)
            } else {
              await refreshSingleAccountQuota(accountId, null)
            }
            successCount += 1
            log(`已刷新 ${group.title} 账号额度：${label}（${successCount}/${queue.length}）`)
          } catch (error) {
            failureCount += 1
            log(`刷新 ${group.title} 账号额度失败：${label} - ${quotaRefreshErrorMessage(error)}`, "error")
          }
        }

        if (failureCount > 0) {
          showToast(`已刷新 ${group.title} 分组 ${successCount}/${queue.length} 个账号额度，失败 ${failureCount} 个`, successCount > 0 ? "info" : "error", 4200)
          return
        }

        showToast(`已按顺序刷新 ${group.title} 分组 ${successCount} 个账号额度`, "success")
      },
      {
        button: triggerButton,
        busyLabel: "刷新中...",
        successToast: false,
        errorToast: `刷新 ${group.title} 分组额度失败`,
        rethrow: false,
      },
    )
  }

  function drawAccountsTable() {
    const tbody = document.getElementById("accountsTableBody")
    if (!tbody) return
    renderBulkDeleteButton()

    const table = tbody.closest("table")
    const thead = table?.querySelector("thead")
    if (thead) thead.style.display = "none"

    if (!S.accounts.length) {
      tbody.innerHTML =
        '<tr class="account-card-row"><td colspan="7"><div class="account-empty muted">暂无账号，请先添加 OAuth 或 API Key 账号。</div></td></tr>'
      return
    }

    const query = normalizeQuery(S.accountQuery)
    const rows = S.accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => {
        if (!query) return true
        const quota = formatAccountQuota(account.quota)
        const status = getAccountStatusMeta(account)
        const abnormal = normalizeAbnormalState(account)
        const quotaRows = buildQuotaRows(account)
        const fields = [
          providerDisplayName(account),
          accountType(account),
          account.displayName,
          account.email,
          account.accountId,
          account.id,
          status.text,
          status.detail,
          abnormal?.label,
          String(account.totalTokens || 0),
          quota.text,
          quota.detail,
          resolvePlanMeta(account).label,
          ...quotaRows.map((row) => `${row.label} ${row.remainingPercent ?? "--"} ${row.resetText}`),
        ]
        return fields.some((field) => String(field ?? "").toLowerCase().includes(query))
      })
      .sort((left, right) => {
        const leftAbnormal = normalizeAbnormalState(left.account)
        const rightAbnormal = normalizeAbnormalState(right.account)
        const rankFor = (abnormal) => {
          if (!abnormal) return 0
          if (abnormal.category === "soft_drained") return 1
          return 2
        }
        const leftRank = rankFor(leftAbnormal)
        const rightRank = rankFor(rightAbnormal)
        if (leftRank !== rightRank) return leftRank - rightRank
        return left.index - right.index
      })
      .map(({ account }) => account)

    if (!rows.length) {
      tbody.innerHTML =
        '<tr class="account-card-row"><td colspan="7"><div class="account-empty muted">未找到匹配账号。</div></td></tr>'
      return
    }

    const cardItems = rows
      .map((account) => {
        const abnormal = normalizeAbnormalState(account)
        const status = getAccountStatusMeta(account)
        const tokenUsed = Number(account.totalTokens || 0)
        const quotaText = formatAccountQuota(account.quota)
        const quotaRows = buildQuotaRows(account)
        const planMeta = resolvePlanMeta(account)
        const statusBanner = abnormal
          ? `<div class="account-status-banner ${abnormal.category === "soft_drained" ? "warn" : "danger"}">${esc(status.text)}${status.detail ? ` 路 ${esc(status.detail)}` : ""}</div>`
          : ""
        const quotaSection =
          quotaRows.length > 0
            ? quotaRows
                .map((row) => {
                  const tone = toneForPercent(row.remainingPercent, abnormal?.category || null)
                  return `
                    <div class="account-quota-row">
                      <div class="account-quota-head">
                        <span class="account-quota-label">${esc(row.label)}</span>
                        <span class="account-quota-value">${row.remainingPercent == null ? "--" : `${row.remainingPercent}%`}</span>
                        <span class="account-quota-reset">${esc(row.resetText)}</span>
                      </div>
                      <div class="account-quota-track">
                        <div class="account-quota-fill ${tone}" style="width:${row.remainingPercent ?? 0}%"></div>
                      </div>
                    </div>
                  `
                })
                .join("")
            : `<div class="account-quota-empty">${esc(quotaText.text)}${quotaText.detail ? ` 路 ${esc(quotaText.detail)}` : ""}</div>`

        const refreshQuotaBtn = canRefreshAccountQuota(account)
          ? `<button class="mini-btn" data-account-action="refresh-quota" data-id="${esc(account.id)}" title="刷新额度">额度</button>`
          : ""

        const codexLocalLoginBtn =
          account.providerId === "chatgpt" && account.hasRefreshToken
            ? `<button class="mini-btn codex-local" data-account-action="codex-local-login" data-id="${esc(account.id)}" title="Login this account to local Codex CLI/App">Codex</button>`
            : ""

        const activateBtn = account.isActive
          ? '<button class="mini-btn activate" disabled>当前</button>'
          : `<button class="mini-btn activate" data-account-action="activate" data-id="${esc(account.id)}">设为默认</button>`

        return {
          groupKey: accountPlanGroupKey(account),
          id: account.id,
          canRefreshQuota: canRefreshAccountQuota(account),
          html: `
          <article class="account-card ${abnormal ? "is-abnormal" : ""}">
            <div class="account-card-top">
              <div class="account-card-badges">
                <span class="type-badge provider">${esc(providerDisplayName(account))}</span>
                <span class="type-badge">${esc(accountType(account))}</span>
                <span class="account-plan-badge plan-${esc(planMeta.kind)}" title="${esc(planMeta.rawLabel)}">${esc(planMeta.label)}</span>
              </div>
              <div class="account-card-status">${status.html}</div>
            </div>
            <div class="account-card-identity">${esc(account.email || account.accountId || account.displayName)}</div>
            <div class="account-card-sub">${esc(account.displayName || account.id)}</div>
            ${statusBanner}
            <div class="account-card-body">
              ${quotaSection}
            </div>
            <div class="account-card-foot">
              <div class="account-card-meta">
                <span>Token 已用 ${tokenUsed > 0 ? tokenUsed.toLocaleString() : "-"}</span>
              </div>
              <div class="mini-actions account-card-actions">
                <button class="mini-btn test" data-account-action="test" data-id="${esc(account.id)}">测试</button>
                <button class="mini-btn bridge" data-account-action="refresh-token" data-id="${esc(account.id)}">Token</button>
                ${refreshQuotaBtn}
                ${codexLocalLoginBtn}
                ${activateBtn}
                <button class="mini-btn delete" data-account-action="delete" data-id="${esc(account.id)}">删除</button>
              </div>
            </div>
          </article>
        `,
        }
      })

    const groupedSections = ACCOUNT_PLAN_GROUPS
      .map((group) => {
        const groupItems = cardItems.filter((item) => item.groupKey === group.key)
        const groupCards = groupItems
          .map((item) => item.html)
          .join("")
        const refreshableCount = groupItems.filter((item) => item.canRefreshQuota).length
        const isGroupRefreshing = Boolean(S.ui?.busyActions?.[`accounts:quota:refresh:${group.key}`])
        const body = groupCards
          ? `<div class="account-card-grid">${groupCards}</div>`
          : `<div class="account-plan-section-empty">\u6682\u65e0 ${esc(group.title)} \u8d26\u53f7</div>`

        return `
          <section class="account-plan-section account-plan-section-${esc(group.tone)}">
            <div class="account-plan-section-head">
              <div>
                <div class="account-plan-section-kicker">${esc(group.title)}</div>
                <h3>${esc(group.title)} \u8d26\u53f7</h3>
                <p>${esc(group.description)}</p>
              </div>
              <div class="account-plan-section-actions">
                <span class="account-plan-section-count">${groupItems.length}</span>
                <button
                  class="mini-btn account-plan-refresh"
                  data-account-action="refresh-quota-group"
                  data-group="${esc(group.key)}"
                  title="只刷新 ${esc(group.title)} 分组账号额度"
                  ${refreshableCount > 0 && !isGroupRefreshing ? "" : "disabled"}
                >${isGroupRefreshing ? "刷新中..." : "刷新额度"}</button>
              </div>
            </div>
            ${body}
          </section>
        `
      })
      .join("")

    tbody.innerHTML = `
      <tr class="account-card-row">
        <td colspan="7">
          <div class="account-plan-sections">${groupedSections}</div>
        </td>
      </tr>
    `

    tbody.querySelectorAll("[data-account-action]").forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.accountAction
        if (!action) return
        if (action === "refresh-quota-group") {
          await refreshAccountQuotaGroup(button.dataset.group, button)
          return
        }
        const id = button.dataset.id
        if (!id) return
        if (action === "test") {
          openTestModal(id)
          return
        }
        if (action === "refresh-token") {
          openRefreshTokenModal(id)
          return
        }
        if (action === "refresh-quota") {
          await refreshSingleAccountQuota(id, button)
          return
        }
        if (action === "codex-local-login") {
          const account = (S.accounts || []).find((item) => item?.id === id)
          const label = account?.email || account?.accountId || account?.displayName || id
          const confirmed = window.confirm(
            `Switch local Codex CLI/App login to ${label}? This overwrites ~/.codex/auth.json and restarts the official Codex App if it is installed.`,
          )
          if (!confirmed) return
          await runBusyAction(
            `account:codex-local-login:${id}`,
            async () => {
              const output = await api(`/api/accounts/${encodeURIComponent(id)}/codex-local-login`, {
                method: "POST",
                headers: { "x-sensitive-action": "confirm" },
                body: JSON.stringify({ restartCodexApp: true }),
              })
              const info = output?.codexLocalAuth || {}
              const restart = info?.appRestart || {}
              const restartText =
                restart.status === "restarted"
                  ? "Codex App restarted"
                  : restart.status === "failed"
                    ? `Codex App restart failed: ${restart.message || "unknown error"}`
                    : restart.message || "Codex App restart skipped"
              log(`Codex local login switched: ${label}. auth=${info.authPath || "~/.codex/auth.json"}. ${restartText}`)
              showToast(`Codex local login switched: ${label}`, "success")
              await loadAccounts({ loadVirtualKeys: false, silent: true })
            },
            {
              button,
              busyLabel: "Codex...",
              errorToast: "Codex local login failed",
              rethrow: false,
            },
          )
          return
        }
        if (action === "delete") {
          const confirmed = window.confirm("确认删除这个账号吗？关联的单账号 Key 也会一起删除。")
          if (!confirmed) return
        }
        if (action === "activate") {
          await runBusyAction(
            `account:activate:${id}`,
            async () => {
              await api(`/api/accounts/${encodeURIComponent(id)}/activate`, { method: "POST" })
              await loadAccounts({ loadVirtualKeys: false })
              log("账号已设为默认")
            },
            {
              button,
              busyLabel: "设置中...",
              successToast: "已设为默认账号",
              errorToast: "设置默认账号失败",
              rethrow: false,
            },
          )
          return
        }
        if (action === "delete") {
          await runBusyAction(
            `account:delete:${id}`,
            async () => {
              const output = await api(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" })
              await loadAccounts({ loadVirtualKeys: false })
              await loadVirtualKeys()
              const deletedVirtualKeyCount = Number(output?.deletedVirtualKeyCount || 0)
              log(`账号已删除，并同步删除 ${deletedVirtualKeyCount} 个单账号 Key`)
              showToast(`账号已删除，单账号 Key 删除 ${deletedVirtualKeyCount} 个`, "success")
            },
            {
              button,
              busyLabel: "删除中...",
              errorToast: "删除账号失败",
              rethrow: false,
            },
          )
        }
      }
    })
  }

  return {
    drawAccountsTable,
  }
}
