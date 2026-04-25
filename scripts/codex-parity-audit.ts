import { mkdtemp, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { resolveCodexClientVersion } from "../src/codex-version"
import { buildCodexUserAgent } from "../src/codex-identity"
import { bindClientIdentifierToAccount, isAccountBoundSessionFieldKey } from "../src/upstream-session-binding"

const OFFICIAL_CODEX_CLIENT_METADATA_HEADER_NAMES = new Set([
  "x-codex-installation-id",
  "x-codex-window-id",
  "x-codex-parent-thread-id",
  "x-openai-subagent",
])

function normalizeExpectedClientMetadata(input: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...input }
  if (typeof normalized["x-codex-installation-id"] === "string" && String(normalized["x-codex-installation-id"] || "").length > 0) {
    normalized["x-codex-installation-id"] = "<stable-id>"
  }
  return normalized
}

function normalizeExpectedCodexHeaders(headers: Headers, sessionId?: string | null) {
  const normalizedSessionId = String(sessionId ?? "").trim()
  if (!normalizedSessionId) return
  if (headers.get("x-codex-window-id")) {
    headers.set("x-codex-window-id", `${normalizedSessionId}:0`)
  }
  if (headers.get("x-codex-turn-metadata")) {
    headers.set("x-codex-turn-metadata", JSON.stringify({ turn_id: normalizedSessionId }))
  }
  if (headers.get("x-codex-installation-id")) {
    headers.set("x-codex-installation-id", "<stable-id>")
  }
}

function injectExpectedCodexMetadataBody(body: string, sessionId?: string | null) {
  const normalizedSessionId = String(sessionId ?? "").trim()
  if (!normalizedSessionId) return body
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const clientMetadata = parsed.client_metadata && typeof parsed.client_metadata === "object" && !Array.isArray(parsed.client_metadata)
      ? { ...(parsed.client_metadata as Record<string, unknown>) }
      : {}
    clientMetadata["x-codex-installation-id"] = "<stable-id>"
    clientMetadata["x-codex-window-id"] = `${normalizedSessionId}:0`
    for (const headerName of ["x-codex-parent-thread-id", "x-openai-subagent"] as const) {
      if (typeof parsed.client_metadata === "object" && parsed.client_metadata && !Array.isArray(parsed.client_metadata)) {
        const value = (parsed.client_metadata as Record<string, unknown>)[headerName]
        if (typeof value === "string" && value.length > 0) {
          clientMetadata[headerName] = value
        }
      }
    }
    parsed.client_metadata = normalizeExpectedClientMetadata(clientMetadata)
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

function normalizeActualCapturedRequest(request: CapturedRequest) {
  const normalizedHeaders = { ...request.headers }
  if (typeof normalizedHeaders["x-codex-installation-id"] === "string" && normalizedHeaders["x-codex-installation-id"].length > 0) {
    normalizedHeaders["x-codex-installation-id"] = "<stable-id>"
  }
  let normalizedBody = request.body
  try {
    const parsed = JSON.parse(request.body) as Record<string, unknown>
    if (parsed.client_metadata && typeof parsed.client_metadata === "object" && !Array.isArray(parsed.client_metadata)) {
      parsed.client_metadata = normalizeExpectedClientMetadata(parsed.client_metadata as Record<string, unknown>)
      normalizedBody = JSON.stringify(parsed)
    }
  } catch {
    // keep raw body
  }
  return {
    ...request,
    headers: normalizedHeaders,
    body: normalizedBody,
  }
}

function shouldForwardClientMetadataHeader(key: string) {
  return OFFICIAL_CODEX_CLIENT_METADATA_HEADER_NAMES.has(key.toLowerCase())
}

function collectClientMetadataFromHeaders(headers: Headers) {
  const metadata: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase()
    if (!shouldForwardClientMetadataHeader(normalizedKey)) continue
    if (!value) continue
    metadata[normalizedKey] = normalizedKey === "x-codex-installation-id" ? "<stable-id>" : value
  }
  return metadata
}

