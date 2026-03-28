# Codex 虚拟 Key 联动

本目录提供一个桥接示例：`codex-virtual-key-bridge.plugin.ts`。

作用：
- 当插件已拿到 OAuth 凭据时，自动调用本地桥接服务：
  - `POST /api/bridge/oauth/sync`
- 服务返回虚拟 API Key（`ocsk_live_*`）与本地 `baseURL`
- 后续请求走本地网关：`http://127.0.0.1:4777/v1`

## 使用步骤

1. 启动服务：`bun run start`
2. 在你的插件系统中接入 `codex-virtual-key-bridge.plugin.ts`
3. 完成 OAuth 登录
4. 首次同步后，本地缓存会写入：
   - `~/.codex/virtual-key-bridge-cache.json`

## 可选环境变量

- `CODEX_BRIDGE_ORIGIN`：桥接服务地址，默认 `http://127.0.0.1:4777`
- `CODEX_BRIDGE_ADMIN_TOKEN`：管理令牌（如启用）
- `CODEX_BRIDGE_CACHE_FILE`：本地缓存文件路径

## 注意

- 虚拟 Key 明文仅在签发时返回一次，服务端只保存哈希。
- 删除本地缓存后，插件会重新申请新 Key。
