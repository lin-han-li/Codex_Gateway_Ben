# Codex Gateway 项目结论

## 1. 项目实际形态

- 运行核心是 `Bun + Hono` 服务，入口在 `src/index.ts`。
- Electron 只是桌面壳，服务端部署不需要 `electron/`、`build/installer.nsh`、`dist/`。
- Web 管理界面是纯静态页 `src/web/index.html`，运行时由服务直接读取。

## 2. 当前真正启用的认证提供商

- 当前 `ProviderRegistry` 只注册了 `ChatGPT`，没有把 `GitHub Copilot` provider 挂进去。
- 仓库里仍保留 `src/providers/copilot.ts`，但它现在只是未接入代码，不会出现在 `/api/providers` 返回中。
- 除 OAuth provider 以外，项目还支持两类“非 provider 列表”账号入口：
  - 直接录入 OpenAI API Key
  - 通过 `/api/bridge/oauth/sync` 同步外部 OAuth 凭据

## 3. ChatGPT 登录方式

- `browser`
  - 浏览器 PKCE 自动回调
  - 固定回调地址 `http://localhost:1455/auth/callback`
  - 适合同机部署，或通过远程桌面在服务器本机浏览器里完成
- `manual-code`
  - 仍然使用同一个固定回调地址
  - 不要求本地回调服务一定成功接收，但用户必须能拿到最终回调 URL 或 `code`
- `headless`
  - 设备码流程
  - 访问 `https://auth.openai.com/codex/device` 输入代码即可
  - 这是远程服务器最稳妥的登录方式

## 4. 服务器部署最容易踩坑的点

- 远程浏览器访问 Web 管理页时，界面本身就会提示不要直接点“添加 OAuth 账号（本机）”。
- 浏览器 PKCE 回调写死到 `localhost:1455`，这不是服务器公网地址，也不是可配置项。
- 绑定到非回环地址时，程序会强制要求 `OAUTH_APP_ENCRYPTION_KEY`；没有它会直接启动失败。
- 管理接口统一走 `/api/*`，如果设置了 `OAUTH_APP_ADMIN_TOKEN`，后续所有管理请求都必须带 `x-admin-token`。
- 数据库使用 SQLite WAL，持久化时不能只保留 `accounts.db`，还要一起保留 `accounts.db-wal` 和 `accounts.db-shm`。

## 5. 这个部署包为什么只保留最小文件集

- `src/` 是唯一运行时源码。
- `package.json` 和 `tsconfig.json` 用于安装依赖与类型检查。
- `start.sh` / `start.ps1` 负责加载 `.env` 并补充运行前校验。
- `systemd/` 只是 Linux 常见部署样板。
- 没有把仓库根目录 `data/` 里的现成数据库一起带过来，避免把已有令牌或测试数据误带到服务器。
