# hal-server（open_HAL BFF）

整個專案唯一持有機密的地方。負責靜態檔、存取控制、Gateway RPC 白名單轉發、
`/admin` 反向代理，以及 OpenClaw Gateway 子行程的啟動與監控。

介面契約見 `docs/BFF_介面契約_v0.1.md`；技術事實來源見 `docs/M0_技術查證_v0.1.md`。

## 本機怎麼跑

```bash
# 1) 前端產物（BFF 的靜態檔來源是 hal/face/dist）
npm --prefix hal/face install && npm --prefix hal/face run build

# 2) BFF
npm --prefix hal/server install
npm --prefix hal/server run build

# 3) 環境變數（四個必要變數缺一個就會 exit 1）
export OPENCLAW_GATEWAY_TOKEN=dev-token
export HAL_ACCESS_KEY=dev-key
export ADMIN_USER=admin ADMIN_PASS=dev-pass
export OPENCLAW_STATE_DIR=/tmp/hal-state OPENCLAW_WORKSPACE_DIR=/tmp/hal-workspace
export PORT=8080

# 本機是 http，Secure cookie 會被瀏覽器丟掉 → 開逃生門（正式部署絕對不要設）
export HAL_INSECURE_COOKIE=1

# 沒裝 openclaw 或只想驗 BFF 時，跳過 Gateway 子行程（/healthz 會一直回 503）
export HAL_SKIP_GATEWAY=1

node hal/server/dist/index.js
```

開 `http://127.0.0.1:8080/?k=dev-key`，會種下 cookie 並 302 回 `/`。

## 環境變數

| 變數 | 必要 | 預設 | 說明 |
| --- | --- | --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | — | Gateway 共享密鑰；只有 `gateway-client.ts` 會碰 |
| `HAL_ACCESS_KEY` | ✅ | — | 開啟 HAL 臉的通行碼 |
| `ADMIN_USER` / `ADMIN_PASS` | ✅ | — | `/admin` 的 Basic Auth（D5 保留此介面，所以必設） |
| `PORT` | | `8080` | BFF 對外監聽 |
| `OPENCLAW_GATEWAY_PORT` | | `18789` | 內部 Gateway，只綁 loopback |
| `OPENCLAW_STATE_DIR` | | `~/.openclaw` | 設定檔會寫成 `<stateDir>/openclaw.json` |
| `OPENCLAW_WORKSPACE_DIR` | | `<stateDir>/workspace` | 人格檔與記憶 |
| `PICOVOICE_ACCESS_KEY` | | 無 | 未設時 `/hal-config.json` 的 `engine` 回 `"vad"` |
| `HAL_WAKE_SENSITIVITY` | | `0.5` | 0–1 |
| `HAL_IDLE_TIMEOUT_SEC` | | `45` | |
| `HAL_MAX_SESSIONS_PER_MIN` | | `6` | `talk.client.create` 的成本煞車 |
| `HAL_SESSION_KEY` | | `main` | Talk sessionKey，瀏覽器不得指定 |
| `HAL_INSECURE_COOKIE` | | 關 | 本機 http 開發用；關掉 cookie 的 `Secure` |
| `HAL_SKIP_GATEWAY` | | 關 | 不 spawn Gateway 子行程 |

環境變數只在 `src/config.ts` 讀取（`grep -rn "process.env" src/ | grep -v config.ts` 必須是空的）。

## 檔案

| 檔案 | 職責 |
| --- | --- |
| `src/index.ts` | HTTP 伺服器、靜態檔、路由、安全 header、`/admin` 反向代理、優雅關閉 |
| `src/config.ts` | 環境變數唯一讀取點、驗證、`redacted()` |
| `src/auth.ts` | timing-safe 金鑰比對、cookie、Basic Auth、滑動視窗 rate limit |
| `src/gateway.ts` | 設定／人格種子、spawn 並監控 Gateway 子行程、`/startupz` 探測 |
| `src/gateway-client.ts` | BFF ↔ Gateway 的 WS（**唯一持有 token 的檔案**） |
| `src/rpc-allowlist.ts` | 安全紅線 2 的實作：白名單 + 逐方法參數硬化 |
| `src/hal-ws.ts` | `/hal` 信封轉接、事件白名單、rate limit、每 IP 單連線 |

## 注意事項

- `/admin` 假設 `gateway.controlUi.basePath` 是 `/admin`（`hal/config/openclaw.json` 已如此設定），
  因此路徑原樣轉發、不做改寫。改動 basePath 需要重啟 Gateway。
- Control UI 會直接連 Gateway 的 WebSocket。BFF 只代理 `/admin*` 的 upgrade；
  根路徑的 WS upgrade 一律拒絕（那會是一條不受白名單保護的完整 operator 連線）。
- CSP 的每一條指令在 `src/index.ts` 都有註解說明理由。動它之前請先讀完 ——
  少了 `'wasm-unsafe-eval'` 喚醒詞會掛，少了 `https://api.openai.com` SDP 交換會掛。
