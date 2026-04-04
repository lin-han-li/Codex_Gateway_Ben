export function describeVirtualKeyClientMode(clientMode: string | null | undefined) {
  return clientMode === "cursor" ? "Cursor compatibility" : "Codex"
}

export function buildVirtualKeyModeError(input: {
  key: {
    id?: string
    providerId?: string
    routingMode?: string
    clientMode?: string | null
    wireApi?: string | null
  }
  expectedClientMode: "codex" | "cursor"
  expectedWireApi?: "responses" | "chat_completions"
}) {
  const keyClientMode = input.key.clientMode === "cursor" ? "cursor" : "codex"
  const keyWireApi =
    input.key.wireApi === "chat_completions"
      ? "chat_completions"
      : input.key.wireApi === "responses"
        ? "responses"
        : keyClientMode === "cursor"
          ? "chat_completions"
          : "responses"
  const modeMatches = keyClientMode === input.expectedClientMode
  const wireMatches = !input.expectedWireApi || keyWireApi === input.expectedWireApi
  if (modeMatches && wireMatches) return null
  if (input.expectedWireApi && keyWireApi !== input.expectedWireApi) {
    if (input.expectedClientMode === "cursor") {
      return {
        status: 403 as const,
        error: "This virtual API key is for Codex clients only. Use /v1/* endpoints.",
      }
    }
    return {
      status: 403 as const,
      error: "This virtual API key is for Cursor compatibility only. Use /cursor/v1/* endpoints.",
    }
  }
  if (input.expectedClientMode === "cursor") {
    return {
      status: 403 as const,
      error: "This virtual API key is for Codex clients only. Use /v1/* endpoints.",
    }
  }
  return {
    status: 403 as const,
    error: "This virtual API key is for Cursor compatibility only. Use /cursor/v1/* endpoints.",
  }
}
