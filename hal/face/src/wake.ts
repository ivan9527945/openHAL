/**
 * open_HAL — 本機喚醒詞引擎（計劃書 §6、D3；安全紅線 5、6）
 *
 * ============================ 隱私硬性要求 ============================
 * 待喚醒期間的音訊只在瀏覽器本機的 WASM 引擎裡被處理。逐條對應安全紅線 5：
 *
 *  1. **不得保留音訊 buffer** —— 本檔所有音訊緩衝都是「固定長度、反覆覆寫」的
 *     TypedArray（見 createFrameTap 的 `frame`）。全檔沒有任何
 *     `Float32Array[]` / `push(chunk)` 之類的累積結構，用完即丟。
 *  2. **不得寫入任何持久儲存** —— 本檔沒有瀏覽器 Storage（local / session）、
 *     IndexedDB 或 Cache API 的任何呼叫。整個 src/ 對這些 API 的 grep 應為空。
 *     ⚠️ 例外並已知：Picovoice 的 `@picovoice/web-utils` 會把 **模型檔本身**
 *        （.pv / .ppn）快取進 IndexedDB，且 SDK 沒有關閉的選項。那是模型二進位檔，
 *        **不是音訊**，但仍與紅線 5 的字面文字有出入 —— 見 startPorcupine() 的註解。
 *  3. **不得上傳任何音訊** —— 本檔唯一的網路行為是 `fetch(keywordUrl/modelUrl)`
 *     這種「下載模型檔」的 GET，沒有任何上傳；音訊永遠不離開這個 AudioContext。
 *  4. **session 未建立前不得建立 RTCPeerConnection** —— 本檔完全沒有 WebRTC 相關
 *     API；RTCPeerConnection 只存在於 talk.ts，且一定在 `talk.client.create`
 *     成功之後才建立。
 *
 * ============================ 兩種可互換的實作 ============================
 * 計劃書 §13 把「第三方授權或 AccessKey 不可用」列為風險，對策是抽象成單一介面：
 *
 *   1. Porcupine Web（`@picovoice/porcupine-web`）—— 真正的「HAL」關鍵詞比對。
 *      AccessKey / keywordUrl / modelUrl / sensitivity 全部來自 `/hal-config.json`
 *      （契約 §2），**絕不寫死**（安全紅線 6）。
 *   2. VAD 備案 —— Silero VAD WASM（`@ricky0123/vad-web`）；再降一級是零相依的
 *      能量式 VAD，確保任何環境下頁面都還能運作。
 *
 * 降級順序：porcupine →（模型檔或金鑰缺席）→ silero-vad →（模型檔載入失敗）→ energy-vad。
 */

import type { HalWakeConfig } from './config.js';

export interface WakeEngine {
  start(stream: MediaStream): Promise<void>;
  stop(): Promise<void>;
  onWake(cb: () => void): void;
  /** 目前實際生效的實作名稱（未啟動時是候選清單的第一個） */
  readonly name: string;
}

/** Porcupine 與能量式 VAD 都吃 16 kHz 單聲道 */
const TARGET_SAMPLE_RATE = 16_000;
/** 同一顆引擎兩次喚醒之間的最短間隔，避免一句話連噴好幾次 */
const WAKE_COOLDOWN_MS = 1_500;

// ────────────────────────────────────────────────────────────────────────────
// 音框抽取：把 MediaStream 轉成 16 kHz / Int16 的固定長度音框
// ────────────────────────────────────────────────────────────────────────────

interface FrameTap {
  stop(): Promise<void>;
}

/** AudioWorklet 的處理器原始碼；只負責把 Float32 批次丟回主執行緒，不做任何保存 */
/**
 * 音框抽取 worklet 的路徑。**必須是同源實體檔案，不可改回 blob: URL** ——
 * `audioWorklet.addModule()` 受 CSP 的 `script-src` 管轄（worklet 算 script 不算 worker），
 * BFF 的 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`，blob: 會被擋。
 * 改回 blob: 的症狀是「開發正常、上線後喚醒詞靜默降級」，極難察覺。
 */
const TAP_WORKLET_URL = '/wake/tap-worklet.js';

