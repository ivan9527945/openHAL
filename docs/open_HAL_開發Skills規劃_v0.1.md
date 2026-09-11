# open_HAL 開發用 Claude Code Skills 規劃 v0.1

> 對應《open_HAL 計劃書 v0.1》的 M0–M6。這份規劃只談**開發流程用的 Claude Code skills**（`.claude/skills/`），
> 不是 HAL 這個助理對外的產品能力（那屬於 OpenClaw Agent 的 Skills，另案規劃）。
> 文件版本：v0.1 ｜ 日期：2026-09-11

---

## 1. 分工原則：什麼該做成 skill，什麼不該

環境裡已經有 gstack 全域 skill 套件（`/ship`、`/land-and-deploy`、`/review`、`/qa`、`/health`、`/canary`、
`/browse`、`/investigate`、`/document-release`…）。這份規劃**不重做它們能做的事**，只補三類缺口：

1. **gstack 通用流程接不住的**：HAL 只有一個沒有任何文字的頁面、唯一輸入是麥克風。`/qa` 那套「點按鈕、填表單、
   看文字」的 web QA 假設在這裡完全不成立。
2. **計劃書明文寫成驗收標準、但需要多步驟才能驗的**：M2 的七種紅眼狀態、M3.5 的誤觸發率、M4 的中英切換、
   M6 的「升級只改版本號 + smoke test」。
3. **做錯會出事、所以不能靠記性的**：§9 的三層存取控制與 §9 那段喚醒詞隱私邊界。

反過來說，只做一次的事（M0 Spike 探索、M1 建 repo）、或已經有工具的事（部署、PR、code review），都不做成 skill。

---

## 2. 建議清單

| # | Skill | 用途 | 何時開始用 | 優先級 |
| --- | --- | --- | --- | --- |
| S1 | `hal-smoke` | 端到端語音鏈路冒煙測試（喚醒 → 收音 → Agent → 發聲 → 紅眼） | M3 之後 | **必要** |
| S2 | `openclaw-upgrade` | 上游 OpenClaw 版本升級的完整流程 | M6，之後每月 | **必要** |
| S3 | `hal-audit` | §9 三層存取控制 + 喚醒詞隱私邊界的稽核 | M4 之後，每次改 config / BFF | **必要** |
| S4 | `wake-tune` | 喚醒詞靈敏度調校與誤觸發／召回率量測 | M3.5 | 建議 |
| S5 | `eye-check` | 七種紅眼狀態的視覺截圖驗收 | M2 之後，每次改 CSS | 建議 |
| S6 | `bilingual-check` | D7 中英切換行為驗收 | M4 | 選配 |

S1 是 S2 的前置（升級流程要呼叫冒煙測試）；S4 產出的音檔資產 S1 也會用到。建議實作順序：S1 → S4 → S3 → S2 → S5 → S6。

---

## 3. 各 skill 細節

### S1 `hal-smoke` —— 語音鏈路冒煙測試

**要解決的問題**：HAL 的核心鏈路橫跨瀏覽器、WebRTC、Realtime 供應商、BFF、Gateway、Claude Agent 六層，任何一層
壞掉的症狀都一樣：對著螢幕喊「HAL」，紅眼沒反應。沒有自動化就只能每次手動喊話再猜是哪裡斷了。

**關鍵技術**：用 Chromium 的假麥克風裝置餵預錄音檔，不需要真的對著電腦講話。

```
--use-fake-ui-for-media-stream          # 自動允許麥克風權限，不跳授權框
--use-fake-device-for-media-stream      # 啟用假裝置
--use-file-for-fake-audio-capture=<檔>.wav   # 餵指定音檔（必須是 16-bit PCM wav）
--autoplay-policy=no-user-gesture-required   # 免手勢播放，繞過 §6 的首次手勢限制
```

**流程**：
1. 啟動目標（本機 `docker run` 或指定已部署的 URL），等 `/healthz` 兩個元件都綠。
2. 以上述參數開 Chromium，帶 `?k=$HAL_ACCESS_KEY` 進頁面。
3. 餵測試音檔：`[喚醒詞「HAL」] → [靜音 0.5s] → [一句中文提問]`。
4. 依序斷言：`idle → waking → listening → thinking → speaking`（讀 `data-state` 屬性變化）。
5. 量首次回應延遲（喚醒詞結束 → 進入 `speaking`），對照 §12 M3 的 < 2 秒目標。
6. 抓 console 與 `hal-server` log，確認沒有 RPC 被拒、沒有 session 重建失敗。
7. 輸出一份 PASS/FAIL 表，失敗時指出斷在哪一層（這是整個 skill 的主要價值）。

**為什麼值得做成 skill**：M3、M3.5、M6 三個里程碑的驗收都要跑；S2 升級流程每月要跑；改任何一層之後都該跑。
步驟固定、參數瑣碎、失敗診斷需要跨層看 log —— 完全符合 skill 的適用條件。

