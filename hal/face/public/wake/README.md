# 喚醒詞模型檔（`public/wake/`）

`src/wake.ts` 會從這個目錄（對應網址 `/wake/`）載入本機喚醒詞引擎需要的模型檔。
**音訊永遠不離開瀏覽器**：這些檔案是「下載進來的模型」，不是上傳出去的音訊（安全紅線 5）。

---

## 1. Porcupine（實作一，優先）

需要兩個檔案，**目前都尚未取得**，缺檔時 `wake.ts` 會自動降級到 VAD 備案：

| 檔名 | 對應 `/hal-config.json` 的欄位 | 來源 |
| --- | --- | --- |
| `hal.ppn` | `wake.keywordUrl` | Picovoice Console 自訓練 |
| `porcupine_params.pv` | `wake.modelUrl` | Porcupine SDK 內附 |

### 取得 `hal.ppn`

1. 到 <https://console.picovoice.ai/> 註冊（個人使用有免費額度，**請自行確認授權條款**）。
2. 左側 **Porcupine** → **Train Wake Word**。
3. Wake word 輸入 `HAL`（內建關鍵詞清單沒有這個字，一定要自訓練）。
4. Platform 選 **Web (WASM)**，語言選 English。
5. 下載 `.ppn`，**改名為 `hal.ppn`** 放進這個目錄。

> `.ppn` 綁定訓練時的平台與語言。選錯 platform（例如 Linux）在瀏覽器會直接初始化失敗。

### 取得 `porcupine_params.pv`

```bash
cp node_modules/@picovoice/porcupine-web/lib/common/porcupine_params.pv \
   public/wake/porcupine_params.pv
# 找不到時：https://github.com/Picovoice/porcupine/tree/master/lib/common
```

### AccessKey

**不要放在這裡，也不要寫進任何前端原始碼**（安全紅線 6）。
AccessKey 由 BFF 以 `PICOVOICE_ACCESS_KEY` 環境變數持有，透過
`GET /hal-config.json` 的 `wake.accessKey` 於執行期注入（契約 §2）。
BFF 沒設這個變數時會回 `engine: "vad"`，前端自動走備案引擎。

---

## 2. Silero VAD（實作二，備案）

不需要人工放檔：`vite.config.ts` 的 `hal-wake-assets` plugin 會在 dev server 與
`npm run build` 時，自動把下列檔案從 `node_modules` 放到 `/wake/`：

- `vad.worklet.bundle.min.js`、`silero_vad_legacy.onnx`（`@ricky0123/vad-web`）
- `ort-wasm-simd-threaded.mjs`、`ort-wasm-simd-threaded.wasm`（`onnxruntime-web`）

所以這些檔名在 `public/wake/` 內是**保留字**，不要放同名檔案。
Silero 也載不起來時，`wake.ts` 會再降級到零相依的能量式 VAD。

---

## 3. 版控

`.ppn` / `.pv` 是個人帳號下載的模型檔，**不要 commit**（見 `hal/face/.gitignore`）。
本目錄只保留 `.gitkeep` 與這份說明。
