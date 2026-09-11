# open_HAL

以 [OpenClaw](https://github.com/openclaw/openclaw) 為基底的個人 AI 助理。介面只有一張全螢幕的 HAL 圖片與一顆依狀態閃爍的紅眼，唯一的輸入方式是說話：對著螢幕喊「HAL」喚醒，之後以語音對話，HAL 也以語音回答。整頁沒有任何文字、按鈕、對話紀錄或設定畫面。

**Based on OpenClaw (MIT, © OpenClaw Foundation).** 本專案採 Overlay 模式，repo 內只有客製層（`hal/`），OpenClaw 本體是以 npm 套件形式安裝的**釘選版本**（目前 `2026.9.4`），核心程式碼未經修改。授權詳見 [`LICENSE`](LICENSE) 與 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 架構

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
│   ├─ /admin        → Control UI（Basic Auth，選配）            │
│   └─ 啟動並監控子行程 ▼                                       │
│  OpenClaw Gateway（127.0.0.1:18789，不對外）                  │
│   ├─ Talk broker（talk.client.create / toolCall …）            │
│   ├─ Agent（Claude）+ 記憶 + Skills + Tool policy              │
│   └─ 狀態與 workspace → /data（Railway Volume）                │
└──────────────────────────────────────────────────────────────┘
```

BFF 這一層的存在理由是安全：瀏覽器永遠拿不到 Gateway token，也只能呼叫 Talk 所需的少數 RPC 方法，其餘一律拒絕。

---

## 快速開始

### 本機以 Docker 執行

```bash
# 1. 準備環境變數
cp .env.example .env
#    至少要填：OPENCLAW_GATEWAY_TOKEN、ANTHROPIC_API_KEY、OPENAI_API_KEY、
#              HAL_ACCESS_KEY、ADMIN_USER、ADMIN_PASS

# 2. 建置映像（OPENCLAW_VERSION 已在 Dockerfile 釘選，要覆寫才需要 --build-arg）
docker build -t open-hal .

# 3. 執行。/data 掛成具名 volume，模擬 Railway Volume 的持久化行為
docker run --rm \
  -p 8080:8080 \
  -e PORT=8080 \
  --env-file .env \
  -v open-hal-data:/data \
  --name open-hal \
  open-hal

# 4. 確認健康狀態（會同時回報 BFF 與 Gateway 子行程）
curl -s http://127.0.0.1:8080/healthz
```

接著以 `http://127.0.0.1:8080/?k=<HAL_ACCESS_KEY>` 開啟頁面，點一次紅眼完成麥克風授權，之後喊「HAL」即可開始對話。

> 注意：瀏覽器只在 HTTPS（或 `localhost`）下允許使用麥克風。用區域網路 IP 開頁面會拿不到麥克風權限。

### 部署到 Railway

1. 在 Railway 建立專案，從 GitHub 連結本 repo，建置方式選 **Dockerfile**（[`railway.json`](railway.json) 已設定好 builder、`ON_FAILURE` 重啟策略與 `/healthz` 健康檢查）。
2. 在服務上掛載 **Volume 至 `/data`** —— 沒有這一步，重新部署後 HAL 的設定、人格與記憶都會消失。
3. 依 [`.env.example`](.env.example) 填入 Variables。`PORT` 由 Railway 自動注入，不要自己設。
4. 在 **Public Networking** 開啟 HTTP 網域。
5. 部署後以 `https://<網域>/?k=<HAL_ACCESS_KEY>` 開啟，點一下紅眼完成授權。
6. 之後 push 到 `main` 即自動重新部署。自訂網域可在最後綁定。

Kiosk 模式若要做到「開機即聽」、免去首次點擊，可用 Chromium 啟動參數 `--use-fake-ui-for-media-stream` 與 `--autoplay-policy=no-user-gesture-required`。

---

## 環境變數

完整清單、用途說明與預設值請見 [`.env.example`](.env.example)。重點：

- `OPENCLAW_*` 一律沿用上游命名，不改名，以維持與官方文件、升級腳本的相容性。
- 敏感值（`OPENCLAW_GATEWAY_TOKEN`、各家 API key、`HAL_ACCESS_KEY`、`ADMIN_PASS`、`PICOVOICE_ACCESS_KEY`）只存在於伺服器端，**絕不可傳到瀏覽器**。
- 升級上游只需要改 `OPENCLAW_VERSION`（Dockerfile 的 `ARG`）並跑一次 smoke test。

---

## 專案結構

```
open_HAL/
├── hal/
│   ├── face/                    # HAL 單頁（Vite + TS），唯一的使用者介面
│   ├── server/                  # BFF（Node + TS）：靜態檔、RPC 白名單、spawn Gateway
│   ├── config/openclaw.json     # Gateway 設定種子，首次啟動寫入 /data/.openclaw/openclaw.json
│   └── workspace-seed/          # HAL 人格檔，首次啟動複製到 /data/workspace
├── docs/                        # 計劃書與技術查證（不進映像）
├── Dockerfile
├── railway.json
├── .env.example
├── CLAUDE.md                    # 常駐專案規則（安全紅線、決策摘要、目錄分工）
├── LICENSE                      # MIT，並完整保留 OpenClaw 的版權聲明
└── THIRD_PARTY_NOTICES.md
```

---

## 授權

open_HAL 採 **MIT** 授權。本專案基於 OpenClaw（MIT，© OpenClaw Foundation），上游 LICENSE 原文與第三方聲明均完整保留於 [`LICENSE`](LICENSE) 與 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

`hal9000-sounds/` 為 **GPL-3.0** 素材，僅作為挑選語音音色時的聽感參考，不進版控、不進 Docker build context、不會出現在任何部署產物中。

---

## 文件

設計決策、語音管線、安全模型與里程碑規劃，見 [`docs/open_HAL_計劃書_v0.1.md`](docs/open_HAL_計劃書_v0.1.md)。
