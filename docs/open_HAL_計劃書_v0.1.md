# open_HAL 計劃書 v0.2

> 以 OpenClaw 為基底、只有一顆會閃爍的 HAL 紅眼、只收聲音輸入的個人 AI 助理。
> 文件版本：v0.2 ｜ 日期：2026-09-11 ｜ 狀態：D1–D7 已決策（見第 14 節）；**M0 技術查證已完成，詳見 `docs/M0_技術查證_v0.1.md`**
>
> v0.2 的改動全部來自 M0 查證，逐處以「（M0 查證修正：…）」標記，未被查證推翻的段落一字未動。
> 技術細節（設定鍵名、RPC 方法名、CLI flag）以 `docs/M0_技術查證_v0.1.md` 為準；仍需實機驗證的項目見該文件 G 節。

---

## 1. 目標與範圍

open_HAL 的核心能力與 OpenClaw 完全相同：同一套 Gateway、Agent、記憶、Skills、Plugins、模型供應商抽象。差別只在「對外的那一層」：OpenClaw 透過 20 多種聊天通道、Control UI、原生 App 與使用者互動，open_HAL 則把這些全部收起來，只留下一個全螢幕的 HAL 紅眼頁面，使用者唯一的輸入方式是說話。

| 範圍內 | 範圍外（v1 不做） |
| --- | --- |
| OpenClaw Gateway / Agent / 記憶 / Skills 原封不動沿用 | 任何聊天通道（Telegram、Discord、LINE…） |
| 單一頁面：HAL 圖片 + 紅點依狀態閃爍 | 文字輸入框、對話紀錄、設定畫面等任何 UI 元件 |
| 麥克風語音輸入 → Agent 處理 | macOS / iOS / Android 原生 App |
| HAL 以語音回覆（D1） | 多使用者、多租戶 |
| 瀏覽器端本機喚醒詞「HAL」（D3） | 與「HAL 9000 實體裝置」專案的任何整合（D6） |
| 繁中為主、偵測到英文即改用英文（D7） | 文字訊息、推播、排程主動發話 |
| 部署到 Railway，HTTPS 公開網址 | 離線 / 本地模型（保留介面，之後再做） |

---

## 2. 已定案的前提

「只支援 input 聲音」定義為：**輸入端只有語音**（沒有文字、沒有通道），而 HAL 的回應是**語音 + 紅眼動畫**（D1 已確認要語音回話，不是純紅眼回應）。因此第 6 節的語音管線採完整 speech-to-speech，而非純轉錄。

HAL 的聲音以 `hal9000-sounds/hal9000/` 這 49 個片段作為**音色與語調的聽感基準**：低沉、氣音偏多、語速慢而平穩、句尾不上揚、幾乎沒有情緒起伏。M0 Spike 時以這些片段對照試聽 Realtime 內建 voice，挑最接近的一個。

注意授權：該素材為 **GPL-3.0**，且是針對 Home Assistant 事件錄的英文短句。它只作為**選音色的參考**，不會被打包進 open_HAL、不會上傳給模型做聲音複製、也不會出現在部署產物中（目前已列入 `.gitignore`）。若日後想直接播放這些片段當提示音，必須先處理 GPL 的傳染性授權問題，屬於 v1 範圍外。

介面圖片使用你提供的 HAL 素材檔。目前這張是 560×420，右上角有來源網站浮水印，全螢幕顯示會糊、浮水印也會露出，正式上線前建議換一張解析度更高、畫面乾淨的素材。

---

## 3. 我們從 OpenClaw 繼承什麼

OpenClaw 的架構是一個 Gateway 作為本地控制平面，管理 sessions、tools、events 與通道連線；Control UI、CLI、TUI 都只是連到 Gateway 的客戶端。這個分層正是 open_HAL 能「基底一模一樣」的原因：我們不改 Gateway，只寫一個新的客戶端（HAL 臉）取代 Control UI。

語音方面，OpenClaw 已經有完整的 **Talk mode**，其中 Browser Talk 支援兩種形態：`talk.client.create`（瀏覽器自己持有的 WebRTC / provider-websocket 會話）與 `talk.session.create`（Gateway 持有的 gateway-relay 會話）。Realtime 語音可以設定 `brain: "agent-consult"`，讓語音模型的工具呼叫走 Gateway 的政策與 Agent，也就是 HAL 的「大腦」仍是 OpenClaw 的 Agent（可接 Claude）。

授權：OpenClaw 為 MIT 授權（© OpenClaw Foundation），可自由 fork / 修改 / 改名，需保留 LICENSE 與版權聲明，並一併保留 THIRD_PARTY_NOTICES。

---

## 4. 基底策略：Overlay 模式（D4 已拍板）

| | A. Overlay 模式（推薦） | B. 完整 Fork |
| --- | --- | --- |
| 做法 | open_HAL repo 只放客製層；Docker 內安裝**釘選版本**的 `openclaw` npm 套件 | Fork 整個 openclaw monorepo，客製直接寫進去 |
| 「基底一模一樣」 | 字面上就是同一份上游程式碼 | 分叉後逐漸偏離 |
| Repo 大小 / 建置 | 小；Railway 建置快 | 9 萬+ commits 的 pnpm workspace，含原生 App，建置重 |
| 升級上游 | 改版本號 + 跑 smoke test | 需要 merge / rebase，衝突多 |
| 能否改核心 | 不能（只能用 config / plugin / 客戶端） | 能 |

**v1 採 A（Overlay）。** 所有客製都集中在 `hal/` 目錄，將來如果真的需要改 Gateway 核心，再轉成 B，`hal/` 整包搬進 fork 即可，不會白做。下面保留 B 的欄位，是為了在真的要轉換時有對照依據，不是待選項。

命名：GitHub repo 用 `open_HAL`；npm 套件名與 Docker image 不允許大寫，統一用 `open-hal`。內部環境變數沿用上游的 `OPENCLAW_*`，不改名，確保與官方文件、升級腳本相容。

---

## 5. 系統架構

