/**
 * open_HAL — 假資料驅動（M2 驗收 / S5 eye-check 截圖用）
 *
 * 只在 import.meta.env.DEV 或網址帶 ?dev=1 時被動態載入，正式 build 不帶參數
 * 時整個模組不會被下載、也不會有任何副作用。
 *
 * 支援：
 *   鍵盤 1–7            → 依序切換 offline / idle / waking / listening / thinking / speaking / error
 *   ?state=thinking     → 直接鎖定某個狀態（waking / error 會停住不自動回落）
 *   ?freeze=1           → 暫停動畫並把 --level / --scale 鎖在固定值，截圖可重現
 *   假音訊振幅（正弦波 + 噪音）→ 無麥克風也看得到 listening / speaking 的跟隨效果
 */

import type { HalState } from './eye.js';
import type { HalRuntime } from './main.js';

const ORDER: readonly HalState[] = [
  'offline',
  'idle',
  'waking',
  'listening',
  'thinking',
  'speaking',
  'error',
];

const ALL = new Set<string>(ORDER);

/** 截圖模式下鎖定的亮度／大小，與 listening 的靜態外觀接近 */
const FROZEN_LEVEL = 0.72;
const FROZEN_SCALE = 1.05;

/** 假振幅：兩顆不同頻率的正弦波疊一點噪音，聽起來像有人在講話 */
function fakeSampler(seedHz: number): () => number {
  const t0 = performance.now();
  return () => {
    const t = (performance.now() - t0) / 1000;
    const carrier = 0.5 + 0.5 * Math.sin(2 * Math.PI * seedHz * t);
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * (seedHz * 3.7) * t + 1.1);
    const noise = Math.random() * 0.12;
    const v = carrier * (0.35 + 0.65 * syllable) + noise;
    return Math.max(0, Math.min(1, v));
  };
}

export function startDevDriver(hal: HalRuntime, params: URLSearchParams): void {
  const frozen = params.get('freeze') === '1';
  const locked = params.get('state');
  const root = document.getElementById('hal');

  // 假音訊：沒有真麥克風時也能驅動 listening / speaking
  hal.eye.attachSampler(fakeSampler(1.9), 'input');
  hal.eye.attachSampler(fakeSampler(2.6), 'output');

  if (frozen && root) {
    root.dataset['freeze'] = '1';
    root.style.setProperty('--level', String(FROZEN_LEVEL));
    root.style.setProperty('--scale', String(FROZEN_SCALE));
  }

  if (locked && ALL.has(locked)) {
    // hold：waking 不自動回落 idle，截圖才截得到
    hal.eye.setState(locked as HalState, { hold: true });
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = Number(e.key) - 1;
    const next = ORDER[idx];
    if (!next) return;
    e.preventDefault();
    hal.eye.setState(next, { hold: true });
    console.info('[hal/dev] state =', next);
  });

  console.info('[hal/dev] 1–7 切換狀態；?state=<name> 鎖定；?freeze=1 凍結動畫');
}
