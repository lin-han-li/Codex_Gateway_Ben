#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"

normalize_path() {
  local raw="${1:-}"
  if [[ -z "${raw}" ]]; then
    printf '%s' ""
    return 0
  fi

  case "${raw}" in
    /*) printf '%s' "${raw}" ;;
    *) printf '%s/%s' "${ROOT_DIR}" "${raw}" ;;
  esac
}

is_loopback_host() {
  case "${1:-}" in
    ""|127.0.0.1|localhost|::1) return 0 ;;
    *) return 1 ;;
  esac
}

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s\n' "${name}" >&2
    exit 1
  fi
}

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

export OAUTH_APP_HOST="${OAUTH_APP_HOST:-127.0.0.1}"
export OAUTH_APP_PORT="${OAUTH_APP_PORT:-4777}"

if [[ -n "${OAUTH_APP_DATA_DIR:-}" ]]; then
  export OAUTH_APP_DATA_DIR="$(normalize_path "${OAUTH_APP_DATA_DIR}")"
else
  export OAUTH_APP_DATA_DIR="${ROOT_DIR}/data"
fi

if [[ -n "${OAUTH_APP_WEB_DIR:-}" ]]; then
  export OAUTH_APP_WEB_DIR="$(normalize_path "${OAUTH_APP_WEB_DIR}")"
else
  export OAUTH_APP_WEB_DIR="${ROOT_DIR}/src/web"
fi

if [[ -z "${OAUTH_APP_FORWARD_PROXY_PORT:-}" ]]; then
  export OAUTH_APP_FORWARD_PROXY_PORT="$((OAUTH_APP_PORT + 1))"
fi

if [[ ! -f "${OAUTH_APP_WEB_DIR}/index.html" ]]; then
  printf 'Web UI entry not found: %s/index.html\n' "${OAUTH_APP_WEB_DIR}" >&2
  exit 1
fi

if ! is_loopback_host "${OAUTH_APP_HOST}"; then
  require_var OAUTH_APP_ADMIN_TOKEN
  require_var OAUTH_APP_ENCRYPTION_KEY
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'bun was not found in PATH. Install Bun or use Docker deployment.\n' >&2
  exit 1
fi

mkdir -p "${OAUTH_APP_DATA_DIR}"

cd "${ROOT_DIR}"
exec bun run start