```
┌──────────────────── 瀏覽器 / Kiosk 螢幕 ────────────────────┐
│  HAL Face（單頁）                                            │
│   ├─ HAL 圖片 + 紅光疊層（狀態動畫）                          │
│   ├─ getUserMedia 麥克風（AEC / NS / AGC 開啟）               │
│   ├─ 喚醒詞引擎（WASM，本機，音訊不外送）                     │
│   └─ 喚醒後才建立 ── WebRTC 音訊 ────► Realtime 語音供應商   │
└──────────┬──────────────────────────────────▲────────────────┘
           │ HTTPS / WSS（HAL_ACCESS_KEY）     │ 短效 session 憑證
┌──────────▼────────── Railway service：open-hal ──────────────┐
│  hal-server（BFF，監聽 $PORT）                                │
│   ├─ GET  /        → HAL Face 靜態檔                          │
│   ├─ WS   /hal     → 白名單 RPC 轉發（只開放 Talk 相關方法）   │
│   ├─ /admin        → Control UI（Basic Auth，**必設**）        │
│   └─ 啟動並監控子行程 ▼                                       │
│  OpenClaw Gateway（127.0.0.1:18789，不對外）                  │
│   ├─ Talk broker（talk.client.create / toolCall …）            │
│   ├─ Agent（Claude）+ 記憶 + Skills + Tool policy              │
│   └─ 狀態與 workspace → /data（Railway Volume）                │
└──────────────────────────────────────────────────────────────┘
```

**（M0 查證修正 §5）** 圖中兩處要補：

- 「Gateway 綁 127.0.0.1」**不是預設行為**。容器環境內 bind 的有效預設是 `auto` → `0.0.0.0`，必須在設定檔明寫 `gateway.bind: "loopback"`（並建議 spawn 時再帶一次 `--bind loopback`），否則 Gateway 在 Railway 容器裡是裸奔的。詳見第 9 節與 M0 §D18。
- `/admin` 的 Control UI 會**直接開一條完整的 operator WebSocket**到 Gateway，那條連線**不受 BFF 的 RPC 白名單保護**。Basic Auth 是它唯一的防線，D5 的真實成本比原本估計的高。詳見第 9 節與 M0 §D19。

**為什麼要多一層 hal-server（BFF）？** 社群的 Railway 範本已經採用類似做法：外層服務聽 Railway 的 `$PORT`，在內部 127.0.0.1:18789 啟動 Gateway 並代理 HTTP 與 WebSocket。open_HAL 在這個基礎上多做一件事：**瀏覽器永遠拿不到 Gateway token，也不能呼叫任意 RPC**。HAL 臉是公開網址上一個會聽的麥克風，如果直接把 Gateway 暴露給瀏覽器，任何拿到網址的人都能呼叫 config、exec 等管理方法。BFF 只轉發 Talk 所需的少數方法，其餘一律拒絕。

另一個可行做法是使用 OpenClaw 的 trusted-proxy auth，由 BFF 代為注入身分。（M0 查證修正：**v1 不採用 trusted-proxy**。它與共享 token 互斥——設了 `OPENCLAW_GATEWAY_TOKEN` 就會讓 Gateway 拒絕以 trusted-proxy 啟動；同機 loopback 還必須開 `allowLoopback: true`，而官方明言「任何能連上 Gateway 的本機行程都能靠送身分 header 冒充反向代理」；`openclaw security audit` 也會把它標成 critical。維持本節原本的 A 案：BFF 持有 token，對瀏覽器只開白名單 RPC。詳見 M0 §A4。）

---

## 6. 語音管線

### 路徑 1（推薦 MVP）：Browser Talk + client-owned WebRTC

```
使用者說話
  → 瀏覽器麥克風 ──WebRTC──► Realtime 模型（語音進、語音出）
  → 模型需要思考 / 用工具 → data channel 送出 toolCall
  → 瀏覽器轉給 hal-server → Gateway（agent-consult → Claude Agent）
  → 結果回傳 → 模型用語音說出來 → 紅眼隨輸出音量閃爍
```

優點是延遲最低，而且音訊直接從瀏覽器到語音供應商，不經過 Railway（Railway 公開網路是 HTTP/TCP 代理，不開放 UDP 入站，這條路剛好避開）。瀏覽器只會拿到短效、受限的 session 憑證，不會拿到正式 API key。

**（M0 查證修正 §6：路徑 1 實際用到的 RPC 方法）** 第 3 節只點名了 `talk.client.create`，但這條路跑完一輪還需要四個方法，缺一不可：

| 方法 | 用途 |
| --- | --- |
| `talk.client.create` | 建立／重建 realtime session（只接受 `mode: "realtime"`、`transport: "webrtc"`、`brain: "agent-consult"`） |
| `talk.client.toolCall` | 把模型從 data channel 送出的 `openclaw_agent_consult` 轉給 Claude Agent，立刻回 `runId` / `agentId` / `agentSessionKey` |
| `agent.wait` | 等該次 consult 回合結束（也可改聽 `chat` 事件的 `state: "final"`，官方 Control UI 兩者並用） |
| `talk.client.transcript` | 把定稿逐字稿寫回 agent session；不開的話 HAL 的記憶會缺掉語音對話內容 |
| `talk.client.close` | 結束 session（`sessionKey` 與 `voiceSessionId` 兩個欄位都必填），TTL 重建前必做 |

另外強烈建議一併放行 `chat.abort`（使用者打斷時中止 Agent 回合，否則會空跑付費）、`talk.client.steer`、`talk.catalog`、`talk.config`（後者絕不可讓瀏覽器帶 `includeSecrets: true`）。完整白名單與參數硬化寫法見 M0 §B9，實作落在 `hal/server/src/rpc-allowlist.ts`。

`consultRouting` 是 v1 最重要的一個開關：`force-agent-consult` 讓每一句話都經過 OpenClaw Agent（Claude 回答，Realtime 模型負責「發聲」），HAL 的記憶與人格一致；`provider-direct` 則讓 Realtime 模型可自行回答簡單問題，速度較快但人格可能漂移。預設採前者。

