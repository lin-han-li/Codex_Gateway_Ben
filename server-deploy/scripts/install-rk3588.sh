#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
SERVICE_NAME="codex-gateway"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

ensure_arm64_board() {
  local arch
  arch="$(uname -m)"
  case "${arch}" in
    aarch64|arm64) ;;
    *)
      printf 'This installer targets Linux arm64 boards (detected: %s)\n' "${arch}" >&2
      exit 1
      ;;
  esac
}

install_bun_if_missing() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi

  require_cmd curl
  printf 'bun not found, installing Bun via the official installer...\n'
  curl -fsSL https://bun.com/install | bash

  export BUN_INSTALL="${HOME}/.bun"
  export PATH="${BUN_INSTALL}/bin:${PATH}"

  if ! command -v bun >/dev/null 2>&1; then
    printf 'bun installation finished but bun is still not in PATH.\n' >&2
    printf 'Open a new shell or add ~/.bun/bin to PATH, then rerun this script.\n' >&2
    exit 1
  fi
}

ensure_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    cp "${ROOT_DIR}/.env.example" "${ENV_FILE}"
    printf 'Created %s from .env.example\n' "${ENV_FILE}"
  fi
}

install_dependencies() {
  cd "${ROOT_DIR}"
  bun install --production
}

enable_systemd_service() {
  if [[ ! -d /run/systemd/system ]]; then
    printf 'systemd not detected. Skipping service installation.\n'
    return 0
  fi

  local service_user service_home service_path
  service_user="${SUDO_USER:-${USER}}"
  service_home="$(eval echo "~${service_user}")"
  service_path="/etc/systemd/system/${SERVICE_NAME}.service"

  if [[ ! -w /etc/systemd/system ]]; then
    printf 'No permission to install systemd service. Run the following manually as root if needed:\n'
    printf '  sudo bash -c '\''cat > %s <<EOF\n' "${service_path}"
    printf '[Unit]\nDescription=Codex Gateway\nAfter=network-online.target\nWants=network-online.target\n\n'
    printf '[Service]\nType=simple\nUser=%s\nGroup=%s\nWorkingDirectory=%s\n' "${service_user}" "${service_user}" "${ROOT_DIR}"
    printf 'Environment=ENV_FILE=%s\n' "${ENV_FILE}"
    printf 'Environment=PATH=%s/.bun/bin:/usr/local/bin:/usr/bin:/bin\n' "${service_home}"
    printf 'ExecStart=%s/start.sh\nRestart=always\nRestartSec=5\nTimeoutStopSec=20\n\n' "${ROOT_DIR}"
    printf '[Install]\nWantedBy=multi-user.target\nEOF'\''\n'
    printf '  sudo systemctl daemon-reload && sudo systemctl enable --now %s\n' "${SERVICE_NAME}"
    return 0
  fi

  cat > "${service_path}" <<EOF
[Unit]
Description=Codex Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${service_user}
Group=${service_user}
WorkingDirectory=${ROOT_DIR}
Environment=ENV_FILE=${ENV_FILE}
Environment=PATH=${service_home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${ROOT_DIR}/start.sh
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
  systemctl status "${SERVICE_NAME}" --no-pager || true
}

main() {
  ensure_arm64_board
  install_bun_if_missing
  ensure_env_file
  mkdir -p "${ROOT_DIR}/data"
  install_dependencies
  chmod +x "${ROOT_DIR}/start.sh"
  enable_systemd_service

  printf '\nRK3588 bundle is ready.\n'
  printf 'Edit %s before public exposure, especially:\n' "${ENV_FILE}"
  printf '  - OAUTH_APP_ADMIN_TOKEN\n'
  printf '  - OAUTH_APP_ENCRYPTION_KEY\n'
  printf '  - OAUTH_APP_HOST / OAUTH_APP_PORT\n'
}

main "$@"
