# open_HAL 常駐專案規則

> **本檔案為常駐規則，每次對話都會載入。與 `docs/open_HAL_計劃書_v0.1.md` 有衝突時以計劃書為準，並回頭修正本檔。**
> 技術細節（config 鍵名、RPC 方法名）以 `docs/M0_技術查證_v0.1.md` 為準。

---

## 1. 專案本質

open_HAL 是以 OpenClaw 為基底的個人 AI 助理：核心能力與 OpenClaw 完全相同（同一套 Gateway、Agent、記憶、Skills、Plugins），差別只在對外那一層 —— 把所有聊天通道與 UI 全部收起來，只留一張全螢幕的 HAL 圖片與一顆會閃爍的紅眼。

**不可妥協的產品前提：**

- **唯一的介面是一顆紅眼。** 沒有第二個畫面、沒有第二種輸出。
- **唯一的輸入是語音。** 沒有文字輸入框、沒有通道、沒有指令列。

任何提案如果需要「加一個小按鈕」「顯示一行提示文字」「加一個設定頁」，答案是不行 —— 那不是 UI 細節的取捨，那是把這個專案變成另一個東西。要調整的東西寫在設定檔或環境變數裡，要看的東西寫在 console 與 server log 裡。

---

## 2. D1–D7 決策摘要（計劃書 §14，2026-09-11 拍板）

| # | 決策 | 理由關鍵字 |
| --- | --- | --- |
| D1 | HAL **以語音回話**，音色以 `hal9000-sounds` 為聽感基準 | 完整 speech-to-speech；只當聽感參考，不做語音克隆 |
| D2 | 大腦是 **Claude Agent**（`brain: agent-consult` + `consultRouting: force-agent-consult`） | 人格與記憶一致；Realtime 模型只負責聽與發聲 |
| D3 | 喚醒方式是**喚醒詞「HAL」**（瀏覽器端本機 WASM 引擎） | 隱私（音訊不外送）＋ 零待機成本；由 v2 提前到 v1 |
| D4 | 基底策略採 **Overlay**，不 fork | 「基底一模一樣」；repo 小、建置快、升級只改版本號 |
| D5 | `/admin` Control UI **保留**，以 Basic Auth 保護 | 除錯需要；代價是多一個攻擊面，`ADMIN_USER`/`ADMIN_PASS` 從選配改為必設 |
| D6 | 與「HAL 9000 實體裝置」專案**完全獨立** | v1 不預留任何整合介面、不設計對外控制 API |
| D7 | **繁中為主，使用者說英文就回英文** | 兩條硬規則：同句不混用、不因夾帶術語而切換 |

---

## 3. 目錄分工

| 目錄 | 職責 | 邊界 |
| --- | --- | --- |
| `hal/face/` | HAL 單頁（Vite + 原生 TS）。圖片、紅光疊層、狀態機、麥克風、本機喚醒詞、WebRTC session、TTL 到期前重建 session | **持有零機密。** 不得存取任何 API key 或 Gateway token；所有對外呼叫一律經過 `hal/server`。不得直接連 Gateway |
| `hal/server/` | BFF（Node + TS）。靜態檔、`/healthz`、`HAL_ACCESS_KEY`、RPC 白名單轉發、rate limit、`/admin` Basic Auth、spawn 並監控 Gateway 子行程 | **唯一持有機密的地方。** 不放任何 UI 邏輯與狀態動畫。不得把 token 或 key 放進回給瀏覽器的任何 payload |
| `hal/config/` | Gateway 設定種子 `openclaw.json`，首次啟動寫入 `/data/.openclaw/openclaw.json` | 只放上游 OpenClaw 認得的鍵（內容以 JSON5 解析，可寫註解）。設定驗證是嚴格模式，未知鍵會讓 Gateway 拒絕啟動 —— 改動前先讀 `docs/M0_技術查證_v0.1.md` 確認鍵名 |
| `hal/workspace-seed/` | HAL 人格檔（`SOUL.md`、`IDENTITY.md` 等），首次啟動複製到 `/data/workspace` | **只描述性格與語言政策。** 不得寫入電影台詞、不得描述模仿特定演員的聲音 |
| `hal/test-audio/` | `hal-smoke` / `wake-tune` 的測試音檔 | 含個人聲音，已 gitignore，永遠不進版控 |
| `docs/` | 計劃書與技術查證 | 不進 Docker build context |
| `hal9000-sounds/` | GPL-3.0 音色參考素材 | 已 gitignore 與 dockerignore，**永遠不進產物** |

**誰不該碰誰：** `face` 不碰機密、不碰 Gateway；`server` 不碰視覺；`config` 不放 open_HAL 自創的鍵；`workspace-seed` 不放技術設定。

