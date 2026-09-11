# open_HAL 第三方授權聲明

open_HAL 以 **OpenClaw（MIT，© OpenClaw Foundation）** 為基底，採 Overlay 模式：
repo 內只有客製層，OpenClaw 本體是以 npm 套件形式安裝的釘選版本（見 `Dockerfile`
的 `OPENCLAW_VERSION`），未經修改。

本檔案分三部分：

1. 完整轉錄上游 OpenClaw 的 `THIRD_PARTY_NOTICES.md`（對應 openclaw@2026.9.4）。
2. open_HAL 自己引入的素材：`hal9000-sounds/`（GPL-3.0）。
3. 授權待確認的元件：喚醒詞引擎 Picovoice Porcupine。

上游 OpenClaw 本身的 MIT 授權條文，請見本 repo 的 `LICENSE`。

---

# 第一部分：上游 OpenClaw 的第三方聲明（逐字轉錄）

> 來源：`openclaw@2026.9.4` 套件內的 `THIRD_PARTY_NOTICES.md`。
> 以下內容不經改寫，升級上游版本時必須一併重新轉錄。

# Third-party notices

This file records third-party notices for code or substantial implementation
portions incorporated into OpenClaw source, beyond normal package-manager
dependency metadata.

## Pi / pi-mono

Portions of OpenClaw were adapted from Pi / pi-mono, and OpenClaw also depends
on `@earendil-works/pi-tui` for terminal UI rendering.

- Upstream: https://github.com/earendil-works/pi-mono
- Package family: `@earendil-works/pi-*`
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## GitHub Octicons

The Control UI bundles the `issue-opened-16` and `git-pull-request-16` icon paths.

- Upstream: https://github.com/primer/octicons
- License: MIT
- Copyright: Copyright (c) 2026 GitHub Inc.

MIT License

Copyright (c) 2026 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

# 第二部分：open_HAL 自行引入的素材

## hal9000-sounds/ —— HAL 音色參考素材（GPL-3.0）

- 授權：**GPL-3.0**
- 來源 repo：`ha-hal9000-sounds`（為 Home Assistant 事件錄製的英文短句，共 49 個片段）
- 在 open_HAL 中的角色：**僅作為選擇 Realtime voice 時的音色與語調聽感基準**
  （低沉、氣音偏多、語速慢而平穩、句尾不上揚、幾乎沒有情緒起伏）。

**授權界線（計劃書 §2，不得違反）：**

- 這些音檔**不會**被打包進 open_HAL 的任何產物：已列入 `.gitignore` 與
  `.dockerignore`，不進版控、不進 Docker build context、不進部署映像。
- **不會**上傳給任何模型做聲音複製（voice cloning），也不會作為 TTS 的參考音訊。
- **不會**在執行期被播放（例如當提示音）。若日後想這麼做，必須先處理 GPL-3.0 的
  傳染性授權問題 —— 這屬於 v1 範圍外。
- HAL 的人格檔（`hal/workspace-seed/`）與 Realtime instructions 中**只描述性格**，
  不寫入任何電影台詞，也不描述要模仿特定演員的聲音。
- 這些片段是 mp3 且內容為英文智慧家庭短句，**不能**當作 `hal-smoke` / `wake-tune`
  的測試輸入（測試音檔另行錄製，放在 `hal/test-audio/`，同樣不進版控）。

---

# 第三部分：授權待確認的元件

## Picovoice Porcupine Web —— 瀏覽器端喚醒詞引擎（授權待確認）

計劃書 §6 / D3 將 Porcupine Web（WASM）列為喚醒詞引擎的**優先候選**，備案為
Silero VAD。引擎選型由 M0 定案，尚未實際引入。

一旦確定採用，本節必須補上：

- Porcupine Web SDK 的實際授權條款與版本（個人使用的免費額度條件、商業使用限制）。
- 自訓練「HAL」關鍵詞模型檔（`.ppn`）的授權與再散布限制。
- Silero VAD 若作為備案實作，其授權（MIT）與模型檔授權也要一併列出。

實作上的既有約束（計劃書 §9，與授權無關但同樣不可違反）：
`PICOVOICE_ACCESS_KEY` 由 BFF 於執行期注入，**不得**寫死在前端原始碼、也不得
出現在 build 產物中。