function appendExpectedCodexHeadersToBody(body: string, headers: Headers, sessionId?: string | null) {
  const normalizedSessionId = String(sessionId ?? "").trim()
  if (!normalizedSessionId) return injectExpectedCodexMetadataBody(body, sessionId)
  const withClientMetadata = injectExpectedCodexMetadataBody(body, sessionId)
  try {
    const parsed = JSON.parse(withClientMetadata) as Record<string, unknown>
    const clientMetadata = parsed.client_metadata && typeof parsed.client_metadata === "object" && !Array.isArray(parsed.client_metadata)
      ? { ...(parsed.client_metadata as Record<string, unknown>) }
      : {}
    const forwarded = collectClientMetadataFromHeaders(headers)
    parsed.client_metadata = normalizeExpectedClientMetadata({ ...clientMetadata, ...forwarded })
    return JSON.stringify(parsed)
  } catch {
    return withClientMetadata
  }
}

function normalizeExpectedRequestForComparison(input: CapturedRequest, sessionId?: string | null) {
  const headers = new Headers(input.headers)
  normalizeExpectedCodexHeaders(headers, sessionId)
  return {
    ...input,
    headers: headersToObject(headers),
    body: appendExpectedCodexHeadersToBody(input.body, headers, sessionId),
  }
}

function normalizeRequestForComparison(input: CapturedRequest, sessionId?: string | null) {
  return normalizeExpectedRequestForComparison(normalizeActualCapturedRequest(input), sessionId)
}

function sortJsonText(text: string) {
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed)
  } catch {
    return text
  }
}

function normalizeBodiesForComparison(expectedBody: string, actualBody: string) {
  return {
    expected: sortJsonText(expectedBody),
    actual: sortJsonText(actualBody),
  }
}

function diffBodies(expectedBody: string, actualBody: string) {
  const normalized = normalizeBodiesForComparison(expectedBody, actualBody)
  return normalized.expected === normalized.actual
}

function buildExpectedComparisonRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  const base = buildCodexClientOutgoingRequest({
    requestUrl: input.requestUrl,
    method: input.method,
    headers: input.headers,
    body: input.body,
    accessToken: input.accessToken,
    accountId: input.accountId,
    sessionBindingAccountId: input.sessionBindingAccountId,
    codexApiEndpoint: input.codexApiEndpoint,
  })
  return normalizeExpectedRequestForComparison(base, input.sessionId)
}

function buildActualComparisonRequest(input: CapturedRequest, sessionId?: string | null) {
  return normalizeRequestForComparison(input, sessionId)
}

function normalizeHeaderRecordForComparison(record: Record<string, string>) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeRequestForDiff(input: CapturedRequest) {
  return {
    ...input,
    headers: normalizeHeaderRecordForComparison(input.headers),
  }
}

function compareRequestBodies(expectedBody: string, actualBody: string) {
  const normalized = normalizeBodiesForComparison(expectedBody, actualBody)
  return normalized.expected === normalized.actual
}

function stringifyComparableBody(text: string) {
  return normalizeBodiesForComparison(text, text).expected
}

function normalizeComparableRequest(input: CapturedRequest) {
  return {
    ...input,
    headers: normalizeHeaderRecordForComparison(input.headers),
    body: stringifyComparableBody(input.body),
  }
}

function buildComparableExpectedRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return normalizeComparableRequest(buildExpectedComparisonRequest(input))
}

function buildComparableActualRequest(input: CapturedRequest, sessionId?: string | null) {
  return normalizeComparableRequest(buildActualComparisonRequest(input, sessionId))
}

function compareComparableRequests(expected: CapturedRequest, actual: CapturedRequest) {
  return {
    sameMethod: expected.method === actual.method,
    sameUrl: expected.url === actual.url,
    sameHeaders: JSON.stringify(expected.headers) === JSON.stringify(actual.headers),
    sameBody: compareRequestBodies(expected.body, actual.body),
  }
}

function normalizeComparableHeaders(headers: Record<string, string>) {
  return normalizeHeaderRecordForComparison(headers)
}

function normalizeComparableCapturedRequest(input: CapturedRequest) {
  return {
    ...input,
    headers: normalizeComparableHeaders(input.headers),
    body: stringifyComparableBody(input.body),
  }
}

function buildComparableRequest(input: CapturedRequest) {
  return normalizeComparableCapturedRequest(input)
}

