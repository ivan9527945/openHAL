// ─────────────────────────────────────────────────────────────────────────────
// 本檔是 CLAUDE.md §5 安全紅線第 2 條的實作：
//   「BFF 的 RPC 轉發一律預設拒絕。只放行白名單內的 Talk 方法；
//     絕不放行 config / exec / 檔案類方法。必須是『未列名即拒絕』。」
//
// **修改前請重讀 CLAUDE.md §5，以及 docs/M0_技術查證_v0.1.md §B9。**
// 這裡的每一個項目都對應 M0 §B9 查證過的方法清單與 scope 表，不是憑印象寫的。
//
// 本檔只匯出純函數與常數（沒有 I/O、沒有狀態），方便 hal-audit skill 做靜態檢查。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 瀏覽器可透過 BFF 轉發到 Gateway 的 RPC 方法（M0 §B9：5 必需 + 4 強烈建議）。
 * 其餘一律拒絕。
 */
export const RPC_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // --- 必需 ---
  "talk.client.create", // 建立／重建 realtime session
  "talk.client.toolCall", // 把模型的 openclaw_agent_consult 轉給 Claude Agent
  "talk.client.close", // 結束 session（TTL 到期前重建時必做）
  "talk.client.transcript", // 寫回定稿逐字稿，否則 HAL 的記憶會缺語音內容
  "agent.wait", // 等待 consult 回合結束
  // --- 強烈建議 ---
  "chat.abort", // 使用者打斷時中止 Agent 回合，否則會空跑付費
  "talk.client.steer", // 語音打斷／狀態查詢（openclaw_agent_control）
  "talk.catalog", // 讀 provider / model / voice 就緒狀態
  "talk.config", // 讀有效 Talk 設定（強制不帶 includeSecrets）
]);

/**
 * 第二道保險：即使有人不小心把方法加進白名單，命中這些前綴也一律擋下並記 log。
 * 清單來自 M0 §B9「明確排除」。
 */
export const DENIED_PREFIXES: readonly string[] = [
  "config.", // 上游強制 operator.admin
  "update.", // 同上
  "wizard.", // 同上
  "exec.approvals.", // 同上
  "chat.send", // 繞過 Talk 直接送訊息
  "sessions.",
  "terminal.",
  "nodes.",
  "fs.",
  "talk.session.", // gateway-relay 才需要，路徑 1 用不到
  "talk.speak",
  "tts.",
  "agents.", // 注意：agent.wait 不含 s，不會誤中
  "secrets.",
];

/** 完全不得由瀏覽器發起的方法（connect 由 BFF 自己做）。 */
export const DENIED_METHODS: readonly string[] = ["connect"];

/** 命中危險前綴 / 危險方法 → true。命中時呼叫端必須記 log。 */
export function isDeniedMethod(method: string): boolean {
  if (DENIED_METHODS.includes(method)) return true;
  return DENIED_PREFIXES.some((p) => method === p || method.startsWith(p));
}

/** 是否允許轉發。預設拒絕：先看黑名單前綴，再看白名單。 */
export function isAllowedMethod(method: string): boolean {
  if (typeof method !== "string" || method === "") return false;
  if (isDeniedMethod(method)) return false;
  return RPC_ALLOWLIST.has(method);
}

// ── 參數硬化 ────────────────────────────────────────────────────────────────

export interface SanitizeContext {
  /** 伺服器持有的 Talk sessionKey，瀏覽器不得指定（契約 §4.2）。 */
  readonly sessionKey: string;
  /**
   * 由 talk.client.toolCall 回應學到的 agentSessionKey。
   * chat.abort 需要它，且它不一定等於 Talk 的 sessionKey，
   * 所以只接受「伺服器自己看過的值」，不接受瀏覽器自由填。
   */
  readonly agentSessionKeys: readonly string[];
}

export type SanitizeResult =
  | { readonly ok: true; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly code: "forbidden" | "bad_request"; readonly reason: string };

