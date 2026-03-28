export type UpstreamRetryPolicy = {
  maxAttempts: number
  baseDelayMs: number
  retry429: boolean
  retry5xx: boolean
  retryTransport: boolean
}

export type UpstreamFetchRetryResult = {
  response: Response
  attempts: number
}

type RetryContext = {
  attempt: number
  maxAttempts: number
  reason: string
  delayMs: number
}

function parseBooleanEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase()
  if (!raw) return fallback
  if (["1", "true", "yes", "on"].includes(raw)) return true
  if (["0", "false", "no", "off"].includes(raw)) return false
  return fallback
}

function parseIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name] ?? "")
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfterMs(headers: Headers) {
  const raw = String(headers.get("retry-after") ?? "").trim()
  if (!raw) return undefined

  const seconds = Number(raw)
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.floor(seconds * 1000))
  }

  const asDate = Date.parse(raw)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now())
  }
  return undefined
}

function computeBackoffMs(baseDelayMs: number, attemptNumber: number) {
  if (attemptNumber <= 0) return baseDelayMs
  const exponential = baseDelayMs * 2 ** Math.max(0, attemptNumber - 1)
  const jitter = 0.9 + Math.random() * 0.2
  return Math.max(1, Math.floor(exponential * jitter))
}

function shouldRetryStatus(status: number, policy: UpstreamRetryPolicy) {
  if (policy.retry429 && status === 429) return true
  if (policy.retry5xx && status >= 500 && status <= 599) return true
  return false
}

function cloneBody(body?: Uint8Array) {
  if (!body) return undefined
  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy
}

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error ?? "unknown_error")
}

export function resolveUpstreamRetryPolicyFromEnv(): UpstreamRetryPolicy {
  return {
    // codex-official defaults:
    // request_max_retries = 4; base_delay = 200ms; retry_429=false; retry_5xx=true; retry_transport=true
    maxAttempts: parseIntegerEnv("OAUTH_UPSTREAM_RETRY_MAX_ATTEMPTS", 4, 0, 100),
    baseDelayMs: parseIntegerEnv("OAUTH_UPSTREAM_RETRY_BASE_DELAY_MS", 200, 1, 60_000),
    retry429: parseBooleanEnv("OAUTH_UPSTREAM_RETRY_429", false),
    retry5xx: parseBooleanEnv("OAUTH_UPSTREAM_RETRY_5XX", true),
    retryTransport: parseBooleanEnv("OAUTH_UPSTREAM_RETRY_TRANSPORT", true),
  }
}

export async function fetchWithUpstreamRetry(input: {
  url: string
  method: string
  headers: Headers
  body?: Uint8Array
  policy: UpstreamRetryPolicy
  onRetry?: (ctx: RetryContext) => void
}): Promise<UpstreamFetchRetryResult> {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= input.policy.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: new Headers(input.headers),
        body: cloneBody(input.body),
      })

      if (!shouldRetryStatus(response.status, input.policy) || attempt >= input.policy.maxAttempts) {
        return {
          response,
          attempts: attempt + 1,
        }
      }

      const retryAfterMs = parseRetryAfterMs(response.headers)
      const delayMs = retryAfterMs ?? computeBackoffMs(input.policy.baseDelayMs, attempt + 1)
      input.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: input.policy.maxAttempts + 1,
        reason: `http_${response.status}`,
        delayMs,
      })
      try {
        response.body?.cancel()
      } catch {
        // ignore stream cancel errors
      }
      await sleep(delayMs)
      continue
    } catch (error) {
      lastError = error
      if (!input.policy.retryTransport || attempt >= input.policy.maxAttempts) {
        throw error
      }
      const delayMs = computeBackoffMs(input.policy.baseDelayMs, attempt + 1)
      input.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: input.policy.maxAttempts + 1,
        reason: `transport:${normalizeErrorMessage(error)}`,
        delayMs,
      })
      await sleep(delayMs)
    }
  }

  throw lastError instanceof Error ? lastError : new Error("retry_limit_reached")
}

