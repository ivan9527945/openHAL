/**
 * open_HAL — 紅眼狀態機（計劃書 §7.2）
 *
 * 對外只做兩件事：
 *   1. 把狀態寫進 data-state（給 CSS 的 [data-state="..."] 選擇器用，
 *      同時也是 S5 eye-check skill 截圖驗收的依據，請勿改名）。
 *   2. listening / speaking 時用 rAF 讀音訊 RMS，寫進 --level / --scale。
 *
 * idle / thinking / offline / waking / error 一律交給 CSS animation，
 * rAF 在這些狀態會完全停掉，不空轉。
 */

export type HalState =
  | 'offline'
  | 'idle'
  | 'waking'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export type AudioRole = 'input' | 'output';

/** 回傳 0–1 的即時振幅。dev-driver 用來在沒有麥克風時假造訊號。 */
export type AmplitudeSampler = () => number;

export interface SetStateOptions {
  /** waking 播完 0.3 秒後預設會自動回落 idle；hold 為 true 時停住不回落（截圖用）。 */
  hold?: boolean;
}

export interface HalEye {
  setState(state: HalState, opts?: SetStateOptions): void;
  getState(): HalState;
  /** listening / speaking 時接上音訊來源，內部用 AnalyserNode + rAF 把 RMS 寫進 CSS 變數 */
  attachAnalyser(node: AnalyserNode | null, role: AudioRole): void;
  detachAnalyser(role: AudioRole): void;
  /** 直接餵振幅取樣函式（dev-driver 假資料用；正式流程請用 attachAnalyser） */
  attachSampler(sampler: AmplitudeSampler | null, role: AudioRole): void;
  destroy(): void;
}

/** waking 一次性動畫長度，與 hal.css 的 @keyframes wake 對齊 */
const WAKING_MS = 300;
/** 亮度平滑：上升快、下降慢，避免抖動又保留跟隨感 */
const ATTACK = 0.5;
const RELEASE = 0.11;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createEye(root: HTMLElement): HalEye {
  const found = root.querySelector<HTMLElement>('.glow');
  if (found === null) throw new Error('[hal] .glow element not found');
  const glow: HTMLElement = found;

  let state: HalState = 'offline';
  let raf = 0;
  let env = 0; // 平滑後的振幅包絡
  let wakingTimer: number | undefined;

  const samplers: Record<AudioRole, AmplitudeSampler | null> = { input: null, output: null };

  /** 以 AnalyserNode 算 RMS，再做感知曲線壓縮到 0–1 */
  function analyserSampler(node: AnalyserNode): AmplitudeSampler {
    const buf = new Float32Array(node.fftSize);
    return () => {
      node.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      return clamp01(Math.sqrt(rms) * 2.2);
    };
  }

  function setVars(level: number, scale: number): void {
    // ?freeze=1 時由 dev-driver 鎖住變數，rAF 不得覆寫
    if (root.dataset['freeze'] === '1') return;
    root.style.setProperty('--level', level.toFixed(3));
    root.style.setProperty('--scale', scale.toFixed(3));
  }

  function needsRaf(s: HalState): boolean {
    return s === 'listening' || s === 'speaking';
  }

  function tick(): void {
    const role: AudioRole = state === 'speaking' ? 'output' : 'input';
    const sampler = samplers[role];
    const target = sampler ? clamp01(sampler()) : 0;
    env += (target - env) * (target > env ? ATTACK : RELEASE);

    if (state === 'speaking') {
      // 亮度即時跟隨輸出振幅：暗底 + 大動態
      setVars(0.26 + 0.72 * env, 0.94 + 0.3 * env);
    } else {
      // listening：穩定偏亮，只做微幅閃動
      setVars(0.55 + 0.28 * env, 1 + 0.07 * env);
    }
    raf = requestAnimationFrame(tick);
  }

  function startRaf(): void {
    if (raf) return;
    raf = requestAnimationFrame(tick);
  }

  function stopRaf(): void {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
    env = 0;
  }

  /** 同一個狀態重設時，強制重播一次性動畫（waking / error） */
  function restartAnimation(): void {
    glow.style.animation = 'none';
    void glow.offsetWidth; // 觸發 reflow
    glow.style.animation = '';
  }

  function apply(next: HalState): void {
    root.dataset['state'] = next;
    // documentElement 也標一份，方便截圖工具與之後的樣式擴充
    document.documentElement.dataset['state'] = next;
  }

  function setState(next: HalState, opts?: SetStateOptions): void {
    if (wakingTimer !== undefined) {
      clearTimeout(wakingTimer);
      wakingTimer = undefined;
    }

    const same = next === state;
    state = next;
    apply(next);

    if (same && (next === 'waking' || next === 'error')) restartAnimation();

    if (needsRaf(next)) {
      startRaf();
    } else {
      stopRaf();
      // 交還給 CSS animation：清掉行內變數，避免殘留的 --level 蓋掉動畫的起始值
      // （?freeze=1 時變數由 dev-driver 鎖定，這裡不能動）
      if (root.dataset['freeze'] !== '1') {
        root.style.removeProperty('--level');
        root.style.removeProperty('--scale');
      }
    }

    if (next === 'waking' && !opts?.hold) {
      // 呼叫端通常會在 session 建好後切到 listening；沒被切走就回落 idle
      wakingTimer = window.setTimeout(() => {
        wakingTimer = undefined;
        if (state === 'waking') setState('idle');
      }, WAKING_MS + 20);
    }
  }

  function attachSampler(sampler: AmplitudeSampler | null, role: AudioRole): void {
    samplers[role] = sampler;
  }

  function attachAnalyser(node: AnalyserNode | null, role: AudioRole): void {
    samplers[role] = node ? analyserSampler(node) : null;
  }

  apply(state);

  return {
    setState,
    getState: () => state,
    attachAnalyser,
    detachAnalyser: (role) => attachAnalyser(null, role),
    attachSampler,
    destroy: () => {
      stopRaf();
      if (wakingTimer !== undefined) clearTimeout(wakingTimer);
    },
  };
}
