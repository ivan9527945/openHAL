/**
 * open_HAL — 執行期設定（BFF 介面契約 §2）
 *
 * 所有設定一律來自 BFF 的 `GET /hal-config.json`。
 *
 * **安全紅線 6**：`PICOVOICE_ACCESS_KEY` 由 BFF 於執行期注入，
 * 前端原始碼與 build 產物都不得出現任何金鑰字面值 —— 本檔只定義型別與「取不到設定時
 * 的無金鑰預設值」，任何情況下都不會生出一把可用的 key。
 */

/** 喚醒詞引擎名稱（契約 §2：未設定 PICOVOICE_ACCESS_KEY 時 BFF 回 "vad"） */
export type WakeEngineName = 'porcupine' | 'vad';

export interface HalWakeConfig {
  engine: WakeEngineName;
  /** PICOVOICE_ACCESS_KEY；engine=vad 時為 null。**只可能來自 BFF** */
  accessKey: string | null;
  /** 自訓練的「HAL」關鍵詞檔（.ppn） */
  keywordUrl: string;
  /** Porcupine 參數模型（.pv） */
  modelUrl: string;
  /** 0–1，越大越靈敏也越容易誤觸發（HAL_WAKE_SENSITIVITY） */
  sensitivity: number;
  /**
   * 喚醒後多久內沒偵測到人聲就靜默關閉 session（HAL_WAKE_ARM_TIMEOUT，預設 5 秒）。
   * 計劃書 §6 細節 2：誤觸發時的空轉付費保險。
   * 契約 §2 目前沒有這個欄位，BFF 補上 `wake.armTimeoutSec` 後會自動生效。
   */
  armTimeoutMs: number;
}

export interface HalConfig {
  /** Talk sessionKey，由伺服器決定（契約 §2） */
  sessionKey: string;
  /** 對話靜默多久後關閉 session 回到喚醒詞監聽（HAL_IDLE_TIMEOUT_SEC） */
  idleTimeoutSec: number;
  wake: HalWakeConfig;
}

/** 取不到 `/hal-config.json` 時的保底值：沒有金鑰，因此只能走 VAD 備案引擎 */
export const FALLBACK_CONFIG: HalConfig = {
  sessionKey: 'main',
  idleTimeoutSec: 45,
  wake: {
    engine: 'vad',
    accessKey: null,
    keywordUrl: 'wake/hal.ppn',
    modelUrl: 'wake/porcupine_params.pv',
    sensitivity: 0.5,
    armTimeoutMs: 5000,
  },
};

const DEFAULT_ARM_TIMEOUT_MS = 5000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 把未知的 JSON 收斂成 HalConfig；任何欄位壞掉都退回保底值，不讓頁面掛掉 */
export function parseConfig(raw: unknown): HalConfig {
  if (!isRecord(raw)) return FALLBACK_CONFIG;
  const w = isRecord(raw['wake']) ? raw['wake'] : {};
  const engineRaw = w['engine'];
  const engine: WakeEngineName = engineRaw === 'porcupine' ? 'porcupine' : 'vad';
  const accessKey = typeof w['accessKey'] === 'string' && w['accessKey'].length > 0 ? w['accessKey'] : null;

  return {
    sessionKey: str(raw['sessionKey'], FALLBACK_CONFIG.sessionKey),
    idleTimeoutSec: num(raw['idleTimeoutSec'], FALLBACK_CONFIG.idleTimeoutSec),
    wake: {
      engine,
      accessKey,
      keywordUrl: str(w['keywordUrl'], FALLBACK_CONFIG.wake.keywordUrl),
      modelUrl: str(w['modelUrl'], FALLBACK_CONFIG.wake.modelUrl),
      sensitivity: Math.min(1, Math.max(0, num(w['sensitivity'], FALLBACK_CONFIG.wake.sensitivity))),
      armTimeoutMs: Math.round(num(w['armTimeoutSec'], DEFAULT_ARM_TIMEOUT_MS / 1000) * 1000),
    },
  };
}

/**
 * 讀 `/hal-config.json`（cookie 認證，網址不帶任何 token）。
 * 失敗時回保底值並記 console —— 整頁不得出現任何文字提示（UI 紅線）。
 */
export async function loadConfig(): Promise<HalConfig> {
  const url = new URL('hal-config.json', document.baseURI);
  try {
    const res = await fetch(url.toString(), { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseConfig(await res.json());
  } catch (err) {
    console.error('[hal/config] 讀取 /hal-config.json 失敗，改用無金鑰保底設定', err);
    return FALLBACK_CONFIG;
  }
}
