export function createKeysView(deps) {
  const {
    S,
    esc,
    dt,
    normalizeQuery,
    matchesVirtualKeyQuery,
    isVirtualKeyExpired,
    keyAccountLabel,
    getVirtualKeyById,
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
  } = deps

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
      tbody.innerHTML = '<tr><td colspan="9" class="muted">未找到匹配密钥</td></tr>'
      return
    }

    tbody.innerHTML = rows
      .map((row) => {
        const revealed = S.revealedKeys[row.id]
        const expired = isVirtualKeyExpired(row)
        const status = row.isRevoked
          ? '<span class="muted">已吊销</span>'
          : expired
            ? '<span class="muted">已过期</span>'
            : '<span class="status-ok">✓ 生效</span>'
        const maskedKey = row.keyPrefix ? `${row.keyPrefix}...` : "-"
        const displayKey = revealed || maskedKey
        return `
          <tr>
            <td>${esc(row.name || "未命名 Key")}</td>
            <td>${esc(keyAccountLabel(row))}</td>
            <td class="key-cell"><code>${esc(displayKey)}</code></td>
            <td>${status}</td>
            <td>${Number(row.totalTokens || 0) > 0 ? Number(row.totalTokens).toLocaleString() : "-"}</td>
            <td>${esc(formatRemainingTime(row.expiresAt))}</td>
            <td>${esc(dt(row.lastUsedAt))}</td>
            <td>${esc(dt(row.createdAt))}</td>
            <td>
              <div class="mini-actions">
                <button class="key-mini reveal" data-key-action="toggle-reveal" data-id="${esc(row.id)}">${revealed ? "收起" : "查看"}</button>
                <button class="key-mini copy" data-key-action="copy" data-id="${esc(row.id)}" ${row.isRevoked || expired ? "disabled" : ""}>复制</button>
                <button class="key-mini manage" data-key-action="manage" data-id="${esc(row.id)}">管理</button>
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
    const clientModeLabel = getVirtualKeyClientModeLabel(row)
    const statusText = row.isRevoked ? "已吊销" : expired ? "已过期" : "生效"
    const renewInput = document.getElementById("keyManageRenewInput")
    const renewButton = document.getElementById("keyManageRenewBtn")

    if (title) title.textContent = row.name || "未命名 Key"
    if (subtitle) subtitle.textContent = `${keyAccountLabel(row)} · ${clientModeLabel}`
    if (secret) secret.textContent = revealed || `${row.keyPrefix || "ocsk_live"}********`
    if (meta) {
      const routeModeText = row.routingMode === "pool" ? "前端固定账号经网关路由" : "高级：强制后端单账号"
      meta.textContent = `类型：${clientModeLabel} | 运行形式：${routeModeText} | 状态：${statusText} | 剩余时间：${formatRemainingTime(row.expiresAt)} | Token：${Number(row.totalTokens || 0).toLocaleString()} | 最近使用：${dt(row.lastUsedAt)}`
    }

    renderKeyUsageButtons(row)
    if (renewInput) renewInput.disabled = row.isRevoked
    if (renewButton) renewButton.disabled = row.isRevoked

    if (actions) {
      actions.innerHTML = `
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
      actions.querySelectorAll("[data-km-action]").forEach((button) => {
        button.onclick = async () => {
          const action = button.dataset.kmAction
          if (action === "toggle-reveal") return toggleRevealVirtualKey(row.id)
          if (action === "copy") return copyVirtualKey(row.id)
          if (action === "test") return openTestModal(row.id, "key")
          if (action === "restore") return restoreVirtualKey(row.id)
          if (action === "revoke") return revokeVirtualKey(row.id)
          if (action === "delete") return deleteVirtualKey(row.id)
        }
      })
    }
  }

  return {
    drawKeysTable,
    renderKeyManageModal,
  }
}