### 路徑 2（備案）：gateway-relay

瀏覽器以 WebSocket 把 PCM 音訊串給 hal-server，Gateway 以 `talk.session.create({ transport: "gateway-relay" })` 與 `talk.session.appendAudio` 處理，所有供應商憑證留在伺服器端，也可接非 OpenAI 的 realtime 供應商。代價是音訊流量經過 Railway、延遲較高，且 Gateway 持有 WebRTC 的 relay 路線在 Railway 上的網路可行性需先驗證。

### 語音相關的硬限制（實作必須處理）

Browser / relay Talk 每個 Gateway 最多 8 個併發 session、session TTL 30 分鐘、瀏覽器 offer token 60 秒單次有效。HAL 是「一直開著」的裝置，所以客戶端必須在 TTL 到期前自動結束並重建 session，使用者不應察覺。

**（M0 查證修正 §6：硬限制補兩條、改一個用詞）**

- 還有一條計劃書沒提的限制：**每個「客戶端連線」最多 2 個併發 session**（含尚未完成的 pending offer），與上面那個「每 Gateway 8 個」是兩條不同的限制。單人使用不會碰到，但重建 session 時若沒先 close 舊的，很容易在第三次撞上它。
- **官方沒有任何 renew / refresh / extend 方法**。docs 與 dist 都查不到 `talk.session.renew` / `talk.client.renew` / `.refresh` / `.resume`，而且官方明言「audio activity does not renew it」。所以「TTL 續接」這個詞要改讀成「**到期前主動 `talk.client.close` + 重新 `talk.client.create`**」——是重建，不是延長。實作以 `create` 回傳的 `expiresAt` 為權威（沒有就退回 30 分鐘推算），提前約 2 分鐘重建，且說話中要延後到靜默才切。
- 8 併發這個數字官方寫在 GPT-Live 段落，實作上屬於 OpenAI realtime broker 的計數；**本專案走的是瀏覽器直連 OpenAI 那條路，是否受同一計數約束 docs 未載明**，列入 M0 實機驗證（M0 §G1）。

### 喚醒方式：喚醒詞「HAL」（D3）

瀏覽器沒有 OpenClaw 原生 App 的 Voice Wake，所以喚醒詞必須自己在頁面裡做。做法是在 HAL Face 內常駐一顆**本機（WASM）喚醒詞引擎**，持續分析麥克風音框，只有偵測到「HAL」才建立 Realtime session：

```
開機 → 使用者點一次紅眼（僅為取得麥克風權限與音訊播放許可）
   → 本機喚醒詞引擎常駐監聽（音訊不離開瀏覽器，零 API 成本）
   → 聽到「HAL」→ 紅眼閃一下（waking）→ 建立 Realtime session → 對話
   → 靜默超過 HAL_IDLE_TIMEOUT_SEC → 關閉 session → 退回喚醒詞監聽
```

這個設計同時解掉了原本「點擊喚醒」要處理的成本問題：待喚醒期間音訊只在瀏覽器本機被處理，不會產生任何 Realtime 費用，也不會把家裡的環境音上傳。

引擎選型（M0 定案）：優先評估 Picovoice **Porcupine Web**（WASM，可在 Picovoice Console 自訓練「HAL」關鍵詞，內建關鍵詞清單沒有這個字；個人使用為免費額度，需注意授權條款與 AccessKey 管理）。備案是 Silero VAD（WASM）先過濾靜音，只在有人聲時送一小段音訊做關鍵詞比對 —— 成本略高但沒有第三方 SDK 綁定。

三個必須處理的細節：

1. **首次手勢仍免不了。** 瀏覽器規定第一次開啟麥克風與播放音訊需要使用者手勢。開機後畫面是一顆暗紅眼，點一下完成授權；之後同一個 origin 的權限會被記住，重新整理不必再點。kiosk 模式可用 Chromium 啟動參數（`--use-fake-ui-for-media-stream`、`--autoplay-policy=no-user-gesture-required`）完全免去這一步，做到真正的「開機即聽」。
2. **誤觸發。** 「HAL」只有一個音節，容易與「哈囉」「how」「hall」「還好」混淆。靈敏度做成可調參數（`HAL_WAKE_SENSITIVITY`），並加一道保險：喚醒後若 N 秒內沒有偵測到語音就靜默關閉 session，避免誤觸發後空轉付費。
3. **喚醒回饋。** 偵測到喚醒詞的當下紅眼立刻亮一下（`waking` 狀態），讓使用者知道可以開始講，不必等 session 建好 —— 這段建立時間約數百毫秒，沒有回饋會讓人重複喊。

---

## 7. HAL Face：唯一的介面

### 7.1 畫面

純黑背景，HAL 圖片置中、依視窗等比縮放。紅點閃爍不是替換圖片，而是在鏡頭中心疊一層徑向漸層光暈（`mix-blend-mode: screen`），用 CSS 變數控制亮度與大小。因為素材中鏡頭剛好在圖片正中央，光暈以圖片寬度百分比定位，RWD 不會跑位。

技術選型：這一頁只有一張圖和一個狀態機，不需要 Angular，建議 Vite + 原生 TypeScript，產出一個幾 KB 的靜態包。

### 7.2 狀態 → 紅眼行為

| 狀態 | 觸發 | 紅眼行為 |
| --- | --- | --- |
| `offline` | 未連線 / 重連中 | 極暗餘燼，約每 3 秒微弱一亮 |
| `idle` | 已連線、本機喚醒詞監聽中 | 慢速呼吸，週期約 4 秒 |
| `waking` | 聽到喚醒詞「HAL」 | 瞬間衝到最亮再回落，約 0.3 秒 |
| `listening` | Realtime session 已建立、收音中 | 穩定偏亮，隨麥克風音量微幅閃動 |
| `thinking` | 等待 Agent / 工具結果 | 快速脈動，週期約 0.8 秒 |
| `speaking` | HAL 說話中 | 亮度即時跟隨輸出音訊振幅（AnalyserNode） |
| `error` | 權限被拒、session 失敗 | 連閃三下後轉暗 |

