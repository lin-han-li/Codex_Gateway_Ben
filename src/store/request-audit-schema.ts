export const REQUEST_AUDIT_SUCCESS_SQL = "CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END"
export const REQUEST_AUDIT_ERROR_SQL = "CASE WHEN status_code >= 400 OR IFNULL(error_text, '') <> '' THEN 1 ELSE 0 END"
export const REQUEST_AUDIT_TOTAL_TOKENS_SQL =
  "CASE WHEN total_tokens IS NOT NULL AND total_tokens > 0 THEN total_tokens ELSE COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) END"
export const REQUEST_AUDIT_BILLABLE_TOKENS_SQL =
  "CASE WHEN billable_tokens IS NOT NULL AND billable_tokens > 0 THEN billable_tokens ELSE MAX(COALESCE(input_tokens, 0) - COALESCE(cached_input_tokens, 0), 0) + COALESCE(output_tokens, 0) END"

export const CREATE_REQUEST_AUDITS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS request_audits (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    route TEXT NOT NULL,
    method TEXT NOT NULL,
    provider_id TEXT,
    account_id TEXT,
    virtual_key_id TEXT,
    model TEXT,
    session_id TEXT,
    request_hash TEXT NOT NULL,
    request_bytes INTEGER NOT NULL DEFAULT 0,
    response_bytes INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    upstream_request_id TEXT,
    error_text TEXT,
    client_tag TEXT,
    client_mode TEXT,
    wire_api TEXT,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    billable_tokens INTEGER,
    reasoning_output_tokens INTEGER,
    estimated_cost_usd REAL,
    reasoning_effort TEXT
  );
`

export const REQUEST_AUDIT_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_request_audits_at ON request_audits(at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_request_audits_account ON request_audits(account_id, at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_request_audits_key ON request_audits(virtual_key_id, at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_request_audits_status_at ON request_audits(status_code, at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_request_audits_route_at ON request_audits(route, at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_request_audits_provider_at ON request_audits(provider_id, at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_request_audits_method_at ON request_audits(method, at DESC);",
]

export const CREATE_REQUEST_TOKEN_STATS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS request_token_stats (
    day_key TEXT PRIMARY KEY,
    request_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    billable_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    unpriced_request_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`

export const REQUEST_TOKEN_STATS_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_request_token_stats_updated_at ON request_token_stats(updated_at DESC);",
]

export const REBUILD_REQUEST_TOKEN_STATS_FROM_AUDITS_SQL = `
  DELETE FROM request_token_stats;
  INSERT OR IGNORE INTO request_token_stats (
    day_key,
    request_count,
    success_count,
    error_count,
    input_tokens,
    cached_input_tokens,
    output_tokens,
    total_tokens,
    billable_tokens,
    reasoning_output_tokens,
    estimated_cost_usd,
    unpriced_request_count,
    updated_at
  )
  SELECT
    strftime('%Y-%m-%d', at / 1000.0, 'unixepoch', 'localtime') AS day_key,
    COUNT(*) AS request_count,
    COALESCE(SUM(${REQUEST_AUDIT_SUCCESS_SQL}), 0) AS success_count,
    COALESCE(SUM(${REQUEST_AUDIT_ERROR_SQL}), 0) AS error_count,
    COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND input_tokens > 0 THEN input_tokens ELSE 0 END), 0) AS input_tokens,
    COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL AND cached_input_tokens > 0 THEN cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
    COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL AND output_tokens > 0 THEN output_tokens ELSE 0 END), 0) AS output_tokens,
    COALESCE(SUM(${REQUEST_AUDIT_TOTAL_TOKENS_SQL}), 0) AS total_tokens,
    COALESCE(SUM(${REQUEST_AUDIT_BILLABLE_TOKENS_SQL}), 0) AS billable_tokens,
    COALESCE(SUM(CASE WHEN reasoning_output_tokens IS NOT NULL AND reasoning_output_tokens > 0 THEN reasoning_output_tokens ELSE 0 END), 0) AS reasoning_output_tokens,
    COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL AND estimated_cost_usd > 0 THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd,
    COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL AND total_tokens > 0 AND estimated_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_request_count,
    COALESCE(MAX(at), 0) AS updated_at
  FROM request_audits
  GROUP BY strftime('%Y-%m-%d', at / 1000.0, 'unixepoch', 'localtime');
`
