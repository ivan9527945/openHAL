// ─────────────────────────────────────────────────────────────────────────────
// BFF 自己與 OpenClaw Gateway 的 WebSocket 連線。
//
// **這是整個 repo 唯一持有 OPENCLAW_GATEWAY_TOKEN 的地方**（安全紅線 1）。
// token 只出現在 connect 握手的 params.auth.token，永遠不會離開本檔。
//
// 依據：M0 §A1（根路徑、無路徑後綴）、§A2（connect 握手帶共享密鑰）、
//       §A3（req/res/event 三種 frame、回應可能亂序、錯誤要先讀 details.code）。
// ─────────────────────────────────────────────────────────────────────────────
import { WebSocket } from "ws";

import { config } from "./config.js";

/** 轉成瀏覽器看得到的錯誤時，只會用到 code；message 只進 server log。 */
export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

type EventHandler = (payload: unknown) => void;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const PROTOCOL = 4;
const CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function log(...args: unknown[]): void {
  console.log("[gateway-client]", ...args);
}

export class GatewayClient {
  #ws: WebSocket | null = null;
  #ready = false;
  #stopped = false;
  #attempt = 0;
  #seq = 0;
  #retryTimer: NodeJS.Timeout | null = null;
  readonly #pending = new Map<string, Pending>();
  readonly #handlers = new Map<string, Set<EventHandler>>();

  /** 握手完成且連線仍在 → true。 */
  get ready(): boolean {
    return this.#ready;
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#failAllPending(new GatewayError("gateway_unavailable", "BFF 正在關閉"));
    this.#ws?.close();
    this.#ws = null;
    this.#ready = false;
  }

  /** 訂閱 Gateway 推播事件（例如 chat、talk.event）。 */
  on(event: string, handler: EventHandler): void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler);
  }

  /**
   * 發一個 RPC。斷線／重連期間一律立即回 gateway_unavailable，
   * 不排隊、不緩衝 —— 語音是即時互動，遲到的回應沒有意義。
   */
  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const ws = this.#ws;
    if (!this.#ready || !ws || ws.readyState !== WebSocket.OPEN) {
      throw new GatewayError("gateway_unavailable", "Gateway 連線尚未就緒");
    }
    return this.#send(ws, method, params, timeoutMs);
  }

  #send(ws: WebSocket, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = `b${++this.#seq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new GatewayError("timeout", `RPC ${method} 逾時（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new GatewayError("gateway_unavailable", `送出失敗：${String(err)}`));
      }
    });
  }

  #open(): void {
    if (this.#stopped) return;
    // M0 §A1：WS 沒有路徑後綴，直接連根 URL；且永遠只連 loopback。
    const url = `ws://127.0.0.1:${config.gatewayPort}`;
    const ws = new WebSocket(url, { maxPayload: 32 * 1024 * 1024 });
    this.#ws = ws;

    ws.on("open", () => {
      void this.#handshake(ws);
    });

    ws.on("message", (data) => {
      this.#onMessage(data.toString());
    });

    ws.on("error", (err) => {
      log("連線錯誤：", err.message);
    });

    ws.on("close", (code) => {
      const wasReady = this.#ready;
      this.#ready = false;
      if (this.#ws === ws) this.#ws = null;
      this.#failAllPending(new GatewayError("gateway_unavailable", `連線關閉（code ${code}）`));
      if (wasReady) log(`連線中斷（code ${code}），準備重連`);
      this.#scheduleRetry();
    });
  }

  async #handshake(ws: WebSocket): Promise<void> {
    try {
      // M0 §A2：認證不是 header 也不是 query string，而是 connect 的 params.auth.token。
      const payload = (await this.#send(
        ws,
        "connect",
        {
          minProtocol: PROTOCOL,
          maxProtocol: PROTOCOL,
          // client.id 與 client.mode 都是**列舉**，不能自訂字串。
          // 合法 id 見 GATEWAY_CLIENT_IDS，合法 mode 見 GATEWAY_CLIENT_MODES
          // （openclaw 套件的 dist/client-info-*.mjs）。
          // 我們是「持有 token、代瀏覽器轉發的後端客戶端」，所以是 gateway-client + backend。
          // 注意：官方 docs 的 connect 範例（gateway/protocol/handshake.md）寫的是
          // mode: "operator"，那是 role 的值、不在 mode 列舉裡，照抄會被拒絕 ——
          // 實機驗證過，錯誤訊息是 "at /client/mode: must be equal to one of the allowed values"。
          client: { id: "gateway-client", version: "0.1.0", platform: process.platform, mode: "backend" },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          caps: [],
          commands: [],
          permissions: {},
          auth: { token: config.gatewayToken },
          locale: "zh-TW",
          userAgent: "open-hal-bff/0.1.0",
        },
        CONNECT_TIMEOUT_MS,
      )) as { protocol?: number; auth?: { scopes?: string[] } } | null;

      this.#ready = true;
      this.#attempt = 0;
      log(`握手完成（protocol ${payload?.protocol ?? "?"}、scopes ${(payload?.auth?.scopes ?? []).join(",")}）`);
    } catch (err) {
      // 握手失敗最常見的原因是 token 不對；絕不把 token 內容印出來。
      log("握手失敗：", err instanceof Error ? err.message : String(err));
      ws.close();
    }
  }

  #onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      log("收到無法解析的訊息，已丟棄");
      return;
    }
    if (msg === null || typeof msg !== "object") return;
    const frame = msg as Record<string, unknown>;

    if (frame["type"] === "res") {
      const id = typeof frame["id"] === "string" ? frame["id"] : "";
      const pending = this.#pending.get(id);
      if (!pending) return; // 逾時後才到的回應，直接丟棄
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (frame["ok"] === true) {
        pending.resolve(frame["payload"] ?? null);
      } else {
        const err = (frame["error"] ?? {}) as Record<string, unknown>;
        const details = err["details"] as Record<string, unknown> | undefined;
        // M0 §A3：先讀 details.code，message 是人類可讀且可能變動。
        const code = String(details?.["code"] ?? err["code"] ?? "UNKNOWN");
        pending.reject(new GatewayError(code, String(err["message"] ?? "gateway error"), details));
      }
      return;
    }

    if (frame["type"] === "event") {
      const event = typeof frame["event"] === "string" ? frame["event"] : "";
      const handlers = this.#handlers.get(event);
      if (!handlers) return;
      for (const h of handlers) {
        try {
          h(frame["payload"]);
        } catch (err) {
          log(`事件 ${event} 的 handler 丟出例外：`, err);
        }
      }
    }
  }

  #failAllPending(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  /** 指數退避：1s → 2s → 4s … 上限 30s。 */
  #scheduleRetry(): void {
    if (this.#stopped || this.#retryTimer) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 16);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#open();
    }, delay);
  }
}