```css
.hal      { position: relative; height: 100vh; background: #000; display: grid; place-items: center; }
.hal img  { max-width: 100vw; max-height: 100vh; }
.glow     { position: absolute; left: 50%; top: 50%; width: 18%; aspect-ratio: 1; border-radius: 50%;
            transform: translate(-50%, -50%) scale(var(--scale, 1));
            opacity: var(--level, .5); mix-blend-mode: screen; pointer-events: none;
            background: radial-gradient(circle, rgba(255,235,150,.95) 0%, rgba(255,60,0,.75) 22%, rgba(180,0,0,0) 70%); }
[data-state="idle"]     .glow { animation: breathe 4s ease-in-out infinite; }
[data-state="thinking"] .glow { animation: breathe .8s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: .9; transform: translate(-50%,-50%) scale(1.08); } }
```

`listening` 與 `speaking` 不用 CSS 動畫，改由 `requestAnimationFrame` 讀取音訊 RMS，寫入 `--level` 與 `--scale`。

### 7.3 其他細節

麥克風以 `echoCancellation / noiseSuppression / autoGainControl` 全開取得，否則 HAL 自己的聲音會被收進去，觸發 `interruptOnSpeech` 自我打斷。頁面進入對話後以 Screen Wake Lock API 防止螢幕休眠。游標在無操作 2 秒後隱藏。整頁沒有任何文字，連錯誤訊息都只用紅眼表達，詳細錯誤寫進 console 與伺服器 log。

---

## 8. 人格與 Agent 設定

HAL 的人格放在 OpenClaw workspace 的 bootstrap 檔（SOUL / IDENTITY 等），首次啟動時由 `hal/workspace-seed/` 複製到 `/data/workspace`。人格方向：冷靜、禮貌、語速平穩、回答簡短（語音情境每次回覆以兩三句為主）。只描述性格，不在 prompt 裡寫入電影台詞。

**語言政策（D7）**：預設繁體中文（台灣用語）；使用者整句改說英文時，HAL 就整段改用英文回答，直到對方換回中文為止。兩條硬規則：同一句不混用兩種語言（語音情境下中英夾雜會讓 TTS 的語調斷裂）；語言切換以「使用者最近一輪的主要語言」判定，不因句中夾一兩個英文技術名詞就切換 —— 「幫我看一下 Docker 的 log」仍然用中文回答。這個判斷交給 Realtime 模型即時處理（它本來就是多語模型），Agent 端只在 instructions 裡下規則，不另外做語言偵測程式。

Gateway 設定種子（**`hal/config/openclaw.json`**，首次啟動複製成 `/data/.openclaw/openclaw.json`）。

（M0 查證修正 §8：**檔名是 `.json` 不是 `.json5`** —— OpenClaw 的設定檔名固定為 `openclaw.json`，內容則以 JSON5 解析，可寫註解與尾逗號；全套官方 docs 中沒有 `openclaw.json5` 這個檔名。另外設定驗證是**嚴格模式**，未知鍵、型別錯或值不合法都會讓 Gateway **拒絕啟動**，所以種子裡不得出現任何沒查證過的鍵。以下為 M0 §C11 修正後的版本，repo 內的實檔請以 `hal/config/openclaw.json` 為準。）

```json5
{
  gateway: {
    mode: "local",            // ⚠️ 缺這個鍵，Gateway 直接拒絕啟動
    port: 18789,
    bind: "loopback",         // ⚠️ 容器內預設是 auto → 0.0.0.0，必須明寫
    auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    controlUi: { enabled: true, basePath: "/admin" },
  },
  talk: {
    // 刻意不設 speechLocale：它只作用於 Android / iOS / macOS 原生語音辨識，
    // 對瀏覽器 realtime 完全無效（M0 §C12）。D7 的中英切換交給模型 + instructions。
    silenceTimeoutMs: 900,
    interruptOnSpeech: true,
    realtime: {
      provider: "openai",
      providers: { openai: { model: "gpt-realtime-2.1", speakerVoice: "cedar" } },
      mode: "realtime",
      transport: "webrtc",
      brain: "agent-consult",                 // D2：大腦是 Claude Agent
      consultRouting: "force-agent-consult",  // 預設是 provider-direct，必須明寫
      instructions: "你是 HAL。語氣冷靜平穩、語速均勻，每次回覆盡量不超過三句。預設使用繁體中文（台灣用語）；當使用者整句改用英文時，就整段改用英文回答，直到對方換回中文為止。同一句話裡不要混用兩種語言；使用者只是夾帶英文技術名詞時，仍然維持原本的語言。",
    },
  },
  agents: {
    defaults: {
      // 格式是 provider/model；模型 id 可替換，以 `openclaw models status --probe` 為準
      models: { "anthropic/claude-opus-4-6": { alias: "opus" } },
      model: { primary: "anthropic/claude-opus-4-6" },
    },
  },
  tools: {                                  // 第 9 節第三層，M0 §D16 建議寫法
    profile: "minimal",
    allow: ["session_status", "group:web", "group:memory"],
    deny: ["group:runtime", "group:fs", "group:ui", "group:nodes",
           "group:automation", "group:messaging", "group:sessions", "group:plugins"],
    exec: { mode: "deny" },
    elevated: { enabled: false },
    fs: { workspaceOnly: true },
  },
  update: { checkOnStart: false },   // kiosk 裝置關閉啟動時的版本檢查
  // plugins.allow 先不設（＝不限制），M4 再收緊；收緊時 openai 與 anthropic 缺一不可
  // 不設定任何 channels
}
```

**語言政策（D7）的落點也隨之修正**：原本打算用 `talk.speechLocale: "zh-TW"` 交代的那一半，實際上不會生效（該鍵只涵蓋 Android / iOS / macOS 的原生語音辨識）。中英切換完全由 realtime 模型本身（多語模型）加上 `talk.realtime.instructions` 的規則承擔，`speechLocale` 一律不設。

