# Codex Gateway 服务器部署包

这个目录已经整理成可直接上传到服务器的最小运行包。它保留了服务端运行需要的源码、依赖清单、启动脚本和部署模板，移除了 Electron、Windows 安装包、`node_modules`、测试数据库和临时产物。

## 目录说明

- `src/`: 服务器运行源码
- `.env.example`: 环境变量模板
- `start.sh`: Linux/macOS 启动入口
- `start.ps1`: Windows 启动入口
- `Dockerfile`: Docker 镜像构建文件
- `docker-compose.yml`: Docker Compose 示例
- `systemd/codex-gateway.service`: systemd 服务模板
- `nginx/codex-gateway.conf`: Nginx 反向代理示例
- `scripts/generate-secrets.ts`: 生成管理 Token 和加密密钥
- `PROJECT_NOTES.md`: 项目部署注意事项

## 项目形态

- 运行核心是 `Bun + Hono` 服务，入口在 `src/index.ts`
- Web 管理界面是静态页 `src/web/index.html`
- 数据持久化使用 SQLite，默认目录是 `data/`
- Electron 仅用于桌面包装，服务器部署不需要

## 硬性要求

1. 如果不用 Docker，服务器必须安装 Bun。
2. `data/` 目录必须可写。
3. 如果 `OAUTH_APP_HOST` 不是 `127.0.0.1` / `localhost` / `::1`，服务端代码会强制要求 `OAUTH_APP_ENCRYPTION_KEY`。
4. 出于安全考虑，这个部署包的启动脚本还会要求非回环绑定时必须设置 `OAUTH_APP_ADMIN_TOKEN`。
5. 服务器需要能访问这些上游域名：
   - `auth.openai.com`
   - `chatgpt.com`
   - `api.openai.com`
6. 如果启用前向代理，还要放行 `OAUTH_APP_FORWARD_PROXY_PORT`。

## 登录方式建议

- 远程服务器不要优先使用 `browser` 登录，它依赖服务端本机的 `http://localhost:1455/auth/callback`
- 远程场景优先使用：
  - `headless`
  - `manual-code`
- 已有 OAuth 凭证时，可以走 `/api/bridge/oauth/sync` 或 `/api/accounts/import-json`
- 只需要 OpenAI API Key 桥接时，可以直接调用 `/api/accounts/api-key`

## Docker 部署

```bash
cd /opt/codex-gateway/server-deploy
cp .env.example .env
docker compose up -d --build
```

启动前至少替换 `.env` 里的：

- `OAUTH_APP_ADMIN_TOKEN`
- `OAUTH_APP_ENCRYPTION_KEY`

健康检查：

```bash
curl http://127.0.0.1:4777/api/health
```

## systemd + Bun 部署

```bash
cd /opt/codex-gateway/server-deploy
cp .env.example .env
chmod +x start.sh
bun install --frozen-lockfile --production
```

然后把 `systemd/codex-gateway.service` 放到 `/etc/systemd/system/`，按实际机器调整 `User`、`Group`、`WorkingDirectory` 和 `PATH`：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-gateway
sudo systemctl status codex-gateway
```

## RK3588 / Debian 11 arm64 快速部署

如果你的板子是 RK3588 这类 `aarch64/arm64` 设备，推荐直接使用 release 里的 `server-deploy` 部署包，而不是桌面 Linux `amd64` 安装包。

```bash
tar -xzf Codex-Gateway-rk3588-linux-arm64-1.1.15.tar.gz
cd Codex-Gateway-rk3588-linux-arm64-1.1.15
chmod +x scripts/install-rk3588.sh start.sh
./scripts/install-rk3588.sh
```

这个脚本会：

- 检查当前机器是否为 `arm64`
- 如缺失则安装 Bun
- 执行 `bun install --frozen-lockfile --production`
- 自动生成 `.env`
- 在有权限时生成并启用匹配当前目录和当前用户的 `systemd` 服务

## Windows 服务器启动

```powershell
cd C:\deploy\codex-gateway\server-deploy
Copy-Item .env.example .env
.\start.ps1
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OAUTH_APP_HOST` | `127.0.0.1` | 服务绑定地址 |
| `OAUTH_APP_PORT` | `4777` | Web/API 端口 |
| `OAUTH_APP_DATA_DIR` | `./data` | SQLite、设置、日志目录 |
| `OAUTH_APP_WEB_DIR` | `./src/web` | Web UI 目录 |
| `OAUTH_APP_ADMIN_TOKEN` | 空 | 管理 API Token，非回环绑定时必须设置 |
| `OAUTH_APP_ENCRYPTION_KEY` | 空 | Token/Key 加密密钥，非回环绑定时必须设置 |
| `OAUTH_BOOT_LOG_FILE` | `data/bootstrap.log` | 启动日志文件 |
| `OAUTH_CODEX_API_BASE` | `https://chatgpt.com/backend-api/codex` | ChatGPT Codex 上游基址 |
| `OAUTH_OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI API 上游基址 |
| `OAUTH_CODEX_ORIGINATOR` | `codex_cli_rs` | 上游 `originator` |
| `OAUTH_CODEX_CLIENT_VERSION` | 自动探测，否则 `0.115.0` | 上游版本标识 |
| `OAUTH_CODEX_OFFICIAL_ROOT` | 空 | 本地 `codex-official` 仓库路径 |
| `OAUTH_CODEX_PROMPT_FILE` | 空 | 自定义 prompt 文件 |
| `OAUTH_CODEX_MODELS_FILE` | 空 | 自定义模型清单文件 |
| `OAUTH_CODEX_ALLOWED_WORKSPACE_ID` | 空 | 限制 ChatGPT OAuth 登录的 workspace |
| `OAUTH_APP_FORWARD_PROXY_ENABLED` | `1` | 是否启用前向代理 |
| `OAUTH_APP_FORWARD_PROXY_PORT` | `OAUTH_APP_PORT + 1` | 前向代理端口 |
| `OAUTH_APP_FORWARD_PROXY_ALLOWED_HOSTS` | 内置域名列表 | 允许代理访问的域名 |
| `OAUTH_APP_FORWARD_PROXY_ENFORCE_ALLOWLIST` | `0` | 是否强制拒绝非白名单域名 |
| `OAUTH_DEBUG_ROUTING` | `0` | 路由调试开关 |

## 常用接口

- `GET /api/health`
- `GET /api/providers`
- `POST /api/login/start`
- `GET /api/login/sessions/:id`
- `POST /api/login/sessions/:id/code`
- `POST /api/bridge/oauth/sync`
- `POST /api/accounts/api-key`
- `POST /v1/responses`
- `GET /v1/models`

## 验证清单

1. `GET /api/health` 返回 `ok: true`
2. `GET /` 能打开 Web 页面
3. `GET /api/providers` 能看到 `chatgpt` 及 `browser/manual-code/headless`
4. `data/accounts.db` 会在首次运行后自动创建
5. 如果启用前向代理，`/api/health` 中 `forwardProxyEnabled` 为 `true`