const VOICE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function obj(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function str(value: unknown, maxLen: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen ? value : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function bad(reason: string): SanitizeResult {
  return { ok: false, code: "bad_request", reason };
}

/**
 * 逐方法的參數硬化。白名單只決定「方法能不能用」，這裡決定「參數長什麼樣」。
 * 一律採白名單式重建：只把認得的欄位抄過去，其餘全部丟掉
 * （Gateway 的 params schema 是 closed object，多帶欄位本來就會被拒）。
 */
export function sanitizeParams(method: string, params: unknown, ctx: SanitizeContext): SanitizeResult {
  const p = obj(params);

  switch (method) {
    case "talk.config":
      // 絕不可讓 includeSecrets: true 通過 —— 那會升級成 operator.talk.secrets 並回傳金鑰。
      return { ok: true, params: {} };

    case "talk.catalog":
      return { ok: true, params: {} };

    case "talk.client.create": {
      // sessionKey / mode / transport / brain 一律由 BFF 覆寫；
      // 瀏覽器唯一能帶的是 voiceSessionId（同一通電話換 transport 時沿用）。
      const vsid = str(p["voiceSessionId"], 128);
      if (p["voiceSessionId"] !== undefined && (vsid === null || !VOICE_SESSION_ID_RE.test(vsid))) {
        return bad("voiceSessionId 格式不合法");
      }
      return {
        ok: true,
        params: {
          sessionKey: ctx.sessionKey,
          mode: "realtime",
          transport: "webrtc",
          brain: "agent-consult",
          ...(vsid !== null ? { voiceSessionId: vsid } : {}),
        },
      };
    }

    case "talk.client.toolCall": {
      const vsid = str(p["voiceSessionId"], 128);
      const callId = str(p["callId"], 128);
      const name = str(p["name"], 64);
      if (vsid === null || !VOICE_SESSION_ID_RE.test(vsid)) return bad("voiceSessionId 格式不合法");
      if (callId === null) return bad("callId 缺少或格式不合法");
      // M0 §B8：Gateway 端只接受 openclaw_agent_consult，其餘工具由瀏覽器本地處理
      // 或走 talk.client.steer。這裡再擋一次，避免瀏覽器拿它當任意工具入口。
      if (name !== "openclaw_agent_consult") return { ok: false, code: "forbidden", reason: `工具名不在允許範圍：${String(name)}` };
      const args = p["args"];
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
        return bad("args 必須是物件");
      }
      return {
        ok: true,
        params: {
          sessionKey: ctx.sessionKey,
          voiceSessionId: vsid,
          callId,
          name,
          ...(args !== undefined ? { args } : {}),
        },
      };
    }

    case "talk.client.transcript": {
      const vsid = str(p["voiceSessionId"], 128);
      const entryId = str(p["entryId"], 128);
      const role = str(p["role"], 32);
      const text = str(p["text"], 8192);
      const ts = p["timestamp"];
      if (vsid === null || !VOICE_SESSION_ID_RE.test(vsid)) return bad("voiceSessionId 格式不合法");
      if (entryId === null || !ID_RE.test(entryId)) return bad("entryId 格式不合法");
      if (role !== "user" && role !== "assistant") return bad("role 只能是 user 或 assistant");
      if (text === null) return bad("text 缺少或過長");
      if (ts !== undefined && typeof ts !== "string" && typeof ts !== "number") return bad("timestamp 型別不合法");
      return {
        ok: true,
        params: {
          sessionKey: ctx.sessionKey,
          voiceSessionId: vsid,
          entryId,
          role,
          text,
          ...(ts !== undefined ? { timestamp: ts } : {}),
        },
      };
    }

    case "talk.client.close": {
      const vsid = str(p["voiceSessionId"], 128);
      // M0 §B5 步驟 15：sessionKey 與 voiceSessionId 兩個欄位都必填。
      if (vsid === null || !VOICE_SESSION_ID_RE.test(vsid)) return bad("voiceSessionId 格式不合法");
      return { ok: true, params: { sessionKey: ctx.sessionKey, voiceSessionId: vsid } };
    }

    case "talk.client.steer": {
      const text = str(p["text"], 2048);
      const mode = p["mode"];
      if (text === null) return bad("text 缺少或過長");
      if (mode !== undefined && !["status", "steer", "cancel", "followup"].includes(String(mode))) {
        return bad("mode 不在允許範圍");
      }
      return {
        ok: true,
        params: {
          sessionKey: ctx.sessionKey,
          text,
          ...(mode !== undefined ? { mode: String(mode) } : {}),
        },
      };
    }

    case "agent.wait": {
      const runId = str(p["runId"], 128);
      if (runId === null || !ID_RE.test(runId)) return bad("runId 格式不合法");
      // Control UI 用 120000；這裡夾住上下限，避免瀏覽器拿它當長連線資源耗用手段。
      return { ok: true, params: { runId, timeoutMs: clampInt(p["timeoutMs"], 1000, 120_000, 120_000) } };
    }

    case "chat.abort": {
      const sessionKey = str(p["sessionKey"], 128) ?? ctx.sessionKey;
      const allowed = sessionKey === ctx.sessionKey || ctx.agentSessionKeys.includes(sessionKey);
      if (!allowed) return { ok: false, code: "forbidden", reason: "sessionKey 不是伺服器持有或認得的值" };
      const agentId = str(p["agentId"], 128);
      const runId = str(p["runId"], 128);
      if (agentId !== null && !ID_RE.test(agentId)) return bad("agentId 格式不合法");
      if (runId !== null && !ID_RE.test(runId)) return bad("runId 格式不合法");
      return {
        ok: true,
        params: {
          sessionKey,
          ...(agentId !== null ? { agentId } : {}),
          ...(runId !== null ? { runId } : {}),
        },
      };
    }

    default:
      // 走到這裡代表白名單與本函數不同步 —— 預設拒絕。
      return { ok: false, code: "forbidden", reason: "沒有對應的參數硬化規則" };
  }
}

/**
 * Gateway 事件白名單（契約 §4.3）。只轉這兩類，其餘一律不轉，
 * 避免 Gateway 的內部狀態（nodes / sessions / config 變更）外洩給瀏覽器。
 */
export const EVENT_ALLOWLIST: ReadonlySet<string> = new Set<string>(["chat", "talk.event"]);

export function isAllowedEvent(event: string): boolean {
  return EVENT_ALLOWLIST.has(event);
}