語音音色：以 `hal9000-sounds/hal9000/` 的片段當聽感基準，在 Realtime 內建 voice 中挑最接近的（`cedar`、`ash` 是起點，M0 實際試聽決定）。挑選時中英兩種語言都要試 —— 有些 voice 說中文會有明顯外國腔，這在 D7 的雙語情境下會被放大。不複製電影原配音員的聲音，也不用參考素材做語音克隆（見第 2 節的授權說明）。

---

## 9. 安全

HAL 是一個放在公開網址、會聽、背後有能執行工具之 Agent 的服務，安全是 v1 必要項目而非加分題。

存取控制分三層。第一層是 HAL 臉本身：需帶 `HAL_ACCESS_KEY`（首次以網址參數帶入，之後轉為 HttpOnly cookie），沒有就只回一個全黑頁面。第二層是 BFF 的 RPC 白名單，瀏覽器只能呼叫 Talk 所需方法。第三層是 Gateway 的 tool policy：語音 session 預設**不給 exec、檔案寫入、瀏覽器控制**，只開放低風險工具。（M0 查證修正：實際可開放的是 `group:web`（網路搜尋）與 `group:memory`；上游**沒有時間類工具**，`group:memory` 也**只含 `memory_search` / `memory_get` 兩個唯讀工具**，所以 v0.1 寫的「時間、網路搜尋、記憶讀寫」有兩處與實際不符。HAL 是否需要寫入記憶的能力，M4 收斂 tool policy 時另行決定；另注意官方明列 `deny: ["write"]` 不會連帶擋掉 `apply_patch`，擋檔案寫入必須 deny `group:fs`。詳見 M0 §D16。）OpenClaw 文件明確提醒工具預設在主機上執行，除非另外設定 sandbox；在 Railway 上「主機」就是放著你所有 API key 的容器。

喚醒詞（D3）改變了隱私邊界，而且是往好的方向：待喚醒期間麥克風雖然一直開著，音訊卻只在瀏覽器本機的 WASM 引擎裡被處理，**不進 hal-server、不進 Gateway、不上傳任何供應商**，只有偵測到「HAL」之後建立的那段 session 才會外送音訊。實作上必須確保這條界線不被打破：喚醒詞引擎不得保留音訊 buffer、不得寫入任何持久儲存、不得在 session 未建立時開啟 WebRTC。如果之後改用需要雲端比對的喚醒方案，這段結論就要重寫。

另外加上 BFF 層的 rate limit（每分鐘 session 建立次數上限，同時也是誤觸發時的成本煞車）、`/admin` 以 Basic Auth 保護（D5 決定保留供除錯），以及對話紀錄保存期限（存在 `/data`，預設保留 30 天，可調）。收緊 `plugins.allow` 時要記得保留內建的 `openai` plugin，否則 GPT-Live 瀏覽器會話會建立失敗（M0 查證修正：**還必須同時保留 `anthropic`** —— Claude 模型是由 bundled 的 `anthropic` plugin 提供的，漏掉它 Agent 就整個沒有大腦。`plugins.allow` 是 exclusive allowlist，清單外的東西即使 `tools.allow` 寫了 `"*"` 也不會回來；改這個鍵需重啟 Gateway）。

**（M0 查證修正 §9：三件必須補進安全設計的事）**

1. **bind 預設不是 loopback —— 這是實際存在的漏洞。** 官方文件寫「Default bind mode: `loopback`」，但緊接著一句：「Inside a detected container environment the effective default is `auto` (resolves to `0.0.0.0` for port-forwarding)」。Railway 的容器正屬此列，所以不明寫的話 Gateway 會綁 `0.0.0.0`。修法：設定種子寫 `gateway: { bind: "loopback" }`，spawn 時再帶一次 `--bind loopback`（CLI flag 優先序最高），兩道並用，即使設定種子寫入失敗也不會裸奔。注意 `gateway.bind` 只接受 bind mode（`auto` / `loopback` / `lan` / `tailnet` / `custom`），**不接受 `127.0.0.1` 這類 host 別名**，而且**沒有對應的環境變數**，只能用 flag 或設定鍵。
2. **`/admin` 的攻擊面比原估的大。** Control UI 會直接對 Gateway 開一條完整的 operator WebSocket，不經過 BFF 的 RPC 白名單，等於第二層防護在這條路上完全不存在；Basic Auth 是唯一的防線。另外非 loopback 的瀏覽器 origin 必須列入 `gateway.controlUi.allowedOrigins`（要填 Railway 網域），否則 Control UI 連不上；經 BFF 轉發後 Origin header 的實際值待實機確認（M0 §G10）。
3. **語音有一道不可關閉的確認閘。** 語音發起的 consult 在執行高風險動作前會回 `VOICE_CONFIRMATION_REQUIRED:<id>`，需要使用者新的、明確的口頭確認。這是額外的安全網，**不能拿它取代 tool policy** —— 官方也沒有提供任何開關。

---

## 10. 專案結構

```
open_HAL/
├── hal/
│   ├── face/                    # HAL 單頁（Vite + TS）
│   │   ├── index.html
│   │   ├── src/main.ts          # 啟動、首次手勢授權、Wake Lock
│   │   ├── src/wake.ts          # 本機喚醒詞引擎（WASM）、靈敏度、誤觸發保險
│   │   ├── src/talk.ts          # 與 hal-server 溝通、WebRTC session、TTL 到期前重建
│   │   ├── src/eye.ts           # 狀態機 + 音訊 RMS → CSS 變數
│   │   ├── src/hal.css
│   │   ├── public/hal-eye.jpg   # 你提供的素材
│   │   └── public/wake/         # 喚醒詞模型檔（「HAL」關鍵詞）
│   ├── server/                  # BFF（Node + TS）
│   │   ├── src/index.ts         # HTTP 伺服器、靜態檔、/healthz
│   │   ├── src/gateway.ts       # spawn / 監控 openclaw gateway 子行程
│   │   ├── src/rpc-allowlist.ts # 允許轉發的 Talk RPC 清單
│   │   └── src/auth.ts          # HAL_ACCESS_KEY、/admin Basic Auth、rate limit
│   ├── config/openclaw.json     # Gateway 設定種子（檔名與部署目標一致，見 §8）
│   └── workspace-seed/          # HAL 人格檔
├── Dockerfile
├── railway.json
├── .env.example
├── LICENSE                      # MIT，保留 OpenClaw 版權聲明
├── THIRD_PARTY_NOTICES.md
├── CLAUDE.md                    # 給 Claude Code 的專案規則
└── README.md                    # 註明 based on OpenClaw
```

