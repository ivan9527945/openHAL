/**
 * open_HAL — HAL Face 進入點（計劃書 §6、§7.3）
 *
 * M2 完成了視覺與狀態機，M3 / M3.5 在這裡把語音鏈路接上：
 *
 *   offline → 點一次畫面（取得麥克風與音訊播放許可）→ 連 /hal → idle（喚醒詞監聽中）
 *     → 聽到「HAL」→ waking（紅眼立刻亮，不等 session 建好）→ listening → thinking → speaking
 *     → 靜默逾時 → talk.client.close → idle
 *
 * 整頁沒有任何文字、按鈕或提示 UI（UI 紅線）；錯誤只切 `error` 狀態 + console.error。
 */

import { createEye, type HalEye, type HalState } from './eye.js';
import { loadConfig, type HalConfig } from './config.js';
import { createRpc, type HalRpc } from './rpc.js';
import { createTalk, type TalkController, type TalkEndReason } from './talk.js';
import { createWakeEngine, type WakeEngine } from './wake.js';
import './hal.css';

/** 素材路徑。換成正式素材時只要換這個檔，並確認鏡頭中心仍在圖片正中央。 */
const EYE_IMAGE = `${import.meta.env.BASE_URL}hal-eye.svg`;

/** 麥克風參數：AEC / NS / AGC 全開，否則 HAL 自己的聲音會被收回去自我打斷 */
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

/** 游標無操作多久後隱藏 */
const CURSOR_IDLE_MS = 2000;

/** error 狀態閃三下的時間，之後自動回 idle（hal.css 的 @keyframes error 對齊） */
const ERROR_HOLD_MS = 1800;

export interface HalAudio {
  ctx: AudioContext;
  stream: MediaStream;
  /** 麥克風的 AnalyserNode，listening 狀態的亮度來源 */
  inputAnalyser: AnalyserNode;
}

/** wake.ts / talk.ts 接管狀態時使用的介面 */
export interface HalRuntime {
  eye: HalEye;
  /** 首次手勢後才有值 */
  audio: HalAudio | null;
  /** 取得（或沿用）麥克風與 AudioContext；需要在使用者手勢中呼叫 */
  ensureAudio(): Promise<HalAudio>;
  /** HAL 說話時把輸出音訊接上來，紅眼就會跟著振幅閃 */
  attachOutput(node: AnalyserNode | null): void;
  setState(state: HalState): void;
}

declare global {
  interface Window {
    hal: HalRuntime;
  }
}

const container = document.getElementById('hal');
if (container === null) throw new Error('[hal] #hal not found');
const root: HTMLElement = container;

const img = root.querySelector<HTMLImageElement>('.hal-img');
if (img) img.src = EYE_IMAGE;

const eye = createEye(root);
eye.setState('offline');

const params = new URLSearchParams(location.search);
/** `?dev=1` 時只跑假驅動，不啟動真實語音管線（兩者不互相干擾） */
const liveMode = params.get('dev') !== '1';
/** `?tap=1` 強制用點擊觸發對話（M3 的「先用點擊觸發把語音鏈路跑通」） */
let tapToTalk = params.get('tap') === '1';

// ── 音訊 ────────────────────────────────────────────────────────────────────
let audio: HalAudio | null = null;
let pending: Promise<HalAudio> | null = null;