---

## 4. Overlay 模式紀律（D4）

- **不得修改 OpenClaw 核心。** repo 內沒有、也不該有任何上游程式碼的副本或 patch。
- 所有客製只能透過三種手段：**config**（`hal/config/openclaw.json`）、**plugin**、**客戶端**（`hal/face` + `hal/server`）。做不到的事就是做不到 —— 需要改核心時，是重新評估要不要轉成 fork，而不是偷改。
- **`OPENCLAW_VERSION` 必須釘選**，不得使用 `latest` 或任何浮動 tag。目前釘在 `2026.9.4`（Dockerfile 的 `ARG`）。
- 升級是一次刻意的動作：改版本號 → 比對 config 鍵名與 RPC 方法名 → 本機 build → 跑 smoke test 與安全稽核 → 全綠才開 PR。上游改名不會有編譯錯誤，只會在執行期安靜失效。
- **環境變數沿用上游的 `OPENCLAW_*` 命名，不改名**，以維持與官方文件、升級腳本的相容性。open_HAL 自己的變數才用 `HAL_*` 前綴。

---

## 5. 絕不可違反的安全紅線（計劃書 §9）

> HAL 是一個放在公開網址上、會一直聽、背後有能執行工具之 Agent 的服務。以下七條是紅線，不是偏好。任何一次改動如果會碰到它們，先停下來。

1. **瀏覽器永遠不得取得 Gateway token 或任何 API key。** 包含 `OPENCLAW_GATEWAY_TOKEN`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`ADMIN_PASS`。瀏覽器只能拿到短效、受限的 session 憑證。
2. **BFF 的 RPC 轉發一律預設拒絕。** 只放行白名單內的 Talk 方法；**絕不放行 config / exec / 檔案類方法**。必須是「未列名即拒絕」，不可以是「已知危險才拒絕」。
3. **Gateway 只綁 `127.0.0.1`，永不對外。** Railway 的 Public Networking 只指向 BFF 的 `$PORT`。**容器內的預設 bind 是 `auto`→`0.0.0.0`**，必須在設定檔明寫 `gateway.bind: "loopback"`（並在 spawn 時再帶一次 `--bind loopback`）—— 這不是預設值，是必須主動設定的項目。`gateway.bind` 只接受 bind mode（`auto` / `loopback` / `lan` / `tailnet` / `custom`），不接受 `127.0.0.1` 這類 host 別名，而且沒有對應的環境變數。
4. **語音 session 的 tool policy 不得開放 exec、檔案寫入、瀏覽器控制。** 只開放低風險工具：`group:web`（網路搜尋）與 `group:memory`（記憶**讀取**）。工具預設在主機上執行，而這裡的「主機」就是放著所有 API key 的容器。
   - M0 查證修正：上游**沒有時間類工具**，`group:memory` 也**只有 `memory_search` / `memory_get` 兩個唯讀工具**。計劃書 v0.1 寫的「時間、網路搜尋、記憶讀寫」有兩處與實際不符，已更正。HAL 要不要能寫入記憶，是 M4 要另外決定的事（見計劃書 §9）。
   - 擋檔案寫入**必須 deny `group:fs`**：官方明列 `deny: ["write"]` **不會**連帶擋掉 `apply_patch`。
5. **喚醒詞引擎不得保留音訊 buffer、不得把任何音訊寫入持久儲存（localStorage / IndexedDB）、不得上傳音訊、session 未建立前不得開啟 WebRTC。** 待喚醒期間的音訊只在瀏覽器本機的 WASM 引擎裡被處理，不進 BFF、不進 Gateway、不上傳任何供應商。這條界線一旦破掉，整個隱私論述就不成立。
   - **這條紅線管制的是「音訊」，不是「所有寫入」。** 已知且允許的例外：Picovoice SDK 會把喚醒詞的
     `.ppn` / `.pv` **模型檔**快取進 IndexedDB（`pv_db`），SDK 未提供關閉選項。那是模型權重不是音訊，
     不影響「音訊不離開瀏覽器」這個論述，故允許。**新增任何其他 IndexedDB / localStorage 寫入前，
     必須先確認寫的不是音訊、也不是從音訊推導出的內容（逐字稿、特徵向量、觸發紀錄都算）。**
   - `wake.ts` 的音訊路徑必須維持「單一固定長度、反覆覆寫的暫存區」，不得改成累積式陣列。
