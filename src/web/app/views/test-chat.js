export function createTestChatView(deps) {
  const {
    S,
    api,
    esc,
    ts,
    runBusyAction,
    showToast,
    toErrorMessage,
    getVirtualKeyById,
    getVirtualKeyClientModeLabel,
    ensureTestHistory,
    rememberTestModel,
    openTestModal,
    makeId,
    log,
  } = deps

  function drawTestChatLog() {
    const targetId =
      document.getElementById("testAccount")?.value || (S.testMode === "key" ? S.testKeyId : S.testAccountId)
    const model = document.getElementById("testModel")?.value || ""
    const subtitle = document.getElementById("testSubtitle")
    const root = document.getElementById("testLog")
    const title = document.getElementById("testTitle")
    const keyRow = S.testMode === "key" ? getVirtualKeyById(targetId) : null
    const isCursorKey = keyRow?.clientMode === "cursor"
    if (!subtitle || !root) return

    if (title) {
      title.textContent =
        S.testMode === "key"
          ? isCursorKey
            ? "Cursor Key 兼容测试"
            : "API Key 测试聊天"
          : "账号测试聊天"
    }

    if (S.testMode === "key") {
      subtitle.textContent = keyRow
        ? `${keyRow.name || "未命名 Key"} · ${getVirtualKeyClientModeLabel(keyRow)} · ${model || "未选择模型"}`
        : "请选择 API Key 和模型"
    } else {
      const account = S.accounts.find((a) => a.id === targetId)
      subtitle.textContent = account
        ? `${account.displayName || account.email || account.accountId} · ${model || "未选择模型"}`
        : "请选择账号和模型"
    }

    if (!targetId || !model) {
      root.innerHTML =
        S.testMode === "key"
          ? '<div class="chat-item"><div class="meta">系统</div><div class="text">请选择 API Key 与模型后开始测试。</div></div>'
          : '<div class="chat-item"><div class="meta">系统</div><div class="text">请选择账号与模型后开始测试。</div></div>'
      return
    }

    const history = ensureTestHistory(`${S.testMode}:${targetId}`, model)
    root.innerHTML = history.length
      ? history
          .map(
            (item) => `
              <div class="chat-item${item.pending ? " pending" : ""}">
                <div class="meta">${esc(item.role === "u" ? "用户" : "助手")} · ${esc(ts(item.at))}${item.pending ? " · 思考中" : item.usage ? ` · tokens ${item.usage.totalTokens}` : ""}</div>
                <div class="text">${esc(item.text)}</div>
              </div>
            `,
          )
          .join("")
      : `<div class="chat-item"><div class="meta">系统</div><div class="text">${
          S.testMode === "key" && isCursorKey
            ? "已打开 Cursor 兼容测试会话，输入消息即可验证 /cursor/v1/chat/completions 链路。"
            : "已打开测试会话，输入消息即可发送。"
        }</div></div>`

    root.scrollTop = root.scrollHeight
  }

  async function sendTestChat() {
    const accountSelect = document.getElementById("testAccount")
    const modelSelect = document.getElementById("testModel")
    const input = document.getElementById("testInput")
    const sendButton = document.getElementById("testSend")
    if (!accountSelect || !modelSelect || !input) return

    const targetId = accountSelect.value || ""
    const model = modelSelect.value || ""
    const message = input.value.trim()
    if (!targetId) {
      showToast(S.testMode === "key" ? "请先选择 API Key" : "请先选择账号", "error")
      return
    }
    if (!model) {
      showToast("请先选择模型", "error")
      return
    }
    if (!message) {
      showToast("请输入消息", "error")
      return
    }

    if (S.testMode === "key") S.testKeyId = targetId
    else S.testAccountId = targetId
    S.testModelId = model
    rememberTestModel(S.testMode, targetId, model)
    const keyRow = S.testMode === "key" ? getVirtualKeyById(targetId) : null
    const isCursorKey = keyRow?.clientMode === "cursor"
    const testLabel = S.testMode === "key" ? (isCursorKey ? "Cursor Key" : "API Key") : "账号"
    const sessionKey = `${S.testMode}:${targetId}::${model}`
    if (!S.chatSessions[sessionKey]) {
      S.chatSessions[sessionKey] = makeId()
    }

    const history = ensureTestHistory(`${S.testMode}:${targetId}`, model)
    history.push({ role: "u", text: message, at: Date.now() })
    const pendingReply = { role: "a", text: "助手思考中...", at: Date.now(), pending: true }
    history.push(pendingReply)
    input.value = ""
    drawTestChatLog()

    await runBusyAction(
      "testSend",
      async () => {
        try {
          const endpoint = S.testMode === "key" ? "/api/chat/virtual-key" : "/api/chat"
          const payload =
            S.testMode === "key"
              ? { keyId: targetId, model, message, sessionId: S.chatSessions[sessionKey] }
              : { accountId: targetId, model, message, sessionId: S.chatSessions[sessionKey] }
          const output = await api(endpoint, {
            method: "POST",
            body: JSON.stringify(payload),
          })
          pendingReply.pending = false
          pendingReply.text = output.reply || "(empty)"
          pendingReply.at = Date.now()
          pendingReply.usage = output.usage
          drawTestChatLog()
          log(`测试聊天成功(${testLabel}): ${model} · tokens ${output.usage?.totalTokens ?? 0}`)
        } catch (error) {
          pendingReply.pending = false
          pendingReply.text = `请求失败：${toErrorMessage(error)}`
          pendingReply.at = Date.now()
          drawTestChatLog()
          log(`${testLabel} 测试失败: ${toErrorMessage(error)}`, "error")
          throw error
        }
      },
      {
        button: sendButton,
        busyLabel: isCursorKey ? "验证中..." : "发送中...",
        errorToast: "测试发送失败",
        rethrow: false,
      },
    )
  }

  return {
    drawTestChatLog,
    sendTestChat,
    openTestModal,
  }
}