---

## 11. Railway 部署

需要部署。瀏覽器只在 HTTPS 下允許使用麥克風，而 Gateway 必須是常駐服務，Railway 同時解決這兩件事（自帶 HTTPS 網域、常駐容器、Volume）。

### 11.1 Dockerfile（草稿）

```dockerfile
# OpenClaw 需要 Node 24.16+ 或 26.1+（官方建議 26）
FROM node:26-bookworm-slim
ARG OPENCLAW_VERSION=__PIN_ME__          # 釘選版本，不用 latest
RUN npm install -g openclaw@${OPENCLAW_VERSION} --allow-scripts=openclaw
WORKDIR /app
COPY hal/ ./hal/
RUN cd hal/face && npm ci && npm run build \
 && cd ../server && npm ci && npm run build
ENV OPENCLAW_STATE_DIR=/data/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/data/workspace \
    OPENCLAW_GATEWAY_PORT=18789
CMD ["node", "hal/server/dist/index.js"]
```

`hal-server` 啟動時檢查 `/data/.openclaw` 是否已有設定，沒有就寫入設定種子與人格檔，接著以子行程啟動 Gateway，崩潰時自動重啟，`/healthz` 同時回報兩者狀態。

**（M0 查證修正 §11.1）** 上面的草稿有四點要修，實際的 `Dockerfile` 已照修正版寫：

- **Node 版本正確**：`openclaw@2026.9.4` 的 `engines` 是 `>=24.16.0 <25 || >=26.1.0`，`node:26-bookworm-slim` 合格；**不可改成 25.x**（明確不支援）。
- **設定種子的檔名是 `openclaw.json`**（見 §8），`COPY hal/config/` 之後寫入 `/data/.openclaw/openclaw.json`。
- **Gateway 的啟動方式**：`openclaw gateway` 在缺 `gateway.mode=local` 時會**拒絕啟動**（不是跳 wizard 卡住）。所以 spawn 指令帶 `--port` / `--bind loopback`，並以「設定種子先寫入」為主、`--allow-unconfigured` 為保險（它只跳過那一道守衛，不會幫你建立或修復設定）。
- **`--no-update-check` / `--headless` / `--non-interactive` 這三個 flag 在 `openclaw gateway` 上都不存在**：關版本檢查請用設定鍵 `update.checkOnStart: false` 或 `OPENCLAW_NO_AUTO_UPDATE=1`。另外 `npm install -g ... --allow-scripts=openclaw` 不是 npm 的標準旗標，Dockerfile 已改成「先帶旗標試一次、失敗再退回不帶」的寫法，實際行為待本機 build 驗證（M0 §G6）。


### 11.2 環境變數

| 變數 | 值 | 說明 |
| --- | --- | --- |
| `PORT` | Railway 自動注入 | hal-server 對外監聽 |
| `OPENCLAW_GATEWAY_PORT` | `18789` | 內部 Gateway，只綁 127.0.0.1 |
| `OPENCLAW_GATEWAY_TOKEN` | 隨機長字串 | Gateway 管理密鑰，只有 hal-server 持有 |
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | 持久化狀態 |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | 持久化 workspace（人格、記憶） |
| `ANTHROPIC_API_KEY` | 你的 key | Agent 大腦（Claude） |
| `OPENAI_API_KEY` | 你的 key | Realtime 語音 |
| `HAL_ACCESS_KEY` | 隨機字串 | 開啟 HAL 臉的通行碼 |
| `ADMIN_USER` / `ADMIN_PASS` | 自訂 | `/admin` Control UI（D5 保留，務必設定） |
| `PICOVOICE_ACCESS_KEY` | 你的 key | 喚醒詞引擎（若 M0 選定 Porcupine）；由 BFF 注入頁面，不寫死在前端原始碼 |
| `HAL_WAKE_SENSITIVITY` | `0.5` | 喚醒詞靈敏度，越高越容易觸發也越容易誤觸發 |
| `HAL_IDLE_TIMEOUT_SEC` | `45` | 對話靜默多久後關閉 session、退回喚醒詞監聽 |

（M0 查證修正 §11.2：上表的 `OPENCLAW_*` 四個變數名全部正確。但要補一項提醒——**bind 沒有對應的環境變數**，只能用 CLI flag `--bind` 或設定鍵 `gateway.bind`，所以「Gateway 只綁 127.0.0.1」這件事沒辦法靠環境變數達成，見第 9 節。另外 BFF 自己的變數已增補 `HAL_MAX_SESSIONS_PER_MIN`、`HAL_SESSION_KEY`、`HAL_WAKE_ARM_TIMEOUT`，以 `.env.example` 與 `docs/BFF_介面契約_v0.1.md` 為準。）

### 11.3 步驟

在 Railway 建立專案並從 GitHub 連結 `open_HAL` repo（以 Dockerfile 建置），在服務上掛載 Volume 至 `/data`，填入上表變數，於 Public Networking 開啟 HTTP 網域，部署後以 `https://<網域>/?k=<HAL_ACCESS_KEY>` 開啟，點一下紅眼完成麥克風授權，之後喊「HAL」即可開始對話。之後 push 到 main 即自動重新部署。自訂網域（例如 `hal.你的網域`）可在最後綁定。

---

## 12. 里程碑