6. **`PICOVOICE_ACCESS_KEY` 由 BFF 於執行期注入，不得寫死在前端原始碼、也不得出現在 build 產物中。** 改完前端記得 grep 一次 `dist/`。
7. **收緊 `plugins.allow` 時必須同時保留內建的 `openai` 與 `anthropic` plugin。** 漏掉 `openai` 會讓瀏覽器 realtime 會話建立失敗；漏掉 `anthropic` 會讓 Claude 模型整個不可用，Agent 直接沒有大腦。`plugins.allow` 是 exclusive allowlist，清單外的東西即使 `tools.allow` 寫了 `"*"` 也不會回來。

其他必守項：BFF 層的 rate limit（每分鐘 session 建立次數上限，同時是誤觸發時的成本煞車）、`/admin` 的 Basic Auth 確實生效、對話紀錄保存期限（`/data`，預設 30 天）。

---

## 6. UI 紅線（計劃書 §7.3）

- 整頁**不得出現任何文字、按鈕、對話紀錄或設定介面**。連錯誤訊息也不行。
- **錯誤只用紅眼表達**（`error` 狀態：連閃三下後轉暗）。詳細錯誤寫進 console 與 server log。
- 七種狀態是紅眼唯一的表達方式：`offline` / `idle` / `waking` / `listening` / `thinking` / `speaking` / `error`。
- 光暈以圖片寬度百分比定位在鏡頭中心，換素材或改 CSS 後要重新確認沒有跑位。
- 麥克風一律以 `echoCancellation` / `noiseSuppression` / `autoGainControl` 全開取得，否則 HAL 會收到自己的聲音而自我打斷。
- 進入對話後以 Screen Wake Lock API 防止螢幕休眠；游標無操作 2 秒後隱藏。

---

## 7. 語言政策（D7）

**專案本身**：所有文件、註解、commit message、設定檔註解一律使用**繁體中文（台灣用語）**。

**HAL 的回覆**：

- 預設繁體中文（台灣用語）。
- 使用者**整句**改說英文時，HAL 整段改用英文回答，直到對方換回中文為止。
- 硬規則一：**同一句話裡不混用兩種語言** —— 語音情境下中英夾雜會讓 TTS 的語調斷裂。
- 硬規則二：**夾帶英文技術名詞不算切換語言**。「幫我看一下 Docker 的 log」仍然用中文回答。
- 語言判斷交給 Realtime 模型即時處理（它本來就是多語模型），Agent 端只在 instructions 裡下規則，**不另外寫語言偵測程式**。

---

## 8. 命名規則

- GitHub repo：**`open_HAL`**（底線、大寫 HAL）。
- npm 套件名與 Docker image：**`open-hal`**（連字號、全小寫）。npm 與 Docker 都不允許大寫。
- 環境變數：上游的用 `OPENCLAW_*`（不改名），open_HAL 自己的用 `HAL_*`。
  - **唯一例外**：`OPENCLAW_VERSION` 是我們自己的 Dockerfile 建置期 `ARG`，不在官方支援的 `OPENCLAW_*` 清單內，Gateway 執行期不會讀它。沿用這個名字是因為它指的就是上游套件的版本，改名反而難懂。新增自訂執行期變數時一律用 `HAL_*`，不要再擴充這個例外。
- 文件中提到本專案時一律寫 `open_HAL`，提到映像或套件時寫 `open-hal`。

---

## 9. 常用指令

```bash
# 前端（HAL Face）
npm --prefix hal/face install
npm --prefix hal/face run dev          # 本機開發伺服器
npm --prefix hal/face run build        # 產出靜態檔到 hal/face/dist

# BFF（hal-server）
npm --prefix hal/server install
npm --prefix hal/server run build      # tsc 產出到 hal/server/dist
node hal/server/dist/index.js          # 本機直接跑（需先 export 環境變數）

# Docker
docker build -t open-hal .
docker run --rm -p 8080:8080 -e PORT=8080 --env-file .env \
  -v open-hal-data:/data --name open-hal open-hal

# 健康檢查（同時回報 BFF 與 Gateway 子行程狀態）
curl -s http://127.0.0.1:8080/healthz

# 升級上游：改 Dockerfile 的 ARG OPENCLAW_VERSION，然後
docker build --build-arg OPENCLAW_VERSION=<新版本> -t open-hal .
```

---

## 10. 相關文件

- `docs/open_HAL_計劃書_v0.1.md` —— 唯一的真實來源，本檔與它衝突時以它為準。
- `docs/M0_技術查證_v0.1.md` —— config 鍵名、RPC 方法名等技術細節的查證結果。
- `docs/BFF_介面契約_v0.1.md` —— `hal/face`（瀏覽器）與 `hal/server`（BFF）之間的唯一介面：HTTP 端點、`/hal` WebSocket 信封、方法與事件白名單、rate limit。兩邊各自實作時以它為準。
- `docs/open_HAL_開發Skills規劃_v0.1.md` —— 開發流程用的 Claude Code skills 規劃與建置時序。