**注意**：`--use-file-for-fake-audio-capture` 只吃 wav，`hal9000-sounds` 是 mp3 且內容是英文智慧家庭短句，
**不能**直接當測試輸入（它是選音色的參考，不是測試資產，見計劃書 §2）。測試音檔要另外錄製，存放於
`hal/test-audio/`，且因為含你自己的聲音，建議一併進 `.gitignore`。

---

### S2 `openclaw-upgrade` —— 上游版本升級

**要解決的問題**：計劃書 §13 把「上游更新極快、設定鍵可能改名」列為風險，M6 的驗收標準是「升級只改版本號 +
smoke test」。但實際上沒那麼單純 —— D4 選了 Overlay，代表我們完全依賴上游的 config 鍵名與 RPC 方法名，
上游改名不會有編譯錯誤，只會在執行期安靜地失效。

**流程**：
1. 查目前釘選版本（Dockerfile 的 `OPENCLAW_VERSION`）與 npm 上的最新版，列出區間內的 release notes。
2. **重點：比對 config 鍵名。** 把 `hal/config/openclaw.json5` 的每個鍵拿去對照新版的 configuration reference，
   標出被改名、被移除、新增預設值的項目。特別盯 §8 那幾個：`talk.speechLocale`、`silenceTimeoutMs`、
   `interruptOnSpeech`、`realtime.brain`、`realtime.consultRouting`、`plugins.allow`。
3. 比對 `hal/server/src/rpc-allowlist.ts` 的方法名是否還存在於新版 Gateway protocol。
4. 改 `OPENCLAW_VERSION`、本機 build、跑 S1 `hal-smoke`。
5. 跑 S3 `hal-audit`（升級可能改變預設 tool policy，這是安全相關的必查項）。
6. 全綠才開 PR，PR 描述附上 release notes 摘要與鍵名 diff。

**為什麼值得做成 skill**：每月一次、步驟長、最關鍵的第 2 步（鍵名比對）最容易被跳過，而跳過的代價是
線上安靜失效。

---

### S3 `hal-audit` —— 安全與隱私邊界稽核

**要解決的問題**：計劃書 §9 開宗明義「安全是 v1 必要項目而非加分題」，訂了三層存取控制，加上 D3 之後多了一條
喚醒詞隱私邊界。這些規則寫在文件裡，但沒有任何機制阻止某次改動把它們破壞掉。

**檢查項**：

*三層存取控制（§9）*
- 第一層：無 `HAL_ACCESS_KEY` 時 `/` 是否只回全黑頁；key 是否確實轉成 HttpOnly cookie。
- 第二層：`rpc-allowlist.ts` 是否只含 Talk 相關方法；**有沒有任何 config / exec / 檔案類方法混進去**；
  BFF 是否預設拒絕未列名方法（而非預設放行）。
- 第三層：Gateway tool policy 是否確實排除 exec、檔案寫入、瀏覽器控制；`plugins.allow` 收緊時
  是否還保留內建 `openai` plugin（漏掉會讓 GPT-Live 會話建立失敗）。

*喚醒詞隱私邊界（§9）*
- `wake.ts` 不得保留音訊 buffer、不得寫入任何持久儲存（localStorage / IndexedDB / 上傳）。
- session 未建立前不得開啟 WebRTC 連線。
- `PICOVOICE_ACCESS_KEY` 由 BFF 注入，不得出現在前端原始碼或 build 產物裡。

*其他*
- Gateway 只綁 `127.0.0.1`，沒有意外對外。
- `/admin` 的 Basic Auth 確實生效（D5 保留了它，等於多開一個攻擊面）。
- build 產物裡不含任何 API key（grep 一次 `dist/`）。

**為什麼值得做成 skill**：這些是紅線而非偏好，人工複核會漏。多數項目可以靜態檢查，適合自動化。

---

### S4 `wake-tune` —— 喚醒詞調校

**要解決的問題**：M3.5 的驗收標準寫得很具體 ——「3 公尺外喊『HAL』可靠喚醒；一般對話 1 小時內誤觸發 0–1 次」。
這是個需要量測的數字，不是憑感覺調 `HAL_WAKE_SENSITIVITY` 就能達成的。而且計劃書 §6 已經點名「HAL」單音節
容易跟「哈囉」「how」「hall」「還好」混淆。

**流程**：
1. 建／更新兩組測試音檔：
   - **正樣本**：不同距離（1m / 3m / 5m）、不同音量語速、有無背景音樂的「HAL」。
   - **負樣本**：計劃書點名的混淆詞，加上一段真實的日常對話錄音當背景。
