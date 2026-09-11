// ─────────────────────────────────────────────────────────────────────────────
// /hal WebSocket：瀏覽器的簡化信封 ↔ Gateway RPC 的轉接（契約 §4）。
//
// 三條不可退讓的規則：
//   1. 預設拒絕：方法必須在 rpc-allowlist 的白名單內，且通過參數硬化。
//   2. Gateway 的原始信封不得外洩：瀏覽器的 id 與 Gateway 的 RPC id 完全分離，
//      回應只重組成契約定義的形狀。
//   3. 錯誤訊息要過濾：只回簡短 code + 泛用訊息，詳細內容寫 server log。
// ─────────────────────────────────────────────────────────────────────────────
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { SlidingWindowLimiter, clientIp, hasValidAccessCookie } from "./auth.js";
import { config } from "./config.js";
import { GatewayError, type GatewayClient } from "./gateway-client.js";
import { isAllowedEvent, isAllowedMethod, isDeniedMethod, sanitizeParams } from "./rpc-allowlist.js";

const KEEPALIVE_MS = 30_000;
const IDLE_KILL_MS = 90_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

/** 回給瀏覽器的錯誤 code（泛用，不帶 Gateway 內部資訊）。 */
type ClientErrorCode =
  | "forbidden"
  | "bad_request"
  | "rate_limited"
  | "gateway_unavailable"
  | "timeout"
  | "upstream_error";

function log(...args: unknown[]): void {
  console.log("[hal-ws]", ...args);
}

interface Conn {
  readonly ws: WebSocket;
  readonly ip: string;
  /** 由 talk.client.toolCall 回應學到的 agentSessionKey，供 chat.abort 驗證用。 */
  readonly agentSessionKeys: Set<string>;
  lastSeen: number;
}

export class HalWsHub {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  /** 每個 IP 同時只允許 1 條連線（契約 §4.4，單人使用）。 */
  readonly #byIp = new Map<string, Conn>();
  readonly #rpcLimiter = new SlidingWindowLimiter(240, 60_000);
  readonly #sessionLimiter: SlidingWindowLimiter;
  readonly #keepalive: NodeJS.Timeout;

  constructor(private readonly gateway: GatewayClient) {
    this.#sessionLimiter = new SlidingWindowLimiter(config.maxSessionsPerMin, 60_000);

    // 事件白名單：只有 chat 與 talk.event 會被轉給瀏覽器（契約 §4.3）。
    for (const event of ["chat", "talk.event"]) {
      this.gateway.on(event, (payload) => {
        if (!isAllowedEvent(event)) return;
        this.#broadcast({ t: "event", event, payload });
      });
    }

    this.#keepalive = setInterval(() => this.#tick(), KEEPALIVE_MS);
    this.#keepalive.unref();
  }