/**
 * 從 MediaStream 抽出 16 kHz / Int16 / 固定長度的音框。
 *
 * `onFrame` 收到的是**共用且會被覆寫的 buffer**，呼叫端不得保留參考 —— 這正是
 * 「不得保留音訊 buffer」的實作方式：整條管線只存在一個 frameLength 大小的陣列。
 */
async function createFrameTap(
  stream: MediaStream,
  frameLength: number,
  onFrame: (frame: Int16Array) => void,
): Promise<FrameTap> {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    // Safari 會忽略／拒絕 sampleRate；退回預設取樣率，下面自己做線性重取樣
    ctx = new AudioContext();
  }
  if (ctx.state === 'suspended') await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  // 靜音出口：ScriptProcessor 在 Chrome 必須接到 destination 才會被拉動，
  // gain=0 確保麥克風絕不會被播出去造成回授。
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  const ratio = ctx.sampleRate / TARGET_SAMPLE_RATE;
  const frame = new Int16Array(frameLength); // ← 唯一的音訊暫存，反覆覆寫
  let filled = 0;
  let cursor = 0;

  function push(sample: number): void {
    const v = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    frame[filled++] = Math.round(v * 32767);
    if (filled === frameLength) {
      filled = 0;
      onFrame(frame);
    }
  }

  function pushChunk(chunk: Float32Array): void {
    if (ratio === 1) {
      for (let i = 0; i < chunk.length; i++) push(chunk[i] ?? 0);
      return;
    }
    while (cursor < chunk.length) {
      const i = Math.floor(cursor);
      const f = cursor - i;
      const a = chunk[i] ?? 0;
      const b = chunk[i + 1] ?? a;
      push(a + (b - a) * f);
      cursor += ratio;
    }
    cursor -= chunk.length;
  }

  let node: AudioNode;
  let disconnect: () => void;

  try {
    await ctx.audioWorklet.addModule(TAP_WORKLET_URL);
    const worklet = new AudioWorkletNode(ctx, 'hal-tap');
    worklet.port.onmessage = (ev: MessageEvent<unknown>) => {
      if (ev.data instanceof Float32Array) pushChunk(ev.data);
    };
    node = worklet;
    disconnect = () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
    };
  } catch (err) {
    // AudioWorklet 不可用（舊瀏覽器，或 /wake/tap-worklet.js 沒被部署）→ 退回 ScriptProcessor。
    // ScriptProcessor 已廢棄且跑在主執行緒，會造成音訊 glitch 並卡住紅眼動畫，屬於次級路徑。
    console.warn('[hal/wake] AudioWorklet 不可用，改用 ScriptProcessor', err);
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (ev: AudioProcessingEvent) => {
      pushChunk(ev.inputBuffer.getChannelData(0));
      ev.outputBuffer.getChannelData(0).fill(0);
    };
    node = sp;
    disconnect = () => {
      sp.onaudioprocess = null;
      sp.disconnect();
    };
  }

  source.connect(node);
  node.connect(mute);

  return {
    async stop(): Promise<void> {
      disconnect();
      source.disconnect();
      mute.disconnect();
      frame.fill(0); // 離開監聽狀態時把最後一個音框也抹掉
      try {
        await ctx.close();
      } catch {
        /* 已經關掉了 */
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 候選實作
// ────────────────────────────────────────────────────────────────────────────

/** 每個候選實作 start 後回傳自己的停止函式 */
type StartFn = (stream: MediaStream, onWake: () => void) => Promise<() => Promise<void>>;

interface Candidate {
  name: string;
  start: StartFn;
}

/** 模型檔是否真的存在（不存在就直接降級，不要讓 SDK 丟一堆難懂的錯） */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL(url, document.baseURI).toString(), {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

// ── 實作一：Porcupine Web ────────────────────────────────────────────────────

function porcupineCandidate(cfg: HalWakeConfig): Candidate {
  return {
    name: 'porcupine',
    start: async (stream, onWake) => {
      const accessKey = cfg.accessKey;
      if (accessKey === null) {
        // AccessKey 只能由 BFF 於執行期注入（安全紅線 6），前端沒有任何替代來源
        throw new Error('未取得 PICOVOICE_ACCESS_KEY（BFF 未注入）');
      }
      const [hasKeyword, hasModel] = await Promise.all([
        assetExists(cfg.keywordUrl),
        assetExists(cfg.modelUrl),
      ]);
      if (!hasKeyword || !hasModel) {
        throw new Error(
          `喚醒詞模型檔不存在（keyword=${hasKeyword}, model=${hasModel}）。` +
            '請到 Picovoice Console（https://console.picovoice.ai/）訓練「HAL」關鍵詞，' +
            `下載 Web(WASM) 版的 .ppn 放到 hal/face/public${cfg.keywordUrl.startsWith('/') ? '' : '/'}${cfg.keywordUrl}，` +
            '並把 porcupine_params.pv 一併放進 public/wake/（詳見 public/wake/README.md）。',
        );
      }

      // ⚠️ 已知的隱私例外：Picovoice SDK（@picovoice/web-utils）會把 .pv / .ppn
      //    模型檔快取進 IndexedDB，SDK 未提供關閉選項。那是「模型二進位檔」而非音訊，
      //    音訊本身仍然只在 WASM 記憶體內處理、絕不外流；但這點與安全紅線 5 的字面
      //    文字（「不得寫入任何持久儲存」）有出入，需由人類確認是否接受。
      const { PorcupineWorker } = await import('@picovoice/porcupine-web');
      const worker = await PorcupineWorker.create(
        accessKey,
        { label: 'HAL', publicPath: cfg.keywordUrl, sensitivity: cfg.sensitivity },
        () => onWake(),
        { publicPath: cfg.modelUrl },
        {
          processErrorCallback: (err) => console.error('[hal/wake] Porcupine 處理錯誤', err),
        },
      );

      // 音框直接餵進 worker；worker.process 內部是 structured clone，
      // 主執行緒這邊不留任何副本。
      const tap = await createFrameTap(stream, worker.frameLength, (frame) => {
        worker.process(frame);
      });

      return async () => {
        await tap.stop();
        try {
          await worker.release();
        } catch (err) {
          console.warn('[hal/wake] Porcupine release 失敗', err);
        }
        worker.terminate();
      };
    },
  };
}

// ── 實作二之一：Silero VAD（@ricky0123/vad-web） ─────────────────────────────

function sileroCandidate(cfg: HalWakeConfig): Candidate {
  return {
    name: 'silero-vad',
    start: async (stream, onWake) => {
      // 模型與 wasm 由 vite.config.ts 的 wakeAssets plugin 從 node_modules 複製到 /wake/，
      // 不走任何 CDN，維持「音訊與資產都不外流」的前提。
      const assetBase = new URL('wake/', document.baseURI).toString();
      const vad = await import('@ricky0123/vad-web');

      // sensitivity 越高 → 門檻越低 → 越容易判定為人聲
      const positive = Math.min(0.95, Math.max(0.2, 0.85 - 0.35 * cfg.sensitivity));

      const mic = await vad.MicVAD.new({
        // 一律沿用 main.ts 取得的那條 MediaStream；本引擎自己不呼叫 getUserMedia，
        // 也不會把 track 停掉（否則 talk.ts 的通話會跟著斷）。
        getStream: async () => stream,
        pauseStream: async () => {
          /* 不停 track：stream 的擁有者是 window.hal */
        },
        resumeStream: async () => stream,
        startOnLoad: false,
        model: 'legacy',
        baseAssetPath: assetBase,
        onnxWASMBasePath: assetBase,
        positiveSpeechThreshold: positive,
        negativeSpeechThreshold: Math.max(0.1, positive - 0.15),
        minSpeechMs: 250,
        // preSpeechPad 設 0：讓函式庫內部保留的音訊愈少愈好（安全紅線 5）
        preSpeechPadMs: 0,
        submitUserSpeechOnPause: false,
        // TODO: 關鍵詞比對，M0 引擎選型定案後補 ——
        //       v1 先把「偵測到一段人聲」當成喚醒候選；真正比對「HAL」要等
        //       Porcupine 模型檔到位（或改用其他本機關鍵詞引擎）。
        onSpeechRealStart: () => onWake(),
        onSpeechEnd: () => {
          // 刻意不接 audio 參數：那段 Float32Array 一律丟棄，不保留、不上傳（安全紅線 5）
        },
      });
      await mic.start();

      return async () => {
        try {
          await mic.destroy();
        } catch (err) {
          console.warn('[hal/wake] Silero VAD destroy 失敗', err);
        }
      };
    },
  };
}

// ── 實作二之二：零相依的能量式 VAD（最後保底） ───────────────────────────────

function energyCandidate(cfg: HalWakeConfig): Candidate {
  return {
    name: 'energy-vad',
    start: async (stream, onWake) => {
      const FRAME = 512; // 32 ms @ 16 kHz
      /** 連續幾個音框超過門檻才算人聲（約 260 ms） */
      const SPEECH_FRAMES = 8;
      /** 絕對下限，避免安靜房間的底噪被當成人聲 */
      const ABS_FLOOR = 0.012;
      // sensitivity 越高 → 相對門檻越低
      const RATIO = 3.6 - 1.6 * cfg.sensitivity;

      let noise = 0.01;
      let voiced = 0;

      const tap = await createFrameTap(stream, FRAME, (frame) => {
        // 只算純量（RMS），不保留任何音訊樣本
        let sum = 0;
        for (let i = 0; i < FRAME; i++) {
          const v = (frame[i] ?? 0) / 32768;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / FRAME);

        // 慢升快降的底噪追蹤：安靜時快速貼近，吵雜時緩慢抬升
        noise += (rms - noise) * (rms > noise ? 0.002 : 0.05);

        if (rms > Math.max(ABS_FLOOR, noise * RATIO)) {
          voiced += 1;
          if (voiced === SPEECH_FRAMES) onWake();
        } else {
          voiced = 0;
        }
      });

      // TODO: 關鍵詞比對，M0 引擎選型定案後補 —— 這裡同樣只做「偵測到人聲片段」。
      return async () => {
        await tap.stop();
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 組合：依序嘗試候選實作，失敗就降級
// ────────────────────────────────────────────────────────────────────────────

export async function createWakeEngine(cfg: HalWakeConfig): Promise<WakeEngine> {
  const candidates: Candidate[] = [];
  if (cfg.engine === 'porcupine') candidates.push(porcupineCandidate(cfg));
  candidates.push(sileroCandidate(cfg), energyCandidate(cfg));

  const listeners = new Set<() => void>();
  let stopFn: (() => Promise<void>) | null = null;
  let active = candidates[0]?.name ?? 'none';
  let lastWake = 0;
  let starting: Promise<void> | null = null;

  function fire(): void {
    const now = Date.now();
    if (now - lastWake < WAKE_COOLDOWN_MS) return;
    lastWake = now;
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        console.error('[hal/wake] onWake handler 例外', err);
      }
    }
  }

  async function startInner(stream: MediaStream): Promise<void> {
    for (const c of candidates) {
      try {
        stopFn = await c.start(stream, fire);
        active = c.name;
        console.info(`[hal/wake] 喚醒詞引擎啟動：${c.name}`);
        return;
      } catch (err) {
        console.error(`[hal/wake] 引擎 "${c.name}" 啟動失敗，嘗試降級`, err);
      }
    }
    active = 'none';
    throw new Error('[hal/wake] 所有喚醒詞引擎都無法啟動');
  }

  return {
    get name(): string {
      return active;
    },

    async start(stream: MediaStream): Promise<void> {
      if (stopFn !== null) return; // 已在監聽
      if (starting !== null) return starting;
      starting = startInner(stream);
      try {
        await starting;
      } finally {
        starting = null;
      }
    },

    async stop(): Promise<void> {
      if (starting !== null) {
        try {
          await starting;
        } catch {
          /* 啟動本來就失敗了 */
        }
      }
      const fn = stopFn;
      stopFn = null;
      if (fn) await fn();
    },

    onWake(cb: () => void): void {
      listeners.add(cb);
    },
  };
}
