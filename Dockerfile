# ─────────────────────────────────────────────────────────────────────────────
# open_HAL 容器映像（Overlay 模式，見計劃書 §4 / D4）
#
# 這個映像只包含 open_HAL 的客製層（hal/），OpenClaw 本體是從 npm 安裝的
# 釘選版本，不做任何 fork 或原始碼修改。
#
# base image 選擇依據：openclaw@2026.9.4 的 package.json engines 欄位為
#   "node": ">=24.16.0 <25 || >=26.1.0"
# 也就是 Node 24.16–24.x 或 26.1 以上皆可，25.x 明確排除。
# Docker Hub 上 node:26-bookworm-slim 存在（目前解析到 26.8.2），符合 >=26.1.0，
# 且與計劃書 §11.1 草稿一致，因此採用 26 線。
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:26-bookworm-slim

# ══ 階段 1：建置前端（hal/face）與 BFF（hal/server）══════════════════════════
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# 先只複製兩個子專案的 manifest，讓依賴安裝這一層能被 Docker layer cache 命中。
# 計劃書 §11.1 草稿直接 `COPY hal/` 再安裝，會導致每次改一行原始碼就重裝全部依賴。
COPY hal/face/package*.json ./hal/face/
COPY hal/server/package*.json ./hal/server/

# `npm ci` 需要 package-lock.json。M1 階段這兩個子專案可能還沒有 lockfile 進 repo，
# 所以先用 `npm ci || npm install` 這種務實寫法保證建置不會卡住。
# TODO：等 hal/face/package-lock.json 與 hal/server/package-lock.json 都進 repo 後，
#       請把下面兩行的 `|| npm install` 拿掉，改回純 `npm ci`，以確保建置可重現。
RUN npm --prefix ./hal/face ci || npm --prefix ./hal/face install
RUN npm --prefix ./hal/server ci || npm --prefix ./hal/server install

# 依賴裝完才複製原始碼，這樣改程式碼只會失效下面這幾層。
COPY hal/ ./hal/

# hal/face → 靜態檔（Vite 產出 dist/）；hal/server → dist/（tsc 產出）
RUN npm --prefix ./hal/face run build \
 && npm --prefix ./hal/server run build

# ══ 階段 2：執行期映像 ═══════════════════════════════════════════════════════
FROM ${NODE_IMAGE} AS runtime

# OpenClaw 版本一律釘選，不使用 latest（計劃書 §4、§13：上游更新極快，
# 升級必須是一次刻意的、跑過 smoke test 的動作）。
ARG OPENCLAW_VERSION=2026.9.4

# HEALTHCHECK 需要 curl；--no-install-recommends 避免拖進不必要的套件。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 安裝釘選版本的 OpenClaw。
# npm 11.16+ 與 npm 12 需要 `--allow-scripts=openclaw` 才會執行套件的 lifecycle
# script；npm 11.15 以下不認得這個旗標。為了不綁死 base image 內建的 npm 版本，
# 先帶旗標試一次，失敗再退回不帶旗標的寫法。
RUN npm install -g "openclaw@${OPENCLAW_VERSION}" --allow-scripts=openclaw \
 || npm install -g "openclaw@${OPENCLAW_VERSION}"

WORKDIR /app

# 只把建置產物與執行期需要的檔案帶進最終映像。
# docs/、hal9000-sounds/、.git 由 .dockerignore 擋掉，不會進到 build context。
COPY --from=builder /app/hal/face/dist        ./hal/face/dist
COPY --from=builder /app/hal/server/dist      ./hal/server/dist
COPY --from=builder /app/hal/server/node_modules ./hal/server/node_modules
COPY --from=builder /app/hal/server/package.json ./hal/server/package.json

# 設定種子與人格種子：hal-server 首次啟動時若 /data 還是空的，就從這裡複製過去。
# 設定種子的檔名是 hal/config/openclaw.json（不是 .json5）—— OpenClaw 的設定檔名固定
# 為 openclaw.json，內容才以 JSON5 解析。複製目標是 $OPENCLAW_STATE_DIR/openclaw.json，
# 也就是 /data/.openclaw/openclaw.json（M0 §C15）。
COPY hal/config/         ./hal/config/
COPY hal/workspace-seed/ ./hal/workspace-seed/

# ── 環境變數（計劃書 §11.2）─────────────────────────────────────────────────
# 這些沿用上游的 OPENCLAW_* 命名，不改名，確保與官方文件、升級腳本相容。
ENV NODE_ENV=production \
    OPENCLAW_STATE_DIR=/data/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/data/workspace \
    OPENCLAW_GATEWAY_PORT=18789

# Railway 會注入 $PORT 並自行處理對外連接埠對應，所以不需要 EXPOSE。
#
# ⚠️ 內部的 Gateway（18789）要只綁 127.0.0.1，**不能靠預設值**：容器環境內 bind 的
#    有效預設是 auto → 0.0.0.0（M0 §D18），而且 bind 沒有對應的環境變數，這裡設不了。
#    兩道防線都在映像之外：
#      1. 設定種子 hal/config/openclaw.json 的 gateway.bind: "loopback"
#      2. hal/server 以子行程啟動 Gateway 時帶 --bind loopback（CLI flag 優先序最高）
#
# ⚠️ Gateway 的啟動前提：設定裡必須有 gateway.mode: "local"，否則 openclaw gateway
#    會直接拒絕啟動（不是跳 wizard 卡住，M0 §E23）。種子已含該鍵；hal-server 另以
#    --allow-unconfigured 作保險，但它只跳過那道守衛，不會建立或修復設定。
#    另外 openclaw gateway 沒有 --no-update-check / --headless / --non-interactive
#    這三個 flag（M0 §E20），關版本檢查一律用設定鍵 update.checkOnStart: false。

# hal-server 的 /healthz 會同時回報 BFF 與 Gateway 子行程的狀態。
# start-period 給得寬一些，因為首次啟動要寫入設定種子並拉起 Gateway。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

CMD ["node", "hal/server/dist/index.js"]