  /** index.ts 的 upgrade handler 會把 /hal 的請求交過來。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      // 契約 §4：以 cookie 認證，不接受任何形式的 query token；
      // 認證失敗直接關閉（1008），不回任何訊息。
      if (!hasValidAccessCookie(req.headers.cookie)) {
        ws.close(1008);
        return;
      }
      this.#accept(ws, req);
    });
  }

  close(): void {
    clearInterval(this.#keepalive);
    for (const conn of this.#byIp.values()) conn.ws.close(1001);
    this.#byIp.clear();
    this.#wss.close();
  }

  #accept(ws: WebSocket, req: IncomingMessage): void {
    const ip = clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress);

    const existing = this.#byIp.get(ip);
    if (existing) {
      log(`同一 IP 已有連線，踢掉舊的：${ip}`);
      existing.ws.close(1000);
    }

    const conn: Conn = { ws, ip, agentSessionKeys: new Set<string>(), lastSeen: Date.now() };
    this.#byIp.set(ip, conn);
    log(`連線建立：${ip}`);

    ws.on("message", (data) => {
      conn.lastSeen = Date.now();
      void this.#onMessage(conn, data.toString());
    });
    ws.on("close", () => {
      if (this.#byIp.get(ip) === conn) this.#byIp.delete(ip);
      log(`連線關閉：${ip}`);
    });
    ws.on("error", (err) => log(`連線錯誤（${ip}）：`, err.message));
  }

  async #onMessage(conn: Conn, raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 垃圾訊息直接忽略，不回話（不給探測者任何回饋）
    }
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
    const frame = msg as Record<string, unknown>;

    if (frame["t"] === "ping") {
      send(conn.ws, { t: "pong" });
      return;
    }
    if (frame["t"] === "pong") return;
    if (frame["t"] !== "rpc") return;

    const id = frame["id"];
    const method = frame["method"];
    if (typeof id !== "number" || !Number.isFinite(id) || typeof method !== "string") return;

    // 1) 全體 RPC rate limit（契約 §4.4：每分鐘 240 則）
    if (!this.#rpcLimiter.hit(conn.ip)) {
      this.#err(conn, id, "rate_limited", `RPC 超過每分鐘上限（${conn.ip}）`);
      return;
    }

    // 2) 第二道保險：命中危險前綴一律擋下並記 log（即使它被誤加進白名單）
    if (isDeniedMethod(method)) {
      log(`⚠ 安全紅線 2：瀏覽器嘗試呼叫被明確排除的方法 "${method}"（${conn.ip}）`);
      this.#err(conn, id, "forbidden", `denied prefix: ${method}`);
      return;
    }

    // 3) 白名單：未列名即拒絕
    if (!isAllowedMethod(method)) {
      log(`拒絕未列名的方法 "${method}"（${conn.ip}）`);
      this.#err(conn, id, "forbidden", `not allowlisted: ${method}`);
      return;
    }

    // 4) 建立 session 的次數上限（誤觸發時的成本煞車）
    if (method === "talk.client.create" && !this.#sessionLimiter.hit(conn.ip)) {
      log(`talk.client.create 超過每分鐘 ${config.maxSessionsPerMin} 次（${conn.ip}）`);
      this.#err(conn, id, "rate_limited", "session 建立超過上限");
      return;
    }

    // 5) 逐方法參數硬化
    const sanitized = sanitizeParams(method, frame["params"], {
      sessionKey: config.sessionKey,
      agentSessionKeys: [...conn.agentSessionKeys],
    });
    if (!sanitized.ok) {
      log(`參數硬化拒絕 "${method}"：${sanitized.reason}（${conn.ip}）`);
      this.#err(conn, id, sanitized.code, sanitized.reason);
      return;
    }

    // 6) 轉發。Gateway 的 RPC id 由 gateway-client 自己產生，與瀏覽器的 id 無關。
    try {
      const result = await this.gateway.call(method, sanitized.params);
      if (method === "talk.client.toolCall") this.#rememberAgentSessionKey(conn, result);
      send(conn.ws, { t: "rpc:ok", id, result });
    } catch (err) {
      const { code, detail } = classifyError(err);
      log(`RPC "${method}" 失敗 → ${code}：${detail}`);
      this.#err(conn, id, code, detail, true);
    }
  }

  /** chat.abort 需要 toolCall 回傳的 agentSessionKey；只記伺服器親眼看過的值。 */
  #rememberAgentSessionKey(conn: Conn, result: unknown): void {
    if (result === null || typeof result !== "object") return;
    const key = (result as Record<string, unknown>)["agentSessionKey"];
    if (typeof key === "string" && key !== "" && key.length <= 128) {
      conn.agentSessionKeys.add(key);
      if (conn.agentSessionKeys.size > 8) {
        conn.agentSessionKeys.delete([...conn.agentSessionKeys][0]!);
      }
    }
  }

  /**
   * 回錯誤給瀏覽器。**message 一律是泛用字串**，詳細內容只寫 server log
   * （alreadyLogged=true 代表呼叫端已經記過）。
   */
  #err(conn: Conn, id: number, code: ClientErrorCode, detail: string, alreadyLogged = false): void {
    if (!alreadyLogged) log(`回錯誤 ${code}：${detail}`);
    send(conn.ws, { t: "rpc:err", id, error: { code, message: GENERIC_MESSAGE[code] } });
  }

  #broadcast(payload: unknown): void {
    for (const conn of this.#byIp.values()) send(conn.ws, payload);
  }

  #tick(): void {
    const now = Date.now();
    for (const conn of this.#byIp.values()) {
      if (now - conn.lastSeen > IDLE_KILL_MS) {
        log(`連線閒置過久，關閉：${conn.ip}`);
        conn.ws.terminate();
        continue;
      }
      send(conn.ws, { t: "ping" });
    }
  }
}

/** 泛用錯誤訊息表：不描述 Gateway 的內部狀態，也不暴露方法名以外的資訊。 */
const GENERIC_MESSAGE: Record<ClientErrorCode, string> = {
  forbidden: "method not allowed",
  bad_request: "invalid params",
  rate_limited: "too many requests",
  gateway_unavailable: "gateway unavailable",
  timeout: "upstream timeout",
  upstream_error: "upstream error",
};

/** 把 Gateway 的錯誤壓成少數幾個泛用 code。原始 code 只進 server log。 */
function classifyError(err: unknown): { code: ClientErrorCode; detail: string } {
  if (err instanceof GatewayError) {
    const raw = err.code.toUpperCase();
    if (raw === "GATEWAY_UNAVAILABLE") return { code: "gateway_unavailable", detail: err.message };
    if (raw === "TIMEOUT") return { code: "timeout", detail: err.message };
    if (raw.includes("FORBIDDEN") || raw.includes("SCOPE") || raw.includes("UNAUTHORIZED")) {
      return { code: "forbidden", detail: `${err.code}: ${err.message}` };
    }
    if (raw.includes("INVALID") || raw.includes("BAD_REQUEST") || raw.includes("VALIDATION")) {
      return { code: "bad_request", detail: `${err.code}: ${err.message}` };
    }
    return { code: "upstream_error", detail: `${err.code}: ${err.message}` };
  }
  return { code: "upstream_error", detail: err instanceof Error ? err.message : String(err) };
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // 送不出去就算了，下一次 keepalive 會把死連線清掉。
  }
}