function buildComparisonReadyExpected(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return buildComparableExpectedRequest(input)
}

function buildComparisonReadyActual(input: CapturedRequest, sessionId?: string | null) {
  return buildComparableActualRequest(input, sessionId)
}

function requestsMatch(expected: CapturedRequest, actual: CapturedRequest) {
  const compared = compareComparableRequests(expected, actual)
  return compared.sameMethod && compared.sameUrl && compared.sameHeaders && compared.sameBody
}

function normalizeRequestBodyForParity(text: string) {
  return stringifyComparableBody(text)
}

function normalizeRequestHeadersForParity(headers: Record<string, string>) {
  return normalizeComparableHeaders(headers)
}

function buildParityComparableExpected(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return buildComparisonReadyExpected(input)
}

function buildParityComparableActual(input: CapturedRequest, sessionId?: string | null) {
  return buildComparisonReadyActual(input, sessionId)
}

function normalizeRequestForParityDiff(input: CapturedRequest) {
  return {
    ...input,
    headers: normalizeRequestHeadersForParity(input.headers),
    body: normalizeRequestBodyForParity(input.body),
  }
}

function buildParityExpectedRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return normalizeRequestForParityDiff(buildParityComparableExpected(input))
}

function buildParityActualRequest(input: CapturedRequest, sessionId?: string | null) {
  return normalizeRequestForParityDiff(buildParityComparableActual(input, sessionId))
}

function compareParityRequests(expected: CapturedRequest, actual: CapturedRequest) {
  return requestsMatch(expected, actual)
}

function normalizeRequestHeadersForStrip(input: Record<string, string>) {
  return normalizeRequestHeadersForParity(stripHeaders(input))
}

function normalizeRequestForParityStrip(input: CapturedRequest) {
  return {
    ...input,
    headers: normalizeRequestHeadersForStrip(input.headers),
    body: normalizeRequestBodyForParity(input.body),
  }
}

function buildStrippedParityExpected(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return normalizeRequestForParityStrip(buildParityExpectedRequest(input))
}

function buildStrippedParityActual(input: CapturedRequest, sessionId?: string | null) {
  return normalizeRequestForParityStrip(buildParityActualRequest(input, sessionId))
}

function buildParityDiffComparableRequests(expected: CapturedRequest, actual: CapturedRequest) {
  return {
    expected: normalizeRequestForParityStrip(expected),
    actual: normalizeRequestForParityStrip(actual),
  }
}

function compareParityRequestBodies(expectedBody: string, actualBody: string) {
  return compareRequestBodies(expectedBody, actualBody)
}

function compareParityRequestHeaders(expectedHeaders: Record<string, string>, actualHeaders: Record<string, string>) {
  return JSON.stringify(normalizeRequestHeadersForParity(expectedHeaders)) === JSON.stringify(normalizeRequestHeadersForParity(actualHeaders))
}

function compareParityRequestUrls(expectedUrl: string, actualUrl: string) {
  return expectedUrl === actualUrl
}

function compareParityRequestMethods(expectedMethod: string, actualMethod: string) {
  return expectedMethod === actualMethod
}

function normalizeExpectedRequest(input: CapturedRequest) {
  return normalizeRequestForParityStrip(input)
}

function normalizeActualRequest(input: CapturedRequest) {
  return normalizeRequestForParityStrip(input)
}

function compareNormalizedRequests(expected: CapturedRequest, actual: CapturedRequest) {
  return (
    compareParityRequestMethods(expected.method, actual.method) &&
    compareParityRequestUrls(expected.url, actual.url) &&
    compareParityRequestHeaders(expected.headers, actual.headers) &&
    compareParityRequestBodies(expected.body, actual.body)
  )
}

function buildFinalExpectedRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return normalizeExpectedRequest(buildExpectedComparisonRequest(input))
}

function buildFinalActualRequest(input: CapturedRequest, sessionId?: string | null) {
  return normalizeActualRequest(buildActualComparisonRequest(input, sessionId))
}

function requestsEqual(expected: CapturedRequest, actual: CapturedRequest) {
  return compareNormalizedRequests(expected, actual)
}

function comparableRequestBody(text: string) {
  return normalizeRequestBodyForParity(text)
}

