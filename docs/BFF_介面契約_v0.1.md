# open_HAL BFF 介面契約 v0.1

> `hal/face`（瀏覽器）與 `hal/server`（BFF）之間的唯一介面。兩邊各自實作，以本檔為準。
> 日期：2026-09-11 ｜ 依據：計劃書 §5/§9、`M0_技術查證_v0.1.md`
>
> **鐵則**：瀏覽器永遠不碰 Gateway、不持有 Gateway token、不持有任何 API key。
> Gateway 的 RPC 信封由 BFF 獨力處理，瀏覽器只看得到本檔定義的簡化信封。

---

## 1. HTTP 端點

| 方法 | 路徑 | 認證 | 回應 |
| --- | --- | --- | --- |
| GET | `/` | `?k=<HAL_ACCESS_KEY>` 或 cookie | 有效 → HAL Face；無效 → 全黑頁（200，不含任何 JS 與提示） |
| GET | `/hal-config.json` | cookie | 前端執行期設定（見 §2） |
| GET | `/healthz` | 無 | `{ ok, server, gateway }`（見 §3） |
| GET | `/assets/*` | cookie | Vite build 產物 |
| ANY | `/admin/*` | Basic Auth | 反向代理到 Gateway Control UI |

**存取金鑰流程**：`GET /?k=<key>` 比對 `HAL_ACCESS_KEY`（用 timing-safe 比較）→ 相符則
`Set-Cookie: hal_key=<key>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
並 302 到 `/`（把 key 從網址列與瀏覽器歷史中清掉）。之後一律讀 cookie。

**全黑頁**：`<!doctype html><meta charset=utf-8><title></title><style>html,body{margin:0;height:100%;background:#000}</style>`
不得回 401/403 文字、不得洩漏任何訊息（計劃書 §7.3「錯誤只用紅眼表達」的延伸）。

---

## 2. `GET /hal-config.json`

BFF 於執行期注入，**這是 `PICOVOICE_ACCESS_KEY` 唯一被允許進入瀏覽器的途徑**（安全紅線 6：
不得寫死在前端原始碼、不得出現在 build 產物）。

```jsonc
{
  "sessionKey": "main",          // Talk sessionKey，由伺服器決定
  "idleTimeoutSec": 45,          // HAL_IDLE_TIMEOUT_SEC
  "wake": {
    "engine": "porcupine",       // "porcupine" | "vad"，待 M0 引擎選型定案
    "accessKey": "…",            // PICOVOICE_ACCESS_KEY，engine=vad 時為 null
    "keywordUrl": "/wake/hal.ppn",
    "modelUrl": "/wake/porcupine_params.pv",
    "sensitivity": 0.5           // HAL_WAKE_SENSITIVITY
  }
}
```

未設定 `PICOVOICE_ACCESS_KEY` 時 `engine` 回 `"vad"`，前端自動走備案引擎。

---

## 3. `GET /healthz`

不需認證（Railway healthcheck 要打它），但**不得洩漏任何機密或詳細內部狀態**。

```jsonc
{ "ok": true, "server": "up", "gateway": { "running": true, "ready": true, "restarts": 0 } }
```

`ok` = server up **且** gateway ready。不 ready 時回 503。

---

## 4. WebSocket `/hal`

連線時以 cookie 認證，**不接受任何形式的 query token**。認證失敗直接關閉（code 1008），不回訊息。

### 4.1 信封（瀏覽器 ↔ BFF）

```jsonc
// 瀏覽器 → BFF
{ "t": "rpc", "id": 1, "method": "talk.client.create", "params": { … } }

// BFF → 瀏覽器（成功）
{ "t": "rpc:ok", "id": 1, "result": { … } }

// BFF → 瀏覽器（失敗）
{ "t": "rpc:err", "id": 1, "error": { "code": "forbidden", "message": "method not allowed" } }

// BFF → 瀏覽器（Gateway 事件推播，白名單過濾後）
{ "t": "event", "event": "chat", "payload": { … } }

// 保活（雙向，30 秒）
{ "t": "ping" } / { "t": "pong" }
```

`id` 由瀏覽器產生、單調遞增。BFF 負責與 Gateway 真實 RPC id 的對應，**Gateway 的原始信封不得外洩**。

### 4.2 方法白名單

以 `M0_技術查證_v0.1.md` §B9 為準（5 必需 + 4 建議），**未列名即拒絕**（安全紅線 2）。
白名單內仍需逐方法做參數硬化：

- `talk.client.create`：`sessionKey` / `mode` / `transport` / `brain` 一律由 BFF 覆寫成
  `main` / `realtime` / `webrtc` / `agent-consult`；瀏覽器只能帶 `voiceSessionId`。
- `talk.config`：強制 `params = {}`，**絕不可讓 `includeSecrets: true` 通過**（會回傳金鑰）。
- 其餘方法轉發前檢查 `sessionKey` 是否等於伺服器持有的值。

### 4.3 事件白名單

只轉發 `chat`、`talk.event` 兩類；其餘 Gateway 事件一律不轉發（避免內部狀態外洩）。

### 4.4 Rate limit

- `talk.client.create`：每分鐘上限 `HAL_MAX_SESSIONS_PER_MIN`（預設 6）。超限回
  `rpc:err` code `rate_limited`，同時是喚醒詞誤觸發的成本煞車（計劃書 §9、§13）。
- 全體 RPC：每分鐘 240 則。
- 每個 IP 同時只允許 1 條 `/hal` 連線（單人使用；新連線踢掉舊的）。

---

## 5. SDP 交換（重要）

`talk.client.create` 回傳的 `offerUrl` 若是**絕對網址**（OpenAI），瀏覽器直接 POST，BFF 不介入
—— 這正是計劃書路徑 1 成立的原因（音訊不經 Railway）。

若 `offerUrl` 是**相對路徑**（`gateway-control-v1` 模式），BFF 必須額外代理
`POST /plugins/openai/realtime/calls`。v1 先不實作，偵測到相對路徑時記 log 並以 `error` 狀態呈現。

---

## 6. 前端狀態對應

| BFF / Talk 事件 | HAL Face 狀態 |
| --- | --- |
| WS 未連線 / 重連中 | `offline` |
| WS 已連線、喚醒詞監聽中 | `idle` |
| 偵測到喚醒詞 | `waking` |
| `talk.client.create` 成功、WebRTC 已連上 | `listening` |
| 送出 `talk.client.toolCall` 後、結果回來前 | `thinking` |
| data channel 有輸出音訊 | `speaking` |
| 任何 `rpc:err` / 權限被拒 / session 建立失敗 | `error` |
