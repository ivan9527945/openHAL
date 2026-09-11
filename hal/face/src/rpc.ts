/**
 * open_HAL — 與 BFF 的 WebSocket 連線（BFF 介面契約 §4）
 *
 * 這是瀏覽器唯一的對外控制通道。瀏覽器**永遠不直接連 Gateway**、不持有 Gateway token、
 * 也不持有任何 API key（安全紅線 1）；認證一律靠 HttpOnly cookie，
 * **網址不得帶任何形式的 token**（契約 §4：不接受 query token）。
 *
 * 信封（契約 §4.1）：
 *   → { t:"rpc", id, method, params }
 *   ← { t:"rpc:ok", id, result } / { t:"rpc:err", id, error:{code,message} }
 *   ← { t:"event", event, payload }
 *   ↔ { t:"ping" } / { t:"pong" }
 */

/** RPC 逾時預設值；`agent.wait` 這種長工作要自己帶 timeoutMs */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 保活心跳間隔（契約 §4.1 寫 30 秒，這裡提早一點送） */
const PING_INTERVAL_MS = 25_000;
/** 送出 ping 後多久沒收到任何訊息就視為線路死掉 */
const PONG_TIMEOUT_MS = 10_000;
/** 指數退避的上下限 */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;

export interface RpcErrorShape {
  code: string;
  message: string;
}

/** BFF 回 `rpc:err` 時丟出；`code` 直接沿用契約定義（forbidden / rate_limited / …） */
export class HalRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HalRpcError';
    this.code = code;
  }
}

export type EventHandler = (payload: unknown) => void;
export type ConnectionHandler = (connected: boolean) => void;

export interface CallOptions {
  /** 覆寫逾時（毫秒）。`agent.wait` 建議 125_000，比 Gateway 的 120 秒多一點餘裕 */
  timeoutMs?: number;
}