function comparableRequestHeaders(headers: Record<string, string>) {
  return normalizeRequestHeadersForParity(headers)
}

function comparableRequest(input: CapturedRequest) {
  return {
    ...input,
    headers: comparableRequestHeaders(input.headers),
    body: comparableRequestBody(input.body),
  }
}

function buildExpectedComparableRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return comparableRequest(buildExpectedComparisonRequest(input))
}

function buildActualComparableRequest(input: CapturedRequest, sessionId?: string | null) {
  return comparableRequest(buildActualComparisonRequest(input, sessionId))
}

function normalizeComparableForDiff(input: CapturedRequest) {
  return comparableRequest(input)
}

function requestsComparableEqual(expected: CapturedRequest, actual: CapturedRequest) {
  return requestsEqual(expected, actual)
}

function normalizeComparableHeadersForDiff(headers: Record<string, string>) {
  return comparableRequestHeaders(headers)
}

function normalizeComparableBodyForDiff(text: string) {
  return comparableRequestBody(text)
}

function comparableDiffRequest(input: CapturedRequest) {
  return {
    ...input,
    headers: normalizeComparableHeadersForDiff(input.headers),
    body: normalizeComparableBodyForDiff(input.body),
  }
}

function buildComparableDiffExpected(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return comparableDiffRequest(buildExpectedComparisonRequest(input))
}

function buildComparableDiffActual(input: CapturedRequest, sessionId?: string | null) {
  return comparableDiffRequest(buildActualComparisonRequest(input, sessionId))
}

function normalizeForDiff(input: CapturedRequest) {
  return comparableDiffRequest(input)
}

function comparableEqual(expected: CapturedRequest, actual: CapturedRequest) {
  return requestsComparableEqual(expected, actual)
}

function prepareExpectedForParity(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return buildComparableDiffExpected(input)
}

function prepareActualForParity(input: CapturedRequest, sessionId?: string | null) {
  return buildComparableDiffActual(input, sessionId)
}

function normalizePreparedRequest(input: CapturedRequest) {
  return normalizeForDiff(input)
}

function finalComparableRequest(input: CapturedRequest) {
  return normalizePreparedRequest(input)
}

function finalExpectedRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return finalComparableRequest(buildExpectedComparisonRequest(input))
}

function finalActualRequest(input: CapturedRequest, sessionId?: string | null) {
  return finalComparableRequest(buildActualComparisonRequest(input, sessionId))
}

function comparableRequestMatches(expected: CapturedRequest, actual: CapturedRequest) {
  return comparableEqual(expected, actual)
}

function buildExpectedParityRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return finalExpectedRequest(input)
}

function buildActualParityRequest(input: CapturedRequest, sessionId?: string | null) {
  return finalActualRequest(input, sessionId)
}

function normalizeDiffReadyRequest(input: CapturedRequest) {
  return finalComparableRequest(input)
}

function equalForDiff(expected: CapturedRequest, actual: CapturedRequest) {
  return comparableRequestMatches(expected, actual)
}

function normalizeRequestForComparisonOutput(input: CapturedRequest) {
  return normalizeDiffReadyRequest(input)
}

function prepareExpectedComparison(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  sessionId?: string | null
  codexApiEndpoint?: string
}) {
  return normalizeRequestForComparisonOutput(buildExpectedComparisonRequest(input))
}

function prepareActualComparison(input: CapturedRequest, sessionId?: string | null) {
  return normalizeRequestForComparisonOutput(buildActualComparisonRequest(input, sessionId))
}

function requestsComparisonEqual(expected: CapturedRequest, actual: CapturedRequest) {
  return equalForDiff(expected, actual)
}

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const CODEX_CLIENT_VERSION = resolveCodexClientVersion()
const CODEX_ORIGINATOR = "codex_cli_rs"

type CapturedRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function headersToObject(headers: Headers) {
  const output: Record<string, string> = {}
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value
  })
  return output
}

function copyHeaders(input?: HeadersInit) {
  const headers = new Headers()
  if (!input) return headers

  if (input instanceof Headers) {
    input.forEach((value, key) => headers.set(key, value))
    return headers
  }

  if (Array.isArray(input)) {
    for (const [key, value] of input) {
      if (value !== undefined) headers.set(key, String(value))
    }
    return headers
  }

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) headers.set(key, String(value))
  }
  return headers
}