| 階段 | 內容 | 驗收標準 | 估計 |
| --- | --- | --- | --- |
| M0 Spike | 本機裝 OpenClaw，用官方 Control UI 的 Talk 驗證 zh-TW 辨識、延遲、agent-consult；確認 RPC 名稱與 config 鍵名；對照 `hal9000-sounds` 試聽 voice；驗證中英切換；選定喚醒詞引擎 | 中文連續對話 5 輪可用、中途切英文會跟著切；列出 BFF 需要的 RPC 白名單；voice 與喚醒詞方案定案 | 1.5–2 天 |
| M0 追加（查證修正） | 文件查證已完成（`docs/M0_技術查證_v0.1.md`），剩下必須實機確認的部分 | 確認設定種子寫入與 `--allow-unconfigured` 的先後順序；在容器內確認 Gateway 實際綁的是 127.0.0.1（`ss -ltnp` 或 `lsof -i`）；以 `openclaw models status --probe` 確認 Claude 模型 id | 併入 M0 |
| M1 骨架 | 建 repo、LICENSE、Dockerfile、hal-server 能 spawn Gateway 並回 `/healthz` | `docker run` 後 Gateway 健康、`/` 回傳空頁 | 0.5–1 天 |
| M2 HAL Face | 圖片 + 光暈 + 七種狀態（先用假資料驅動） | 各狀態視覺可辨識，手機與大螢幕都不跑位 | 1–2 天 |
| M3 語音串接 | 路徑 1 完整打通：收音 → Agent → 發聲 → 紅眼同步（先用點擊觸發，把語音鏈路跑通） | 首次回應延遲目標 < 2 秒；TTL 到期前自動重建 session 無感（close + create，官方沒有 renew） | 2–3 天 |
| M3.5 喚醒詞 | 本機 WASM 喚醒詞引擎、「HAL」關鍵詞、靈敏度調校、靜默自動休眠 | 3 公尺外喊「HAL」可靠喚醒；一般對話 1 小時內誤觸發 0–1 次 | 1–2 天 |
| M4 人格與安全 | 人格檔、雙語切換驗證、tool allowlist、HAL_ACCESS_KEY、rate limit、/admin | 無 key 無法使用；語音要求執行指令會被拒絕；中英切換不會夾雜 | 1–1.5 天 |
| M5 Railway | Volume、變數、網域、自動部署 | 公開網址可對話；重新部署後記憶仍在 | 0.5–1 天 |
| M6 穩定化 | 24 小時連續運作、斷線重連、上游版本升級流程 | 24h 無需人工介入；升級只改版本號 + smoke test | 1–2 天 |

合計約 8.5–14.5 個工作天（D3 的喚醒詞比原本的點擊喚醒多約 1–2 天）。M0 仍是整份計劃最關鍵的一步：第 6、8 節中標註「待驗證」的細節、以及喚醒詞引擎的選型，都在這裡定案。

---

## 13. 風險與對策

| 風險 | 影響 | 對策 |
| --- | --- | --- |
| 瀏覽器要求使用者手勢才能開麥克風 / 播音 | 重開機後需人工點一次才能進入待喚醒 | 權限由 origin 記住，只有首次需要；kiosk 以 Chromium 啟動參數完全放行 |
| 喚醒詞「HAL」音節短、易誤觸發 | 沒人講話卻開 session，付費且擾人 | 靈敏度可調；喚醒後 N 秒無語音自動關閉；BFF rate limit 當成本煞車；M0 實測誤觸發率 |
| 喚醒詞引擎的第三方授權與 AccessKey | 免費額度或條款變動導致不能用 | 抽象成 `wake.ts` 單一介面，Porcupine 與 VAD 備案可互換；key 由 BFF 注入不寫死 |
| 中英切換判斷失準 | 回錯語言、或同句中英夾雜使語調斷裂 | instructions 明確規則 + M0 雙語實測；voice 挑選時中英都試聽 |
| HAL 聲音被麥克風收回造成自我打斷 | 對話中斷、鬼打牆 | AEC 全開；指向性麥克風；必要時說話時暫停收音 |
| 公開網址 + 有工具的 Agent | API key 外洩、被濫用 | 第 9 節三層防護；無 exec |
| 持續收音的語音成本 | 帳單失控 | 對話制 session、靜默自動休眠、rate limit |
| Talk session 30 分 TTL / 8 併發 | 長時間運作斷線 | 客戶端在到期前主動 close + 重建 session（M0 查證修正：官方沒有任何 renew / refresh 方法，音訊活動也不會續期，只能重建）；另有「每客戶端連線 2 個 session」這條限制，重建時務必先 close 舊的；單人使用不會碰到 8 併發上限 |
| zh-TW 辨識與口音 | 聽錯、回答腔調不自然 | M0 實測；調整 instructions 與 voice（M0 查證修正：`speechLocale` 對瀏覽器 realtime 無效，不是可調的旋鈕） |
| Railway 不開放 UDP 入站 | gateway-relay 的 WebRTC 路線可能不通 | MVP 採瀏覽器直連的路徑 1 |
| 上游更新極快 | 行為變動、設定鍵改名 | 釘選版本、每月升級一次、升級前跑 smoke test |
| 素材解析度低且帶浮水印 | 全螢幕品質差 | 換高解析、乾淨素材 |

---

## 14. 決策紀錄

以下七項於 2026-09-11 拍板，本文件其餘章節均已依此更新。