2. 對每個靈敏度值（0.3 / 0.4 / 0.5 / 0.6 / 0.7）批次餵入引擎，統計召回率與每小時誤觸發次數。
3. 輸出對照表，建議一個靈敏度值，寫回 `.env.example` 的 `HAL_WAKE_SENSITIVITY`。
4. 若 Porcupine 與 VAD 備案都實作了，兩者跑同一組樣本做橫向比較 —— 正好支援計劃書 §14 那項待 M0 定案的
   引擎選型。

**為什麼值得做成 skill**：調參是反覆的過程，而且換引擎、換麥克風、換擺放位置都要重跑。手動跑一輪就要餵幾十個
音檔，不自動化不會有人做第二次。

---

### S5 `eye-check` —— 紅眼狀態視覺驗收

**要解決的問題**：M2 驗收是「各狀態視覺可辨識，手機與大螢幕都不跑位」。紅眼是 HAL **唯一**的輸出通道
（§7.3：整頁沒有任何文字，連錯誤訊息都只用紅眼表達），視覺壞掉等於介面壞掉。

**流程**：把頁面強制切到七種 `data-state`，在三種視窗尺寸（手機直向 / 筆電 / 大螢幕橫向）各截一張圖，
排成 7×3 對照表；同時檢查光暈是否仍對齊鏡頭中心（§7.1 靠百分比定位，換素材或改 CSS 時最容易跑掉）。

**為什麼值得做成 skill**：`/design-review` 是給一般 UI 的，對「一顆會呼吸的紅點」沒有判斷依據。這個檢查
要能強制驅動狀態機、且知道要看什麼。

**注意**：CSS 動畫讓截圖有時序問題，`idle` / `thinking` 的呼吸動畫要先 `animation-play-state: paused`
再截，否則每次截到的亮度都不同、無法比較。

---

### S6 `bilingual-check` —— 雙語切換驗收

**要解決的問題**：D7 定了兩條硬規則（同句不混用、夾帶英文術語不算切換），M4 驗收要求「中英切換不會夾雜」。
這是 prompt 行為，改 instructions 或換模型版本都可能悄悄退化。

**流程**：準備固定的對話腳本（純中文 → 純英文 → 中文夾英文術語 → 切回中文），跑一輪，檢查每輪回覆的語言
是否符合預期、有無同句混用。可掛在 S2 升級流程後面當回歸測試。

**為什麼優先級最低**：它依賴真實 API 呼叫（有成本）、判斷帶主觀性、且退化的後果相對輕微（回錯語言不會出事）。
可以先手動驗，等真的被咬過再自動化。

---

## 4. 不建議做成 skill 的項目

| 項目 | 為什麼不做 |
| --- | --- |
| M0 Spike 探索 | 一次性任務，探索過程本來就該是對話式的，結論寫回計劃書即可 |
| M1 建 repo / Dockerfile | 只做一次 |
| Railway 部署 | gstack `/land-and-deploy` 已涵蓋，跑一次 `/setup-deploy` 設定好就行 |
| Code review / PR | gstack `/review`、`/ship`、內建 `/code-review` 已涵蓋 |
| 成本監控 | v1 單人使用，先靠 Railway 與供應商後台看；S3 的 rate limit 檢查已是主要煞車 |
| 素材處理（換高解析 HAL 圖） | 一次性，且是手動美術決定 |

---

## 5. 建置時序

**現在不要寫任何 skill。** M0 還沒跑，RPC 方法名、config 鍵名、喚醒詞引擎都還沒定案，現在寫的 skill 有很高
機率要重寫。

| 時機 | 動作 |
| --- | --- |
| M1 完成後 | 先建 `CLAUDE.md`（計劃書 §10 已列入結構但還沒寫），把 D1–D7 決策、`hal/` 目錄分工、命名規則、絕不可違反的安全紅線寫進去。這比任何 skill 都優先 —— 它是每次對話都會載入的常駐規則。 |
| M3 完成後 | 寫 S1 `hal-smoke`（此時鏈路已通，知道要斷言什麼） |
| M3.5 期間 | 寫 S4 `wake-tune`（調校過程中順手寫，音檔資產同時累積） |
| M4 期間 | 寫 S3 `hal-audit`（安全機制此時才完整存在） |
| M6 之前 | 寫 S2 `openclaw-upgrade`（它依賴 S1 與 S3） |
| 有空時 | S5 `eye-check`、S6 `bilingual-check` |

---

## 6. 目錄結構

```
open_HAL/
├── CLAUDE.md                      # 常駐專案規則（最優先，M1 後就寫）
├── .claude/
│   └── skills/
│       ├── hal-smoke/SKILL.md
│       ├── openclaw-upgrade/SKILL.md
│       ├── hal-audit/SKILL.md
│       ├── wake-tune/SKILL.md
│       ├── eye-check/SKILL.md
│       └── bilingual-check/SKILL.md
└── hal/
    └── test-audio/                # S1 / S4 的測試音檔（含個人聲音，建議 gitignore）
        ├── wake-positive/
        ├── wake-negative/
        └── smoke/
```