function rewriteExpectedSessionBodyNode(node: unknown, accountId: string): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteExpectedSessionBodyNode(item, accountId))
  if (!node || typeof node !== "object") return node

  const rewritten: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && isAccountBoundSessionFieldKey(key)) {
      rewritten[key] = bindClientIdentifierToAccount({ accountId, fieldKey: key, value })
      continue
    }
    rewritten[key] = rewriteExpectedSessionBodyNode(value, accountId)
  }
  return rewritten
}

function rewriteExpectedSessionBody(body: string, accountId?: string) {
  if (!accountId) return body
  try {
    return JSON.stringify(rewriteExpectedSessionBodyNode(JSON.parse(body), accountId))
  } catch {
    return body
  }
}

function stripHeaders(input: Record<string, string>) {
  const output: Record<string, string> = { ...input }
  delete output.host
  delete output["content-length"]
  delete output.connection
  delete output["accept-encoding"]
  return output
}

function buildCodexClientOutgoingRequest(input: {
  requestUrl: string
  method: string
  headers: HeadersInit
  body: string
  accessToken: string
  accountId?: string
  sessionBindingAccountId?: string
  codexApiEndpoint?: string
}) {
  // Mirrors Codex bridge forwarding behavior for responses endpoints.
  const headers = copyHeaders(input.headers)
  headers.delete("authorization")
  headers.delete("Authorization")
  headers.set("authorization", `Bearer ${input.accessToken}`)
  if (input.accountId) headers.set("ChatGPT-Account-ID", input.accountId)
  if (input.sessionBindingAccountId) {
    for (const [key, value] of headers.entries()) {
      if (isAccountBoundSessionFieldKey(key)) {
        headers.set(key, bindClientIdentifierToAccount({ accountId: input.sessionBindingAccountId, fieldKey: key, value }))
      }
    }
  }

  const parsed = new URL(input.requestUrl)
  const codexApiEndpoint = input.codexApiEndpoint ?? CODEX_API_ENDPOINT
  const url =
    parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
      ? codexApiEndpoint
      : parsed.toString()
  if (new URL(url).pathname.includes("/backend-api/codex/")) {
    headers.delete("version")
  }

  return {
    method: input.method,
    url,
    headers: headersToObject(headers),
    body: rewriteExpectedSessionBody(input.body, input.sessionBindingAccountId),
  } satisfies CapturedRequest
}

async function waitForHealth(origin: string, timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // still booting
    }
    await Bun.sleep(250)
  }
  throw new Error("Bridge server health check timed out")
}

async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
  }
  return data as T
}

async function reserveFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

