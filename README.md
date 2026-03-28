# OAuth Multi Login App

Desktop OAuth multi-account login app, aligned with the `codex-official` OAuth and API bridge behavior:
- ChatGPT Browser PKCE + local callback (`http://localhost:1455/auth/callback`)
- ChatGPT Headless Device flow
- GitHub Copilot Device flow (`github.com` and enterprise hostname)
- Multi-account storage (SQLite), with activate/refresh/delete

## Run in dev mode
```bash
cd D:/Server/chatgpt/oauth-multi-login-app
bun install
bun run dev
```

Open: `http://127.0.0.1:4777`

## Build desktop installer
```bash
cd D:/Server/chatgpt/oauth-multi-login-app
bun install
bun run dist:win
```

Windows installer output is generated under `dist/` (NSIS `.exe`).

Linux packages must be built on Linux:
```bash
cd D:/Server/chatgpt/oauth-multi-login-app
bun install
bun run dist:linux
```

This produces Linux artifacts under `dist/` (`.AppImage`, `.deb`, `.tar.gz`).

macOS packages must be built on macOS:
```bash
cd D:/Server/chatgpt/oauth-multi-login-app
bun install
bun run dist:mac
```

This produces macOS artifacts under `dist/` (`.dmg`, `.zip`).

Cross-building from a different host OS is intentionally blocked because the bundled local server is compiled as a native standalone binary for the host platform.

## Build validation
```bash
bun run verify:desktop
```

This runs TypeScript checking plus syntax validation for the embedded desktop web UI in:
- `src/web/index.html`
- `server-deploy/src/web/index.html`
- `server-runtime-bundle/src/web/index.html`

## GitHub Actions cross-platform release

The workflow [`.github/workflows/build-desktop.yml`](./.github/workflows/build-desktop.yml) builds desktop artifacts on native runners:
- `windows-latest` -> NSIS `.exe`
- `ubuntu-latest` -> `.AppImage`, `.deb`, `.tar.gz`
- `macos-latest` -> `.dmg`, `.zip`

Tagging a release like `v1.1.8` will also publish those artifacts to GitHub Releases.

## Desktop local run (without installer)
```bash
cd D:/Server/chatgpt/oauth-multi-login-app
bun install
bun run desktop:dev
```

## Environment variables
- `OAUTH_APP_HOST`: web host, default `127.0.0.1`
- `OAUTH_APP_PORT`: web port, default `4777`
- `OAUTH_APP_DATA_DIR`: token/database directory
- `OAUTH_APP_WEB_DIR`: UI directory (used by packaged desktop mode)
- `OAUTH_APP_ADMIN_TOKEN`: management API token. Required when binding to non-loopback host.
- `OAUTH_APP_ENCRYPTION_KEY`: secret encryption key for stored tokens/keys. Required when binding to non-loopback host.
- `OAUTH_CODEX_API_BASE`: Codex upstream base URL, default `https://chatgpt.com/backend-api/codex`
- `OAUTH_CODEX_ORIGINATOR`: originator header value, default `codex_cli_rs`
- `OAUTH_CODEX_CLIENT_VERSION`: Codex protocol client version for headers/user-agent (default auto-resolves from local `codex-official` tags, then falls back to stable official version)
- `OAUTH_CODEX_PROMPT_FILE`: optional prompt file path
- `OAUTH_CODEX_MODELS_FILE`: optional models catalog file path
- `OAUTH_CODEX_ALLOWED_WORKSPACE_ID`: optional forced ChatGPT workspace id for OAuth authorize URL
- `OAUTH_APP_FORWARD_PROXY_ENABLED`: enable restricted forward proxy (`1` by default)
- `OAUTH_APP_FORWARD_PROXY_PORT`: forward proxy port (default: `OAUTH_APP_PORT + 1`)
- `OAUTH_APP_FORWARD_PROXY_ALLOWED_HOSTS`: comma-separated allowlist for CONNECT/HTTP proxy targets (supports exact host or suffix such as `.openai.com`; default includes OpenAI/Codex host families)
- `OAUTH_APP_FORWARD_PROXY_ENFORCE_ALLOWLIST`: when `1`, deny non-allowlisted hosts; default `0` (compat mode passthrough + logging)

Identity-header policy:
- Upstream `originator`, `user-agent`, and `version` are always enforced by the bridge to Codex official defaults (or configured overrides) and are not passthrough from client requests.

## Virtual key bridge APIs

- `POST /api/bridge/oauth/sync`: sync Codex OAuth credentials and optionally issue virtual key.
- `POST /api/virtual-keys/issue`: issue a new virtual key for an existing account.
- `GET /api/virtual-keys`: list virtual keys.
- `POST /api/virtual-keys/:id/revoke`: revoke virtual key.
- OpenAI-compatible bridge ingress:
  - `POST /v1/responses`
  - `POST /v1/responses/compact`
  - `GET /v1/models`
  - `GET /v1/models/:id`

## Bridge regression test

```bash
cd D:/Server/chatgpt/oauth-multi-login-app
bun run test:bridge
```

This test validates sync/issue/list/revoke and revoked-key rejection (`401`) behavior.

## Codex integration sample

See:
- `integrations/codex-virtual-key-bridge.plugin.ts`
- `integrations/README.md`

## Security note
When `OAUTH_APP_ENCRYPTION_KEY` is set, account tokens and virtual key secrets are encrypted before persistence.
For non-loopback service binding, both `OAUTH_APP_ADMIN_TOKEN` and `OAUTH_APP_ENCRYPTION_KEY` are enforced.

## Optional: proxy api.openai.com / auth.openai.com via gateway

When forward proxy is enabled, point Codex client process proxy vars to gateway:

```powershell
$env:HTTPS_PROXY = "http://192.168.0.139:4510"
$env:HTTP_PROXY = "http://192.168.0.139:4510"
$env:ALL_PROXY = "http://192.168.0.139:4510"
$env:NO_PROXY = "localhost,127.0.0.1,192.168.0.139"
```

This allows client-side traffic targeting official OpenAI/Codex domains to transit through this software (host allowlist controlled by `OAUTH_APP_FORWARD_PROXY_ALLOWED_HOSTS`).
