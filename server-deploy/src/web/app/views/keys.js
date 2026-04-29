export function createKeysView(deps) {
  const {
    S,
    api,
    esc,
    dt,
    normalizeQuery,
    matchesVirtualKeyQuery,
    isVirtualKeyExpired,
    keyAccountLabel,
    keyAccountScopeLabel,
    normalizeKeyAccountScope,
    accountMatchesKeyScope,
    getVirtualKeyById,
    getVirtualKeyDisplayName,
    getVirtualKeyFixedPolicyLabel,
    getVirtualKeyClientModeLabel,
    renderKeyUsageButtons,
    closeKeyManageModal,
    toggleRevealVirtualKey,
    copyVirtualKey,
    openKeyManageModal,
    formatRemainingTime,
    restoreVirtualKey,
    revokeVirtualKey,
    deleteVirtualKey,
    openTestModal,
    loadVirtualKeys,
    runBusyAction,
    showToast,
    log,
    providerDisplayName,
  } = deps

  const escapeHtml = typeof esc === "function" ? esc : (value) => String(value ?? "")
  const normalizeScope =
    typeof normalizeKeyAccountScope === "function"
      ? normalizeKeyAccountScope
      : (value) => {
          const normalized = String(value || "").trim().toLowerCase()
          if (normalized === "free") return "free"
          if (normalized === "member" || normalized === "paid" || normalized === "paid_member") return "member"
          return "all"
        }
  const scopeLabel =
    typeof keyAccountScopeLabel === "function"
      ? keyAccountScopeLabel
      : (value) => {
          const scope = normalizeScope(value)
          if (scope === "free") return "Free 后端账号池"
          if (scope === "member") return "会员后端账号池"
          return "全部后端账号池"
        }
  const runBusy =
    typeof runBusyAction === "function"
      ? runBusyAction
      : async (_scope, fn) => {
          await fn()
        }

  function getDisplayName(row) {
    if (typeof getVirtualKeyDisplayName === "function") return getVirtualKeyDisplayName(row)
    return String(row?.name || row?.keyPrefix || "未命名 Key")
  }

  function getFixedPolicyLabel(row) {
    if (typeof getVirtualKeyFixedPolicyLabel === "function") return getVirtualKeyFixedPolicyLabel(row)
    return [row?.fixedModel || row?.fixed_model, row?.fixedReasoningEffort || row?.fixed_reasoning_effort]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join(" ")
  }

  function getClientModeLabel(row) {
    if (typeof getVirtualKeyClientModeLabel === "function") return getVirtualKeyClientModeLabel(row)
    const client = row?.clientMode === "cursor" ? "Cursor Key" : "Codex Key"
    const fixed = getFixedPolicyLabel(row)
    return [client, scopeLabel(row?.accountScope), fixed].filter(Boolean).join(" · ")
  }

  function accountDisplayLabel(account) {
    if (!account) return ""
    const name = account.displayName || account.email || account.accountId || account.id
    const provider = typeof providerDisplayName === "function" ? providerDisplayName(account) : account.providerName || account.providerId || "provider"
    const plan = account.chatgptPlanType || account.planType || account.plan || account.type || ""
    return [name, plan, provider].filter(Boolean).join(" · ")
  }

  function accountMatchesScope(account, scope) {
    if (typeof accountMatchesKeyScope === "function") return accountMatchesKeyScope(account, scope)
    return true
  }

  function selectableAccountsForScope(scope) {
    return (S.accounts || []).filter((account) => account?.id && accountMatchesScope(account, scope))
  }

  function fixedPolicyValue(row) {
    const fixedModel = String(row?.fixedModel ?? row?.fixed_model ?? "").trim().toLowerCase()
    const fixedEffort = String(row?.fixedReasoningEffort ?? row?.fixed_reasoning_effort ?? "").trim().toLowerCase()
    if (!fixedModel && !fixedEffort) return "standard"
    if (fixedModel === "gpt-5.5" && fixedEffort === "xhigh") return "gpt55_xhigh"
    return "custom"
  }

  function reasoningEffortOptions(current) {
    const value = String(current || "").trim().toLowerCase()
    const options = ["", "low", "medium", "high", "xhigh"]
    return options
      .map((option) => {
        const label = option || "不固定 reasoning"
        return `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(label)}</option>`
      })
      .join("")
  }

  function renderKeySettingsEditor(row) {
    const accountScope = normalizeScope(row.accountScope ?? row.account_scope)
    const routingMode = row.routingMode === "single" ? "single" : "pool"
    const clientMode = row.clientMode === "cursor" ? "cursor" : "codex"
    const policy = fixedPolicyValue(row)
    const fixedModel = String(row.fixedModel ?? row.fixed_model ?? "").trim()
    const fixedReasoningEffort = String(row.fixedReasoningEffort ?? row.fixed_reasoning_effort ?? "").trim().toLowerCase()
    const disabled = row.isRevoked ? "disabled" : ""
    return `
      <div class="key-manage-edit" style="flex:1 0 100%;display:grid;gap:8px;border:1px solid var(--input-border-strong);border-radius:12px;padding:10px;background:var(--input-bg);">
        <div class="muted">已生成 Key 可直接修改签发参数：会员/Free 类型、Codex/Cursor 类型、固定模型、网关池或强制后端单账号。修改不会改变前端当前登录账号，只改变网关后端路由。</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">
          <select id="keyManageClientModeInput" ${disabled}>
            <option value="codex" ${clientMode === "codex" ? "selected" : ""}>Codex Key</option>
            <option value="cursor" ${clientMode === "cursor" ? "selected" : ""}>Cursor Key</option>
          </select>
          <select id="keyManageAccountScopeInput" ${disabled}>
            <option value="member" ${accountScope === "member" ? "selected" : ""}>会员账号 Key</option>
            <option value="free" ${accountScope === "free" ? "selected" : ""}>Free 账号 Key</option>
            <option value="all" ${accountScope === "all" ? "selected" : ""}>兼容：全部账号 Key</option>
          </select>
          <select id="keyManageRoutingInput" ${disabled}>
            <option value="pool" ${routingMode === "pool" ? "selected" : ""}>网关池路由</option>
            <option value="single" ${routingMode === "single" ? "selected" : ""}>高级：强制后端单账号</option>
          </select>
          <select id="keyManagePolicyInput" ${disabled}>
            <option value="standard" ${policy === "standard" ? "selected" : ""}>标准路由</option>
            <option value="gpt55_xhigh" ${policy === "gpt55_xhigh" ? "selected" : ""}>固定 GPT-5.5 XHigh</option>
            <option value="custom" ${policy === "custom" ? "selected" : ""}>自定义固定模型</option>
          </select>
        </div>
        <div style="display:grid;grid-template-columns:minmax(180px,1fr) minmax(140px,220px);gap:8px;">
          <input id="keyManageFixedModelInput" value="${escapeHtml(fixedModel)}" placeholder="固定模型；留空=不固定" ${disabled} />
          <select id="keyManageReasoningInput" ${disabled}>${reasoningEffortOptions(fixedReasoningEffort)}</select>
        </div>
        <select id="keyManageAccountInput" ${disabled}></select>
        <div id="keyManageSettingsHint" class="muted"></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <button id="keyManageSettingsBtn" class="btn primary" ${disabled}>保存签发/路由参数</button>
        </div>
      </div>
    `
  }

  function refreshKeyManageEditor(row) {
    const scopeInput = document.getElementById("keyManageAccountScopeInput")
    const routingInput = document.getElementById("keyManageRoutingInput")
    const accountInput = document.getElementById("keyManageAccountInput")
    const policyInput = document.getElementById("keyManagePolicyInput")
    const modelInput = document.getElementById("keyManageFixedModelInput")
    const reasoningInput = document.getElementById("keyManageReasoningInput")
    const hint = document.getElementById("keyManageSettingsHint")
    if (!scopeInput || !routingInput || !accountInput) return

    const accountScope = normalizeScope(scopeInput.value)
    const routingMode = routingInput.value === "single" ? "single" : "pool"
    const accounts = selectableAccountsForScope(accountScope)
    const currentAccountId = String(row.accountId || "")
    const selectedValue = accountInput.value || currentAccountId
    const options = [`<option value="">网关池路由（不绑定后端单账号 · ${escapeHtml(scopeLabel(accountScope))}）</option>`]
    for (const account of accounts) {
      options.push(`<option value="${escapeHtml(account.id)}">${escapeHtml(accountDisplayLabel(account))}</option>`)
    }
    if (currentAccountId && !accounts.some((account) => account.id === currentAccountId)) {
      options.push(`<option value="${escapeHtml(currentAccountId)}">已选后端账号不可用：${escapeHtml(currentAccountId)}</option>`)
    }
    accountInput.innerHTML = options.join("")
    accountInput.value = routingMode === "single" ? selectedValue || currentAccountId : ""
    accountInput.disabled = row.isRevoked || routingMode !== "single"

    if (policyInput?.value === "gpt55_xhigh") {
      if (modelInput) modelInput.value = "gpt-5.5"
      if (reasoningInput) reasoningInput.value = "xhigh"
    } else if (policyInput?.value === "standard") {
      if (modelInput) modelInput.value = ""
      if (reasoningInput) reasoningInput.value = ""
    }

    if (hint) {
      hint.classList.remove("is-error")
      if (routingMode === "pool") {
        hint.textContent = `当前为前端固定账号 + 网关${scopeLabel(accountScope)}路由；换 Key 类型不会改变前端登录账号。`
      } else if (accountInput.value) {
        const account = accounts.find((item) => item.id === accountInput.value)
        hint.textContent = account
          ? `当前强制使用后端账号：${accountDisplayLabel(account)}。这不是前端显示账号。`
          : "当前选择的后端账号不在可用范围内，请重新选择或切回网关池路由。"
        if (!account) hint.classList.add("is-error")
      } else {
        hint.textContent = `请选择一个属于${scopeLabel(accountScope)}的后端账号，或切回网关池路由。`
        hint.classList.add("is-error")
      }
    }
  }

  async function submitKeyManageSettings(id) {
    const row = getVirtualKeyById(id)
    if (!row) return
    const clientModeInput = document.getElementById("keyManageClientModeInput")
    const scopeInput = document.getElementById("keyManageAccountScopeInput")
    const routingInput = document.getElementById("keyManageRoutingInput")
    const accountInput = document.getElementById("keyManageAccountInput")
    const policyInput = document.getElementById("keyManagePolicyInput")
    const modelInput = document.getElementById("keyManageFixedModelInput")
    const reasoningInput = document.getElementById("keyManageReasoningInput")

    const clientMode = clientModeInput?.value === "cursor" ? "cursor" : "codex"
    const wireApi = clientMode === "cursor" ? "chat_completions" : "responses"
    const accountScope = normalizeScope(scopeInput?.value || row.accountScope)
    const routingMode = routingInput?.value === "single" ? "single" : "pool"
    const accountId = routingMode === "single" ? String(accountInput?.value || "").trim() : ""
    const selectedAccount = accountId ? (S.accounts || []).find((account) => account.id === accountId) : null
    if (routingMode === "single") {
      if (!selectedAccount) {
        showToast?.("请选择可用的后端账号，或切回网关池路由。", "error")
        refreshKeyManageEditor(row)
        return
      }
      if (!accountMatchesScope(selectedAccount, accountScope)) {
        showToast?.(`该后端账号不属于${scopeLabel(accountScope)}。`, "error")
        refreshKeyManageEditor(row)
        return
      }
    }

    const policy = policyInput?.value === "gpt55_xhigh" ? "gpt55_xhigh" : policyInput?.value === "custom" ? "custom" : "standard"
    let fixedModel = String(modelInput?.value || "").trim() || null
    let fixedReasoningEffort = String(reasoningInput?.value || "").trim() || null
    if (policy === "standard") {
      fixedModel = null
      fixedReasoningEffort = null
    } else if (policy === "gpt55_xhigh") {
      fixedModel = "gpt-5.5"
      fixedReasoningEffort = "xhigh"
    }

    const providerId = routingMode === "single" ? selectedAccount?.providerId || row.providerId || "chatgpt" : row.providerId || "chatgpt"
    const button = document.getElementById("keyManageSettingsBtn")
    await runBusy(
      "keyManageSettings",
      async () => {
        await api(`/api/virtual-keys/${encodeURIComponent(id)}/settings`, {
          method: "POST",
          body: JSON.stringify({
            providerId,
            routingMode,
            accountId: routingMode === "single" ? accountId : null,
            accountScope,
            clientMode,
            wireApi,
            fixedModel,
            fixedReasoningEffort,
          }),
        })
        await loadVirtualKeys?.()
        log?.(`Key 签发/路由参数已更新: ${getDisplayName(row)} -> ${scopeLabel(accountScope)} / ${routingMode}`)
      },
      {
        button,
        busyLabel: "保存中...",
        successToast: "Key 参数已更新",
        errorToast: "修改 Key 参数失败",
        rethrow: false,
      },
    )
  }

  function bindKeyManageEditor(row) {
    const scopeInput = document.getElementById("keyManageAccountScopeInput")
    const routingInput = document.getElementById("keyManageRoutingInput")
    const accountInput = document.getElementById("keyManageAccountInput")
    const policyInput = document.getElementById("keyManagePolicyInput")
    const modelInput = document.getElementById("keyManageFixedModelInput")
    const reasoningInput = document.getElementById("keyManageReasoningInput")
    const settingsButton = document.getElementById("keyManageSettingsBtn")
    const onChange = () => refreshKeyManageEditor(row)
    scopeInput?.addEventListener("change", onChange)
    routingInput?.addEventListener("change", onChange)
    accountInput?.addEventListener("change", onChange)
    policyInput?.addEventListener("change", onChange)
    modelInput?.addEventListener("input", () => {
      if (policyInput && policyInput.value !== "gpt55_xhigh" && String(modelInput.value || "").trim()) policyInput.value = "custom"
    })
    reasoningInput?.addEventListener("change", () => {
      if (policyInput && policyInput.value !== "gpt55_xhigh" && String(reasoningInput.value || "").trim()) policyInput.value = "custom"
    })
    settingsButton?.addEventListener("click", () => submitKeyManageSettings(row.id))
    refreshKeyManageEditor(row)
  }

  function drawKeysTable() {
    const tbody = document.getElementById("keysTableBody")
    if (!tbody) return

    if (!S.virtualKeys.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">暂无虚拟 Key，请先签发。</td></tr>'
      return
    }

    const query = normalizeQuery(S.keyQuery)
    const rows = S.virtualKeys.filter((row) => matchesVirtualKeyQuery(row, query))
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">未找到匹配密钥。</td></tr>'
      return
    }

    tbody.innerHTML = rows
      .map((row) => {
        const revealed = S.revealedKeys[row.id]
        const expired = isVirtualKeyExpired(row)
        const fixedPolicy = getFixedPolicyLabel(row)
        const status = row.isRevoked
          ? '<span class="muted">已吊销</span>'
          : expired
            ? '<span class="muted">已过期</span>'
            : '<span class="status-ok">✓ 生效</span>'
        const maskedKey = row.keyPrefix ? `${row.keyPrefix}...` : "-"
        const displayKey = revealed || maskedKey
        return `
          <tr>
            <td>
              <div>${escapeHtml(getDisplayName(row))}</div>
              ${fixedPolicy ? `<div class="muted">Fixed: ${escapeHtml(fixedPolicy)}</div>` : ""}
            </td>
            <td>${escapeHtml(keyAccountLabel(row))}</td>
            <td class="key-cell"><code>${escapeHtml(displayKey)}</code></td>
            <td>${status}</td>
            <td>${Number(row.totalTokens || 0) > 0 ? Number(row.totalTokens).toLocaleString() : "-"}</td>
            <td>${escapeHtml(formatRemainingTime(row.expiresAt))}</td>
            <td>${escapeHtml(dt(row.lastUsedAt))}</td>
            <td>${escapeHtml(dt(row.createdAt))}</td>
            <td>
              <div class="mini-actions">
                <button class="key-mini reveal" data-key-action="toggle-reveal" data-id="${escapeHtml(row.id)}">${revealed ? "收起" : "查看"}</button>
                <button class="key-mini copy" data-key-action="copy" data-id="${escapeHtml(row.id)}" ${row.isRevoked || expired ? "disabled" : ""}>复制</button>
                <button class="key-mini manage" data-key-action="manage" data-id="${escapeHtml(row.id)}">管理</button>
              </div>
            </td>
          </tr>
        `
      })
      .join("")

    tbody.querySelectorAll("[data-key-action]").forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.keyAction
        const id = button.dataset.id
        if (!action || !id) return
        if (action === "toggle-reveal") return toggleRevealVirtualKey(id)
        if (action === "copy") return copyVirtualKey(id)
        if (action === "manage") return openKeyManageModal(id)
      }
    })
  }

  function renderKeyManageModal() {
    if (!S.keyManageId) return
    const row = getVirtualKeyById(S.keyManageId)
    const modal = document.getElementById("keyManageModal")
    if (!modal || !row) {
      closeKeyManageModal()
      return
    }

    const expired = isVirtualKeyExpired(row)
    const title = document.getElementById("keyManageTitle")
    const subtitle = document.getElementById("keyManageSubtitle")
    const secret = document.getElementById("keyManageSecret")
    const meta = document.getElementById("keyManageMeta")
    const actions = document.getElementById("keyManageActions")
    const revealed = S.revealedKeys[row.id]
    const clientModeLabel = getClientModeLabel(row)
    const statusText = row.isRevoked ? "已吊销" : expired ? "已过期" : "生效"
    const renewInput = document.getElementById("keyManageRenewInput")
    const renewButton = document.getElementById("keyManageRenewBtn")

    if (title) title.textContent = getDisplayName(row)
    if (subtitle) subtitle.textContent = `${keyAccountLabel(row)} · ${clientModeLabel}`
    if (secret) secret.textContent = revealed || `${row.keyPrefix || "ocsk_live"}********`
    if (meta) {
      const routeModeText = row.routingMode === "pool" ? "前端固定账号 → 网关池路由" : "高级：强制后端单账号"
      meta.textContent = `类型：${clientModeLabel} | 运行形式：${routeModeText} | 状态：${statusText} | 剩余时间：${formatRemainingTime(row.expiresAt)} | Token：${Number(row.totalTokens || 0).toLocaleString()} | 最近使用：${dt(row.lastUsedAt)}`
    }

    renderKeyUsageButtons(row)
    if (renewInput) renewInput.disabled = row.isRevoked
    if (renewButton) renewButton.disabled = row.isRevoked

    if (actions) {
      actions.innerHTML = `
        ${renderKeySettingsEditor(row)}
        <button class="btn" data-km-action="toggle-reveal">${revealed ? "收起 Key" : "查看完整 Key"}</button>
        <button class="btn" data-km-action="copy" ${row.isRevoked || expired ? "disabled" : ""}>复制 Key</button>
        <button class="btn" data-km-action="test" ${row.isRevoked || expired ? "disabled" : ""}>测试</button>
        ${
          row.isRevoked
            ? '<button class="btn primary" data-km-action="restore">恢复 Key</button>'
            : '<button class="btn danger" data-km-action="revoke">吊销 Key</button>'
        }
        <button class="btn danger" data-km-action="delete">删除 Key</button>
      `
      bindKeyManageEditor(row)
      actions.querySelectorAll("[data-km-action]").forEach((button) => {
        button.onclick = async () => {
          const action = button.dataset.kmAction
          if (action === "toggle-reveal") return toggleRevealVirtualKey(row.id)
          if (action === "copy") return copyVirtualKey(row.id)
          if (action === "test") {
            closeKeyManageModal()
            return openTestModal(row.id, "key")
          }
          if (action === "restore") return restoreVirtualKey(row.id)
          if (action === "revoke") return revokeVirtualKey(row.id)
          if (action === "delete") {
            await deleteVirtualKey(row.id)
            closeKeyManageModal()
          }
        }
      })
    }
  }

  return {
    drawKeysTable,
    renderKeyManageModal,
  }
}