async function ensureAudio(): Promise<HalAudio> {
  if (audio) {
    if (audio.ctx.state === 'suspended') await audio.ctx.resume();
    return audio;
  }
  if (pending) return pending;

  pending = (async (): Promise<HalAudio> => {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const inputAnalyser = ctx.createAnalyser();
    inputAnalyser.fftSize = 1024;
    inputAnalyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(inputAnalyser);
    // 注意：不接到 destination，避免把麥克風直接播出去造成回授
    audio = { ctx, stream, inputAnalyser };
    eye.attachAnalyser(inputAnalyser, 'input');
    return audio;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

// ── 對外介面（wake.ts / talk.ts 都走這裡） ──────────────────────────────────
const runtime: HalRuntime = {
  eye,
  get audio() {
    return audio;
  },
  ensureAudio,
  attachOutput: (node) => eye.attachAnalyser(node, 'output'),
  setState: (state) => eye.setState(state),
};

window.hal = runtime;
export default runtime;

// ── 語音管線 ────────────────────────────────────────────────────────────────
let rpc: HalRpc | null = null;
let config: HalConfig | null = null;
let wake: WakeEngine | null = null;
let talk: TalkController | null = null;
let wakeStarting = false;
let errorTimer: number | undefined;

/** 啟動喚醒詞監聽；所有引擎都失敗時降級成「點一下畫面開始對話」 */
async function startWakeListening(): Promise<void> {
  if (config === null || wakeStarting) return;
  wakeStarting = true;
  try {
    const a = await ensureAudio();
    if (wake === null) {
      wake = await createWakeEngine(config.wake);
      wake.onWake(onWakeDetected);
    }
    await wake.start(a.stream);
    tapToTalk = params.get('tap') === '1';
  } catch (err) {
    // 喚醒詞完全不可用：不加任何 UI，改成整頁可點即開始對話（M3 的點擊觸發路徑）
    console.error('[hal] 喚醒詞引擎無法啟動，降級為點擊觸發', err);
    wake = null;
    tapToTalk = true;
  } finally {
    wakeStarting = false;
  }
}

async function stopWakeListening(): Promise<void> {
  if (wake === null) return;
  try {
    await wake.stop();
  } catch (err) {
    console.error('[hal] 停止喚醒詞監聽失敗', err);
  }
}

/** 偵測到「HAL」。waking 必須在**偵測到的當下**立刻切，不等 session 建好。 */
function onWakeDetected(): void {
  const t = talk;
  if (t === null || t.active) return;
  eye.setState('waking', { hold: true });
  void (async () => {
    // 對話期間停掉喚醒詞監聽：HAL 自己的聲音與使用者的話都不該再觸發喚醒
    await stopWakeListening();
    await t.start();
  })();
}

/** 對話結束（靜默逾時 / 誤觸發保險 / 錯誤）→ 回到喚醒詞監聽 */
function onTalkEnded(reason: TalkEndReason): void {
  console.info('[hal] 對話結束：', reason);
  if (errorTimer !== undefined) window.clearTimeout(errorTimer);
  if (reason === 'error') {
    // error 狀態先閃三下（UI 紅線：錯誤只用紅眼表達），再回 idle
    errorTimer = window.setTimeout(() => {
      errorTimer = undefined;
      void resumeIdle();
    }, ERROR_HOLD_MS);
    return;
  }
  void resumeIdle();
}

async function resumeIdle(): Promise<void> {
  if (rpc === null || !rpc.connected) {
    eye.setState('offline');
    return;
  }
  eye.setState('idle');
  await startWakeListening();
}

function onConnectionChange(connected: boolean): void {
  if (connected) {
    if (talk?.active) return; // 對話中，不動狀態
    void resumeIdle();
    return;
  }
  // 斷線／重連中一律 offline（契約 §6）
  console.warn('[hal] 與 BFF 的連線中斷，進入 offline');
  eye.setState('offline');
  void stopWakeListening();
  void talk?.stop('error');
}

/** 首次手勢完成後才啟動：此時麥克風與 AudioContext 都已就緒 */
async function startPipeline(): Promise<void> {
  config = await loadConfig();
  rpc = createRpc();
  talk = createTalk({ rpc, config, hal: runtime, onEnded: onTalkEnded });
  rpc.onConnectionChange(onConnectionChange);

  // 點擊觸發（僅在喚醒詞不可用或 ?tap=1 時生效）。這不是 UI 元件，只是頁面手勢。
  document.addEventListener('pointerdown', () => {
    if (!tapToTalk) return;
    onTapToTalk();
  });
}

function onTapToTalk(): void {
  const t = talk;
  if (t === null || t.active) return;
  if (rpc === null || !rpc.connected) return;
  eye.setState('waking', { hold: true });
  void (async () => {
    await stopWakeListening();
    await t.start();
  })();
}

// ── 首次手勢：整頁可點，點一下完成麥克風與播音授權 ──────────────────────────
let granted = false;

async function onFirstGesture(): Promise<void> {
  if (granted) return;
  try {
    await ensureAudio();
    granted = true;
    removeGestureListeners();
    eye.setState('idle');
    void requestWakeLock();
    if (liveMode) await startPipeline();
    else console.info('[hal] ?dev=1：只跑假驅動，不啟動真實語音管線');
  } catch (err) {
    // 整頁沒有文字，錯誤只用紅眼表達，細節寫 console
    console.error('[hal] 取得麥克風失敗', err);
    eye.setState('error');
  }
}

function addGestureListeners(): void {
  document.addEventListener('pointerdown', onFirstGesture, { passive: true });
  document.addEventListener('keydown', onFirstGesture, { passive: true });
}

function removeGestureListeners(): void {
  document.removeEventListener('pointerdown', onFirstGesture);
  document.removeEventListener('keydown', onFirstGesture);
}

addGestureListeners();

// ── Screen Wake Lock（不支援就靜默略過） ────────────────────────────────────
let wakeLock: WakeLockSentinel | null = null;

async function requestWakeLock(): Promise<void> {
  const api = navigator.wakeLock as Navigator['wakeLock'] | undefined;
  if (!api) return;
  try {
    wakeLock = await api.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    console.warn('[hal] wake lock 取得失敗（可忽略）', err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && granted && !wakeLock) void requestWakeLock();
});

// ── 游標自動隱藏 ────────────────────────────────────────────────────────────
let cursorTimer: number | undefined;

function pokeCursor(): void {
  root.classList.remove('cursor-hidden');
  if (cursorTimer !== undefined) clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => root.classList.add('cursor-hidden'), CURSOR_IDLE_MS);
}

document.addEventListener('pointermove', pokeCursor, { passive: true });
document.addEventListener('pointerdown', pokeCursor, { passive: true });
pokeCursor();

// ── dev 驅動（僅 DEV 或 ?dev=1） ────────────────────────────────────────────
// `?dev=1` 時不啟動真實管線；`npm run dev` 不帶參數時兩者並存（真實 analyser 會覆寫假 sampler）。
if (import.meta.env.DEV || params.get('dev') === '1') {
  void import('./dev-driver.js').then((m) => m.startDevDriver(runtime, params));
}