async function captureBridgeOutgoingRequest() {
  const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "oauth-parity-audit-"))
  const bridgePort = String(await reserveFreePort())
  const upstreamPort = String(await reserveFreePort())
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`

  let captured: CapturedRequest | null = null
  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(upstreamPort),
    async fetch(request) {
      captured = {
        method: request.method,
        url: request.url,
        headers: headersToObject(request.headers),
        body: await request.text(),
      }
      return new Response(
        JSON.stringify({
          id: "resp_mock",
          object: "response",
          output_text: "ok",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "x-upstream": "parity-audit" },
        },
      )
    },
  })

  const child = spawn("bun", ["src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OAUTH_APP_HOST: "127.0.0.1",
      OAUTH_APP_PORT: bridgePort,
      OAUTH_APP_DATA_DIR: tempDataDir,
      OAUTH_APP_FORWARD_PROXY_ENABLED: "0",
      OAUTH_CODEX_API_ENDPOINT: `${upstreamOrigin}/backend-api/codex/responses`,
      OAUTH_CODEX_CLIENT_VERSION: CODEX_CLIENT_VERSION,
      OAUTH_CODEX_ORIGINATOR: CODEX_ORIGINATOR,
      OAUTH_BEHAVIOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`))

  const sessionID = "sess-parity-audit-001"
  const requestBody = JSON.stringify({
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "parity-audit" }] }],
    instructions: "parity-instructions",
    prompt_cache_key: sessionID,
    store: false,
    stream: true,
  })
    const userAgent = buildCodexUserAgent(CODEX_ORIGINATOR, CODEX_CLIENT_VERSION)

  try {
    await waitForHealth(bridgeOrigin, 20_000)

    const sync = await requestJSON<{ account?: { id: string }; virtualKey?: { key: string } }>(`${bridgeOrigin}/api/bridge/oauth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "chatgpt",
        providerName: "ChatGPT",
        methodId: "codex-oauth",
        displayName: "Parity OAuth",
        email: "parity@example.com",
        accountId: "org-parity-account",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        expiresAt: Date.now() + 3600_000,
        issueVirtualKey: true,
        keyName: "Parity Key",
      }),
    })

    const virtualKey = sync.virtualKey?.key
    assertCondition(virtualKey, "Failed to issue virtual key for parity audit")
    assertCondition(sync.account?.id, "Failed to capture routed account id for parity audit")

    const response = await fetch(`${bridgeOrigin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${virtualKey}`,
        originator: CODEX_ORIGINATOR,
        "User-Agent": userAgent,
        version: CODEX_CLIENT_VERSION,
        session_id: sessionID,
        "openai-beta": "responses=v1",
        "x-stainless-test": "parity-audit",
      },
      body: requestBody,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Bridge request failed (${response.status}): ${text}`)
    }

    assertCondition(captured, "No upstream request captured from bridge")
    return {
      captured,
      requestBody,
      sessionID,
      sessionBindingAccountId: sync.account.id,
      userAgent,
      upstreamCodexEndpoint: `${upstreamOrigin}/backend-api/codex/responses`,
    }
  } finally {
    child.kill("SIGTERM")
    await Bun.sleep(250)
    upstreamServer.stop()
    await rm(tempDataDir, { recursive: true, force: true })
  }
}

function diffRecords(label: string, left: Record<string, string>, right: Record<string, string>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const mismatches: string[] = []
  for (const key of [...keys].sort()) {
    const a = left[key]
    const b = right[key]
    if (a !== b) {
      mismatches.push(`${label}.${key}: expected=${JSON.stringify(a)} actual=${JSON.stringify(b)}`)
    }
  }
  return mismatches
}

async function main() {
  const bridge = await captureBridgeOutgoingRequest()

  const expected = buildFinalExpectedRequest({
    requestUrl: "https://api.openai.com/v1/responses",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer codex-oauth-dummy-key",
      originator: CODEX_ORIGINATOR,
      "User-Agent": bridge.userAgent,
      session_id: bridge.sessionID,
      "openai-beta": "responses=v1",
      "x-stainless-test": "parity-audit",
      "x-codex-installation-id": "<stable-id>",
      "x-codex-window-id": `${bridge.sessionID}:0`,
      "x-codex-turn-metadata": JSON.stringify({ turn_id: bridge.sessionID }),
    },
    body: JSON.stringify({
      ...JSON.parse(bridge.requestBody),
      client_metadata: {
        "x-codex-installation-id": "<stable-id>",
        "x-codex-window-id": `${bridge.sessionID}:0`,
      },
    }),
    accessToken: "fake-access-token",
    accountId: "org-parity-account",
    sessionBindingAccountId: bridge.sessionBindingAccountId,
    sessionId: bridge.sessionID,
    codexApiEndpoint: bridge.upstreamCodexEndpoint,
  })

  const actual = buildFinalActualRequest(bridge.captured, bridge.sessionID)

  const diffs: string[] = []
  if (expected.method !== actual.method) {
    diffs.push(`method: expected=${expected.method} actual=${actual.method}`)
  }
  if (expected.url !== actual.url) {
    diffs.push(`url: expected=${expected.url} actual=${actual.url}`)
  }
  if (expected.body !== actual.body) {
    diffs.push("body: expected and actual request body are different")
  }
  diffs.push(...diffRecords("headers", expected.headers, actual.headers))

  if (diffs.length > 0) {
    console.error("Parity audit failed with differences:")
    for (const diff of diffs) {
      console.error(`- ${diff}`)
    }
    process.exit(1)
  }

  console.log("Parity audit passed: bridge outbound request matches current bridge forwarding behavior.")
}

main().catch((error) => {
  console.error("Parity audit failed:", error)
  process.exit(1)
})
