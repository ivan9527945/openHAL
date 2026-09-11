// ─────────────────────────────────────────────────────────────────────────────
// 環境變數的唯一讀取點。
//
// 專案紀律（驗收條件之一）：`grep -rn "process.env" src/ | grep -v config.ts`
// 必須是空的。其他模組一律 import 本檔匯出的 `config`。
//
// 必要變數缺少時直接結束行程 —— 帶著半套設定跑起來的 BFF 比跑不起來更危險
// （例如 HAL_ACCESS_KEY 沒設就等於整張臉對全世界公開）。
// ─────────────────────────────────────────────────────────────────────────────
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;

/** 子行程（Gateway）要繼承的環境變數快照。只有 gateway.ts 會用到。 */
export const childEnv: NodeJS.ProcessEnv = { ...process.env };

const missing: string[] = [];
const invalid: string[] = [];

function required(name: string): string {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    missing.push(name);
    return "";
  }
  return raw;
}

function optional(name: string): string | null {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = optional(name);
  if (raw === null) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    invalid.push(`${name}（需為 ${min}–${max} 的數值，實際收到 "${raw}"）`);
    return fallback;
  }
  return v;
}

/** 只有字面值 "1" / "true" 視為開啟，避免 "0"、"false" 被誤判成真。 */
function flag(name: string): boolean {
  const raw = (optional(name) ?? "").toLowerCase();
  return raw === "1" || raw === "true";
}

// ── 路徑推導 ────────────────────────────────────────────────────────────────
// 本檔編譯後位於 <root>/hal/server/dist/config.js，因此 repo 內執行
// （node hal/server/dist/index.js）與 Docker 內執行（/app/hal/server/dist/index.js）
// 的相對關係完全相同，同一組推導即可涵蓋兩種情境。
const distDir = path.dirname(fileURLToPath(import.meta.url));
const halRoot = path.resolve(distDir, "..", ".."); // <root>/hal

const stateDir = optional("OPENCLAW_STATE_DIR") ?? path.join(os.homedir(), ".openclaw");
const workspaceDir = optional("OPENCLAW_WORKSPACE_DIR") ?? path.join(stateDir, "workspace");

const rawConfig = {
  /** BFF 對外監聽的連接埠（Railway 會注入 PORT）。 */
  port: num("PORT", 8080, 1, 65535),

  /** 內部 Gateway 的連接埠。永遠只綁 127.0.0.1（見 M0 §D18）。 */
  gatewayPort: num("OPENCLAW_GATEWAY_PORT", 18789, 1, 65535),

  /** Gateway 共享密鑰。**只有 gateway-client.ts 可以碰**（安全紅線 1）。 */
  gatewayToken: required("OPENCLAW_GATEWAY_TOKEN"),

  /** OpenClaw 持久化狀態目錄；設定檔會落在 <stateDir>/openclaw.json（M0 §C15）。 */
  stateDir,
  /** OpenClaw workspace（人格檔與記憶）。 */
  workspaceDir,

  /** 開啟 HAL 臉的通行碼。 */
  halAccessKey: required("HAL_ACCESS_KEY"),

  /** /admin Control UI 的 Basic Auth（D5 保留此介面，所以帳密必設）。 */
  adminUser: required("ADMIN_USER"),
  adminPass: required("ADMIN_PASS"),

  /** 喚醒詞引擎金鑰。唯一允許進瀏覽器的 key，且只經 /hal-config.json（安全紅線 6）。 */
  picovoiceAccessKey: optional("PICOVOICE_ACCESS_KEY"),

  wakeSensitivity: num("HAL_WAKE_SENSITIVITY", 0.5, 0, 1),
  idleTimeoutSec: num("HAL_IDLE_TIMEOUT_SEC", 45, 5, 3600),
  maxSessionsPerMin: num("HAL_MAX_SESSIONS_PER_MIN", 6, 1, 120),

  /** Talk 的 sessionKey，由伺服器決定；瀏覽器不得指定（契約 §4.2）。 */
  sessionKey: optional("HAL_SESSION_KEY") ?? "main",

  /**
   * 本機 http 開發用的逃生門：關掉 cookie 的 Secure 屬性。
   * 預設必須是 Secure，開啟時會在啟動 log 印警告。
   */
  insecureCookie: flag("HAL_INSECURE_COOKIE"),

  /** 只跑 BFF、不 spawn Gateway（自我驗證與前端開發用）。 */
  skipGateway: flag("HAL_SKIP_GATEWAY"),

  /** 靜態檔與種子檔的位置。 */
  faceDistDir: path.join(halRoot, "face", "dist"),
  configSeedDir: path.join(halRoot, "config"),
  workspaceSeedDir: path.join(halRoot, "workspace-seed"),
} as const;

if (missing.length > 0 || invalid.length > 0) {
  const lines = ["[config] 啟動中止：環境變數設定不完整。"];
  if (missing.length > 0) {
    lines.push(`  缺少必要變數：${missing.join("、")}`);
    lines.push("  這四個變數沒有預設值，也不應該有 —— 請參考 repo 根目錄的 .env.example。");
  }
  if (invalid.length > 0) lines.push(`  值不合法：${invalid.join("、")}`);
  console.error(lines.join("\n"));
  process.exit(1);
}

export type HalConfig = typeof rawConfig;

/** 凍結，避免任何模組在執行期偷改設定（尤其是 sessionKey 與金鑰）。 */
export const config: HalConfig = Object.freeze(rawConfig);

/** 給 log 用的安全版設定：任何金鑰只回報「有沒有設」，絕不回報內容。 */
export function redacted(): Record<string, unknown> {
  return {
    port: config.port,
    gatewayPort: config.gatewayPort,
    gatewayToken: "<set>",
    stateDir: config.stateDir,
    workspaceDir: config.workspaceDir,
    halAccessKey: "<set>",
    adminUser: "<set>",
    adminPass: "<set>",
    picovoiceAccessKey: config.picovoiceAccessKey ? "<set>" : "<unset>",
    wakeSensitivity: config.wakeSensitivity,
    idleTimeoutSec: config.idleTimeoutSec,
    maxSessionsPerMin: config.maxSessionsPerMin,
    sessionKey: config.sessionKey,
    insecureCookie: config.insecureCookie,
    skipGateway: config.skipGateway,
    faceDistDir: config.faceDistDir,
  };
}
