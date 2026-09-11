# HAL Face

open_HAL 的唯一介面：全螢幕純黑底、一顆會依狀態閃爍的 HAL 紅眼，整頁沒有任何文字。
Vite + 原生 TypeScript，沒有任何 UI framework。

## 指令

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc --noEmit + vite build → dist/
npm run preview
```

## 素材

`public/hal-eye.svg` 是暫時的佔位素材。**換成正式素材時只要換這個檔 + 確認鏡頭中心仍在圖片正中央**，
程式與樣式都不必改；若正式素材的寬高比不是 4:3，或鏡頭不在正中央，改 `src/hal.css` 最上面的
`--ar-w / --ar-h`（寬高比）與 `--eye-cx / --eye-cy`（鏡頭中心位置）即可。
素材路徑寫在 `src/main.ts` 的 `EYE_IMAGE` 常數。

## 狀態

狀態寫在 `#hal` 與 `<html>` 的 `data-state` 屬性上（`offline` / `idle` / `waking` /
`listening` / `thinking` / `speaking` / `error`），CSS 以 `[data-state="..."]` 選擇器上動畫。
`listening` 與 `speaking` 不用 CSS animation，改由 `src/eye.ts` 以 `requestAnimationFrame`
讀取音訊 RMS 寫入 `--level` / `--scale`。

## Dev 驅動（假資料）

只在 `npm run dev` 或網址帶 `?dev=1` 時生效：

| 操作 | 效果 |
| --- | --- |
| 鍵盤 `1`–`7` | 依序切換七種狀態 |
| `?state=thinking` | 直接鎖定某個狀態（截圖用） |
| `?freeze=1` | 暫停動畫並鎖住 `--level` / `--scale`，截圖可重現 |

例：`npm run preview` 後開 `http://localhost:4173/?dev=1&state=speaking&freeze=1`。

## 模組（M3 / M3.5）

| 檔案 | 職責 |
| --- | --- |
| `src/rpc.ts` | 與 BFF 的 `/hal` WebSocket（契約 §4）。cookie 認證、網址不帶 token、指數退避重連 |
| `src/config.ts` | 讀 `GET /hal-config.json`（契約 §2）。**前端持有零機密**，金鑰只可能來自 BFF |
| `src/talk.ts` | Realtime session 生命週期（M0 §B5 的 15 步序列）、toolCall、逐字稿、TTL 重建 |
| `src/wake.ts` | 本機喚醒詞引擎：Porcupine → Silero VAD → 能量式 VAD 三段降級 |
| `src/main.ts` | 把上面四者串成計劃書 §6 的流程 |

流程：

```
offline → 點一次畫面（麥克風與播音授權）→ 連 /hal → idle（喚醒詞監聽中）
  → 聽到「HAL」→ waking → listening → thinking → speaking
  → 靜默逾時 → talk.client.close → idle
```

喚醒詞模型檔放在 `public/wake/`，取得方式見 `public/wake/README.md`。

### 網址參數

| 參數 | 效果 |
| --- | --- |
| `?dev=1` | 只跑假驅動，**不啟動**真實語音管線 |
| `?tap=1` | 用點擊觸發對話，取代喚醒詞（M3 驗收用；喚醒詞引擎全掛時也會自動降級成這個） |

---

## 給 M3 的接口

頁面啟動後掛上 `window.hal`（型別 `HalRuntime`，定義於 `src/main.ts`）：

```ts
window.hal.setState('waking');              // 切狀態
window.hal.ensureAudio();                   // 取得／沿用麥克風與 AudioContext
window.hal.audio?.inputAnalyser;            // 麥克風 AnalyserNode（已接給 listening）
window.hal.attachOutput(outputAnalyser);    // HAL 說話時接上輸出音訊 → speaking 跟隨振幅
window.hal.eye;                             // 完整的 HalEye API
```

M3 已接上這個介面（`src/talk.ts` 用 `ensureAudio` / `attachOutput` / `setState`，`src/main.ts` 用 `eye`）。