| # | 問題 | 決策 | 對計劃的影響 |
| --- | --- | --- | --- |
| D1 | HAL 用語音回話還是只用紅眼？ | **語音回話**，音色以 `hal9000-sounds` 為聽感基準 | 語音管線採完整 speech-to-speech（§6）；音色選型與 GPL 授權界線寫入 §2、§8 |
| D2 | 大腦用 Claude 還是讓 Realtime 模型直接回答？ | **Claude**（`brain: agent-consult` + `consultRouting: force-agent-consult`） | 每一句都經 OpenClaw Agent，人格與記憶一致；Realtime 模型只負責聽與發聲（§6、§8） |
| D3 | 喚醒方式：點擊、VAD、還是喚醒詞？ | **喚醒詞「HAL」** | 由 v2 提前到 v1。新增本機 WASM 喚醒詞引擎（§6）、`waking` 狀態（§7.2）、`wake.ts`（§10）、M3.5 里程碑（§12），並新增誤觸發與授權兩條風險（§13） |
| D4 | Overlay 或完整 Fork？ | **Overlay** | 客製全部集中在 `hal/`；釘選上游 `openclaw` 版本（§4、§11.1） |
| D5 | `/admin` Control UI 保留或關閉？ | **保留**，Basic Auth 保護 | `ADMIN_USER` / `ADMIN_PASS` 從選配改為必設（§11.2） |
| D6 | 與「HAL 9000 實體裝置」專案的關係？ | **完全獨立** | v1 不為實體裝置預留任何整合介面、不設計對外控制 API；該整合列入範圍外（§1）。日後若要接，重新評估而非沿用預留介面 |
| D7 | 只講繁中，或中英自動切換？ | **繁中為主，使用者說英文就回英文** | 語言政策與兩條硬規則（不同句混用、不因夾帶術語而切換）寫入人格與 instructions（§8）；M0 增加雙語實測、voice 需中英都試聽（§12、§13） |

### 由這些決策衍生、待 M0 定案的技術項

（M0 查證修正：文件查證能定案的已填上結論，其餘標明仍需實機驗證。完整清單見 `docs/M0_技術查證_v0.1.md` G 節。）

| 項目 | 待決內容 | 卡在哪個決策 | M0 結論 |
| --- | --- | --- | --- |
| 喚醒詞引擎 | Porcupine Web（自訓練「HAL」，需 AccessKey 與授權確認）或 Silero VAD + 短窗比對 | D3 | **仍待實測**。屬瀏覽器端選型，不在 OpenClaw docs 範圍內，M3.5 以 `wake-tune` 量測後定案 |
| `speechLocale` 行為 | 設為 `zh-TW` 是否會硬鎖辨識語言而妨礙英文聽寫；若會，改用自動偵測 | D7 | **已定案：不設這個鍵。** 它只作用於 Android / iOS / macOS 原生語音辨識，對瀏覽器 realtime 完全無效，因此既不會硬鎖、也幫不上忙。中英切換交給 realtime 模型 + `instructions`（M0 §C12） |
| Realtime voice | 對照 `hal9000-sounds` 選出中英都自然的音色 | D1 + D7 | **候選已定案，聽感待實測。** GA realtime 合法音色共 10 個（`alloy` / `ash` / `ballad` / `cedar` / `coral` / `echo` / `marin` / `sage` / `shimmer` / `verse`），`cedar` 與 `ash` 都在內；官方額外推薦 `marin`，建議一併試聽。TTS-only 的 `fable` / `nova` / `onyx` 不可用。⚠️ session 開始後不能換音色，換音色必須重建 session（M0 §C13） |
| Agent 模型 id | `anthropic/claude-opus-4-6` 與 `anthropic/claude-opus-5` 哪一個現行可用 | D2 | **鍵路徑已定案**（`agents.defaults.model.primary`，值為 `provider/model`）；**id 仍待實測**，以 `openclaw models status --probe` 為準（M0 §C14、§G3） |
| `plugins.allow` 收緊時機 | 何時收、要留哪些 plugin | D2 + D5 | **已定案：M0/M1 先不設（＝不限制），M4 再收緊**，收緊後必須跑完整語音 smoke test。收緊時 `openai` 與 `anthropic` 缺一不可（M0 §D17） |
| Gateway bind | 如何確保只綁 127.0.0.1 | — | **已定案**：設定種子寫 `gateway.bind: "loopback"` ＋ spawn 帶 `--bind loopback`。**沒有對應的環境變數**，而且容器內的預設是 `auto` → `0.0.0.0`（M0 §D18） |

---

## 15. 參考文件

OpenClaw repo：https://github.com/openclaw/openclaw
Railway 安裝：https://docs.openclaw.ai/install/railway
Talk mode：https://docs.openclaw.ai/nodes/talk
Messages and talk 設定：https://docs.openclaw.ai/gateway/config-agents/messages-and-talk
Building a Gateway client：https://docs.openclaw.ai/gateway/clients
Gateway protocol：https://docs.openclaw.ai/gateway/protocol
Security：https://docs.openclaw.ai/gateway/security
Trusted proxy auth：https://docs.openclaw.ai/gateway/trusted-proxy-auth
Telemetry / update check：https://docs.openclaw.ai/gateway/telemetry
社群 Railway 範本（wrapper 架構參考）：https://railway.com/deploy/openclaw-4
Picovoice Porcupine Web（瀏覽器端喚醒詞候選）：https://picovoice.ai/docs/porcupine-web/
Silero VAD（喚醒詞備案的靜音過濾）：https://github.com/snakers4/silero-vad
HAL 音色參考素材（GPL-3.0，僅供試聽比對）：`hal9000-sounds/`（來源 repo：ha-hal9000-sounds）

（M0 查證修正 §15：上列官方網址是線上版，**會隨上游版本漂移**。查證與升級一律以**本機 docs 為準** —— OpenClaw 的官方文件隨 npm 套件一起發佈，解開釘選版本的套件後就在其根目錄的 `docs/` 底下（例如 `<套件根>/package/docs/nodes/talk.md`、`docs/gateway/protocol/`、`docs/gateway/config-tools/tool-policy.md`）。M0 全部的引用都標到該目錄的檔名與行號，比對時可直接對照。）

open_HAL 專案內文件：

- `docs/M0_技術查證_v0.1.md` —— 設定鍵名、RPC 方法名、CLI flag、部署細節的查證結果；G 節列出仍需實機驗證的項目。
- `docs/BFF_介面契約_v0.1.md` —— `hal/face` 與 `hal/server` 之間的唯一介面。
- `docs/open_HAL_開發Skills規劃_v0.1.md` —— 開發流程用的 Claude Code skills 規劃與建置時序。
- `CLAUDE.md` —— 常駐專案規則（目錄分工、安全紅線、命名規則）。
