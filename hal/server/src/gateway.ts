// ─────────────────────────────────────────────────────────────────────────────
// OpenClaw Gateway 子行程：首次啟動的種子寫入、spawn、監控、重啟、優雅關閉。
//
// 依據：
//   M0 §C15 —— 設定檔名必須是 openclaw.json（不是 .json5），且不可是 symlink。
//   M0 §D18 —— 容器內的預設 bind 是 auto→0.0.0.0，**必須明確帶 --bind loopback**。
//   M0 §E20 —— CLI 是 `openclaw gateway`，可用 flag：--port / --bind / --allow-unconfigured。
//               （--headless、--non-interactive、--no-update-check 都不存在，不要用）
//   M0 §E23 —— 設定檔缺 gateway.mode=local 時 Gateway 會「拒絕啟動」，
//               因此種子要含該鍵，並一律帶 --allow-unconfigured 當保險。
//   M0 §E22 —— readiness 用 /startupz，不要用 /v1/chat/completions。
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { childEnv, config } from "./config.js";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STOP_GRACE_MS = 5_000;

function log(...args: unknown[]): void {
  console.log("[gateway]", ...args);
}

export interface GatewayStatus {
  /** 子行程存在且尚未結束。 */
  readonly running: boolean;
  /** 累計重啟次數。 */
  readonly restarts: number;
  /** 連續失敗次數（成功跑滿一段時間後歸零）。 */
  readonly consecutiveFailures: number;
}

export class GatewaySupervisor {
  #child: ChildProcess | null = null;
  #stopped = false;
  #restarts = 0;
  #failures = 0;
  #retryTimer: NodeJS.Timeout | null = null;
  #startedAt = 0;

  status(): GatewayStatus {
    return {
      running: this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null,
      restarts: this.#restarts,
      consecutiveFailures: this.#failures,
    };
  }

  /** 寫入種子（若需要）後啟動子行程。 */
  start(): void {
    this.#stopped = false;
    try {
      seedConfigIfMissing();
      seedWorkspaceIfEmpty();
    } catch (err) {
      log("寫入種子失敗（仍會嘗試啟動 Gateway）：", err);
    }
    this.#spawn();
  }

  /** 先關子行程再讓呼叫端退出。SIGTERM 後最多等 STOP_GRACE_MS 才 SIGKILL。 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    log("送出 SIGTERM，等待子行程結束…");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log("子行程未在時限內結束，改送 SIGKILL");
        child.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  #spawn(): void {
    if (this.#stopped) return;
    // M0 §E20 的查證結果；--bind loopback 是 §D18 那個實際存在的漏洞的修補。
    const args = [
      "gateway",
      "--port",
      String(config.gatewayPort),
      "--bind",
      "loopback",
      // §E23 路 B：只跳過 gateway.mode=local 的啟動守衛，不會建立或修復設定。
      "--allow-unconfigured",
    ];
    log(`啟動子行程：openclaw ${args.join(" ")}`);
    this.#startedAt = Date.now();

    const child = spawn("openclaw", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    this.#child = child;

    pipeLines(child.stdout, "out");
    pipeLines(child.stderr, "err");

    child.on("error", (err) => {
      log("無法啟動子行程：", err.message);
    });

    // 用 close 而不是 exit：spawn 失敗（找不到 openclaw 執行檔）時 Node 只發
    // error 與 close，不發 exit；掛在 exit 上會讓那種情況永遠不重試。
    child.on("close", (code, signal) => {
      this.#child = null;
      if (this.#stopped) {
        log(`子行程已結束（code ${String(code)} signal ${String(signal)}）`);
        return;
      }
      // 跑超過 60 秒才掛掉的視為「曾經健康」，連續失敗計數歸零。
      if (Date.now() - this.#startedAt > 60_000) this.#failures = 0;
      this.#failures += 1;
      this.#restarts += 1;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.#failures - 1));
      log(
        `子行程結束（code ${String(code)} signal ${String(signal)}），` +
          `連續失敗 ${this.#failures} 次，${delay}ms 後重啟`,
      );
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        this.#spawn();
      }, delay);
    });
  }
}

/** 把子行程的輸出逐行轉發到 BFF 的 log，加上 [gateway] 前綴。 */
function pipeLines(stream: NodeJS.ReadableStream | null, tag: "out" | "err"): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line !== "") console.log(`[gateway:${tag}] ${line}`);
      idx = buffer.indexOf("\n");
    }
    // 避免對端不換行時無限吃記憶體。
    if (buffer.length > 64 * 1024) {
      console.log(`[gateway:${tag}] ${buffer}`);
      buffer = "";
    }
  });
}

/**
 * 首次啟動：把 hal/config 的設定種子寫到 $OPENCLAW_STATE_DIR/openclaw.json。
 * 已存在就完全不動（使用者可能手動調過）。
 */
export function seedConfigIfMissing(): void {
  // M0 §C15：檔名必須是 openclaw.json（內容仍以 JSON5 解析，可保留註解）。
  const target = path.join(config.stateDir, "openclaw.json");

  if (fs.existsSync(target)) {
    // symlink 會被 OpenClaw 的原子性 rename 覆寫掉，屬於設定遺失風險。
    if (fs.lstatSync(target).isSymbolicLink()) {
      log(`⚠ ${target} 是 symlink —— M0 §C15 明確要求設定檔必須是一般檔案，請手動修正。`);
    }
    return;
  }

  const source = ["openclaw.json", "openclaw.json5"]
    .map((name) => path.join(config.configSeedDir, name))
    .find((p) => fs.existsSync(p));
  if (source === undefined) {
    log(`⚠ 找不到設定種子（${config.configSeedDir}），Gateway 將以未設定狀態啟動。`);
    return;
  }

  const text = fs.readFileSync(source, "utf8");
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(target, text, { encoding: "utf8", mode: 0o600 });
  log(`已寫入設定種子：${source} → ${target}`);

  // M0 §E23：設定檔存在但缺 gateway.mode 會被當成「損壞的設定」而拒絕啟動。
  // 種子由 hal/config 那一層維護，這裡只做檢查與提醒（我們另外帶 --allow-unconfigured 當保險）。
  if (!/\bmode\s*:\s*["']local["']/.test(text)) {
    log(
      "⚠ 設定種子裡沒看到 gateway.mode: \"local\"（M0 §E23）。" +
        "目前靠 --allow-unconfigured 繞過啟動守衛，建議在 hal/config 的種子補上該鍵。",
    );
  }
}

/** 首次啟動：workspace 是空的就把人格種子複製過去。 */
export function seedWorkspaceIfEmpty(): void {
  const target = config.workspaceDir;
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) return;
  if (!fs.existsSync(config.workspaceSeedDir)) {
    log(`⚠ 找不到人格種子目錄（${config.workspaceSeedDir}），略過。`);
    return;
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(config.workspaceSeedDir, target, { recursive: true, force: false, errorOnExist: false });
  log(`已寫入人格種子：${config.workspaceSeedDir} → ${target}`);
}

/**
 * Gateway 是否已完成啟動。
 * M0 §E22：/startupz 回 200 = started，503 = starting / draining。
 * open_HAL 沒有任何 channel，/readyz 與 /startupz 等價，但 /startupz 語意更穩。
 */
export async function probeStarted(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.gatewayPort}/startupz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