export interface HalRpc {
  readonly connected: boolean;
  /** 送一筆 RPC，回傳 result；失敗丟 HalRpcError（或逾時 Error） */
  call<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T>;
  /** 訂閱 BFF 轉發的 Gateway 事件（契約 §4.3 只有 `chat` 與 `talk.event`）；回傳解除訂閱函式 */
  on(event: string, handler: EventHandler): () => void;
  /** 連線狀態變化（true=已連上，false=斷線／重連中） */
  onConnectionChange(handler: ConnectionHandler): () => void;
  /** 主動關閉並停止重連 */
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 同 origin 推導：https → wss、http → ws；路徑用 document.baseURI 解析以支援子路徑掛載 */
function resolveSocketUrl(path: string): string {
  const url = new URL(path, document.baseURI);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = ''; // 再次確認：網址不得帶任何 token（契約 §4）
  url.hash = '';
  return url.toString();
}

export function createRpc(path = 'hal'): HalRpc {
  const url = resolveSocketUrl(path);

  let ws: WebSocket | null = null;
  let closed = false;
  let nextId = 1;
  let attempt = 0;
  let reconnectTimer: number | undefined;
  let pingTimer: number | undefined;
  let pongTimer: number | undefined;

  const pending = new Map<number, Pending>();
  const eventHandlers = new Map<string, Set<EventHandler>>();
  const connectionHandlers = new Set<ConnectionHandler>();
  let lastNotified: boolean | null = null;

  function notifyConnection(state: boolean): void {
    if (lastNotified === state) return;
    lastNotified = state;
    for (const h of connectionHandlers) {
      try {
        h(state);
      } catch (err) {
        console.error('[hal/rpc] connection handler 例外', err);
      }
    }
  }

  function clearTimer(id: number | undefined): void {
    if (id !== undefined) window.clearTimeout(id);
  }

  function stopHeartbeat(): void {
    clearTimer(pingTimer);
    clearTimer(pongTimer);
    pingTimer = undefined;
    pongTimer = undefined;
  }

  function scheduleHeartbeat(): void {
    stopHeartbeat();
    pingTimer = window.setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      send({ t: 'ping' });
      pongTimer = window.setTimeout(() => {
        console.warn('[hal/rpc] 心跳逾時，強制重連');
        ws?.close();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  function send(msg: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('[hal/rpc] 尚未連線');
    ws.send(JSON.stringify(msg));
  }

  function failAllPending(reason: string): void {
    for (const [, p] of pending) {
      window.clearTimeout(p.timer);
      p.reject(new HalRpcError('disconnected', reason));
    }
    pending.clear();
  }

  function handleMessage(raw: unknown): void {
    if (!isRecord(raw)) return;
    const t = raw['t'];

    // 任何訊息都算「線路還活著」
    clearTimer(pongTimer);
    pongTimer = undefined;

    if (t === 'ping') {
      // BFF 主動探活，直接回 pong
      try {
        send({ t: 'pong' });
      } catch {
        /* 連線正在關，忽略 */
      }
      return;
    }
    if (t === 'pong') return;

    if (t === 'event') {
      const name = typeof raw['event'] === 'string' ? raw['event'] : '';
      const handlers = eventHandlers.get(name);
      if (!handlers) return;
      for (const h of handlers) {
        try {
          h(raw['payload']);
        } catch (err) {
          console.error(`[hal/rpc] event "${name}" handler 例外`, err);
        }
      }
      return;
    }

    if (t === 'rpc:ok' || t === 'rpc:err') {
      const id = raw['id'];
      if (typeof id !== 'number') return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      window.clearTimeout(p.timer);
      if (t === 'rpc:ok') {
        p.resolve(raw['result']);
      } else {
        const e = isRecord(raw['error']) ? raw['error'] : {};
        const code = typeof e['code'] === 'string' ? e['code'] : 'error';
        const message = typeof e['message'] === 'string' ? e['message'] : 'unknown error';
        p.reject(new HalRpcError(code, message));
      }
    }
  }

  function connect(): void {
    if (closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error('[hal/rpc] 建立 WebSocket 失敗', err);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      attempt = 0;
      console.info('[hal/rpc] 已連上 BFF');
      notifyConnection(true);
      scheduleHeartbeat();
    });

    socket.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch (err) {
        console.error('[hal/rpc] 收到非 JSON 訊息', err);
        return;
      }
      handleMessage(parsed);
      scheduleHeartbeat();
    });

    socket.addEventListener('error', () => {
      // 細節一律進 console，畫面上不得出現任何提示（UI 紅線）
      console.error('[hal/rpc] WebSocket 錯誤');
    });

    socket.addEventListener('close', (ev: CloseEvent) => {
      stopHeartbeat();
      if (ws === socket) ws = null;
      failAllPending(`connection closed (${ev.code})`);
      notifyConnection(false);
      // 1008 = 認證失敗（契約 §4）。仍然重連：cookie 可能是稍後才補上的。
      if (ev.code === 1008) console.error('[hal/rpc] 連線被拒（認證失敗）');
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== undefined) return;
    const base = Math.min(BACKOFF_MIN_MS * 2 ** attempt, BACKOFF_MAX_MS);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4)); // 加抖動，避免同步重試
    attempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  connect();

  return {
    get connected(): boolean {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },

    call<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new HalRpcError('disconnected', 'BFF 尚未連線'));
          return;
        }
        const id = nextId++;
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new HalRpcError('timeout', `${method} 逾時（${timeoutMs}ms）`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
          timer,
        });
        try {
          send(params === undefined ? { t: 'rpc', id, method } : { t: 'rpc', id, method, params });
        } catch (err) {
          pending.delete(id);
          window.clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    on(event: string, handler: EventHandler): () => void {
      let set = eventHandlers.get(event);
      if (!set) {
        set = new Set<EventHandler>();
        eventHandlers.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },

    onConnectionChange(handler: ConnectionHandler): () => void {
      connectionHandlers.add(handler);
      // 立刻補一次現況，呼叫端不必自己查
      try {
        handler(ws !== null && ws.readyState === WebSocket.OPEN);
      } catch (err) {
        console.error('[hal/rpc] connection handler 例外', err);
      }
      return () => connectionHandlers.delete(handler);
    },

    close(): void {
      closed = true;
      clearTimer(reconnectTimer);
      reconnectTimer = undefined;
      stopHeartbeat();
      failAllPending('client closed');
      ws?.close();
      ws = null;
    },
  };
}
