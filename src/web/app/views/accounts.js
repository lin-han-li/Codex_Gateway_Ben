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

function normalizeQuotaLabel(value) {
  const normalized = String(value || "").trim()
  if (!normalized) return ""
  const lower = normalized.toLowerCase()
  if (lower.includes("review") || normalized.includes("审查")) return "代码审查周额度"
  if (lower.includes("week") || normalized.includes("周")) return "周额度"
  if (lower.includes("hour") || normalized.includes("小时")) return "5小时额度"
  return normalized
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
      label: normalizeQuotaLabel(entry?.limitName || entry?.limitId) || fallbackLabel,
      remainingPercent: clampPercent(window.remainingPercent),
      resetText: formatQuotaResetStamp(window.resetsAt),
    })
  }

  pushWindow(quota.primary, "primary", "5小时额度")
  pushWindow(quota.primary, "secondary", "周额度")

  for (const entry of quota.additional || []) {
    pushWindow(entry, "primary", "代码审查周额度")
    if (rows.length >= 3) break
    pushWindow(entry, "secondary", "附加额度")
    if (rows.length >= 3) break
  }

  return rows.slice(0, 3)
}

function resolvePlanLabel(account) {
  return account?.quota?.planType || account?.chatgptPlanType || account?.metadata?.chatgptPlanType || "未知套餐"
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
    runBusyAction,
    api,
    loadAccounts,
    loadVirtualKeys,
    log,
    showToast,
  } = deps

  function drawAccountsTable() {
    const tbody = document.getElementById("accountsTableBody")
    if (!tbody) return
    renderBulkDeleteButton()

    const table = tbody.closest("table")
    const thead = table?.querySelector("thead")
    if (thead) thead.style.display = "none"

    if (!S.accounts.length) {
      tbody.innerHTML = '<tr class="account-card-row"><td colspan="7"><div class="account-empty muted">暂无账号，请先添加 OAuth 或 API Key 账号。</div></td></tr>'
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
          resolvePlanLabel(account),
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
      tbody.innerHTML = '<tr class="account-card-row"><td colspan="7"><div class="account-empty muted">未找到匹配账号。</div></td></tr>'
      return
    }

    const cards = rows
      .map((account) => {
        const abnormal = normalizeAbnormalState(account)
        const status = getAccountStatusMeta(account)
        const tokenUsed = Number(account.totalTokens || 0)
        const quotaText = formatAccountQuota(account.quota)
        const quotaRows = buildQuotaRows(account)
        const planLabel = resolvePlanLabel(account)
        const statusBanner = abnormal
          ? `<div class="account-status-banner ${abnormal.category === "soft_drained" ? "warn" : "danger"}">${esc(status.text)}${status.detail ? ` · ${esc(status.detail)}` : ""}</div>`
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
            : `<div class="account-quota-empty">${esc(quotaText.text)}${quotaText.detail ? ` · ${esc(quotaText.detail)}` : ""}</div>`
        const refreshQuotaBtn = canRefreshAccountQuota(account)
          ? `<button class="mini-btn" data-account-action="refresh-quota" data-id="${esc(account.id)}" title="刷新额度">额度</button>`
          : ""
        const activateBtn = account.isActive
          ? '<button class="mini-btn activate" disabled>当前</button>'
          : `<button class="mini-btn activate" data-account-action="activate" data-id="${esc(account.id)}">设为默认</button>`

        return `
          <article class="account-card ${abnormal ? "is-abnormal" : ""}">
            <div class="account-card-top">
              <div class="account-card-badges">
                <span class="type-badge provider">${esc(providerDisplayName(account))}</span>
                <span class="type-badge">${esc(accountType(account))}</span>
                <span class="account-plan-badge">${esc(planLabel)}</span>
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
                ${activateBtn}
                <button class="mini-btn delete" data-account-action="delete" data-id="${esc(account.id)}">删除</button>
              </div>
            </div>
          </article>
        `
      })
      .join("")

    tbody.innerHTML = `
      <tr class="account-card-row">
        <td colspan="7">
          <div class="account-card-grid">${cards}</div>
        </td>
      </tr>
    `

    tbody.querySelectorAll("[data-account-action]").forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.accountAction
        const id = button.dataset.id
        if (!action || !id) return
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
