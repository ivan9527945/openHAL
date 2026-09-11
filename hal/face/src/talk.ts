/**
 * open_HAL — Realtime session 生命週期（M0 §B5 路徑 1：client-owned WebRTC）
 *
 * 完全照 `docs/M0_技術查證_v0.1.md` §B5 的 15 步序列實作：
 *
 *   1. getUserMedia **必須在 talk.client.create 之前**（官方文件：先拿麥克風，
 *      才不會浪費 60 秒的 offer token）—— 本檔靠 `hal.ensureAudio()` 保證這點。
 *   2. talk.client.create：**只帶 voiceSessionId**（契約 §4.2：sessionKey / mode /
 *      transport / brain 一律由 BFF 覆寫）。schema 是 closed object，多傳欄位會被拒絕。
 *   3. RTCPeerConnection：加 audio track、建 data channel、createOffer。
 *   4. POST <offerUrl>（Authorization: Bearer <clientSecret>、Content-Type: application/sdp）。
 *      offerUrl 若是相對路徑（gateway-control-v1），依契約 §5：v1 不支援 → log + error 狀態。
 *   5. data channel 收到 function call → talk.client.toolCall → 以 `chat` 事件
 *      （runId 相符且 state === "final"）或 agent.wait 取結果 → 寫回 data channel。
 *   6. 輸出音訊接到 window.hal.attachOutput(analyser) → speaking。
 *   7. 定稿逐字稿 → talk.client.transcript（否則 HAL 的記憶會缺語音對話內容）。
 *   8. 使用者打斷 → chat.abort。
 *   9. 結束 → talk.client.close（sessionKey 與 voiceSessionId 兩個都必填）。
 *
 * TTL（M0 §B10）：官方**沒有任何 renew / refresh 方法**，只能 close + 重建。
 */

import type { HalConfig } from './config.js';
import type { HalRuntime } from './main.js';
import type { HalRpc } from './rpc.js';

/** Session TTL 保底推算值（M0 §B10：Gateway 排定 30 分鐘 lease） */
const TTL_MS = 30 * 60 * 1000;
/** 提前多久重建 session（M0 §B10 建議 2 分鐘） */
const RENEW_MARGIN_MS = 2 * 60 * 1000;
/** REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS：expiresAt - 5000 <= now 會被判定為啟動即過期 */
const MIN_TTL_MS = 5_000;
/** agent.wait 的 timeoutMs（Control UI 用 120000） */
const AGENT_WAIT_MS = 120_000;
/** 路徑 A 的預設 offer 端點（M0 §B6：offerUrl 缺席時的預設值） */
const DEFAULT_OFFER_URL = 'https://api.openai.com/v1/realtime/calls';
/** OpenAI Realtime 的 data channel 名稱 */
const DATA_CHANNEL_LABEL = 'oai-events';

/** M0 §B8：瀏覽器端只認得這三個工具名，其餘一律回錯 */
const TOOL_CONSULT = 'openclaw_agent_consult';
const TOOL_CONTROL = 'openclaw_agent_control';
const TOOL_DESCRIBE_VIEW = 'describe_view';

export type TalkEndReason = 'idle-timeout' | 'no-speech' | 'error' | 'stopped';

export interface TalkDeps {
  rpc: HalRpc;
  config: HalConfig;
  hal: HalRuntime;
  /** session 真的結束（不是 TTL 重建）時通知 main.ts 回到喚醒詞監聽 */
  onEnded: (reason: TalkEndReason) => void;
}

export interface TalkController {
  readonly active: boolean;
  /** 建立 session 並開始對話；失敗時會自行切 error 狀態並呼叫 onEnded('error') */
  start(): Promise<void>;
  stop(reason?: TalkEndReason): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 符合 `^[A-Za-z0-9_-]{1,128}$`（M0 §B5 的 schema） */
function newVoiceSessionId(): string {
  const uuid =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `hal-${uuid}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
}

/** expiresAt 可能是 epoch 秒／毫秒或 ISO 字串，docs 未載明，三種都吃 */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  }
  return null;
}

/**
 * 從 `chat` 事件或 `agent.wait` 的回傳裡撈出文字。
 * 兩者的確切形狀 docs 未載明（M0 只列了欄位名），所以寫成容錯的走訪。
 */
function extractText(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => extractText(v, depth + 1)).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (!isRecord(value)) return null;
  for (const key of ['text', 'deltaText', 'content', 'message', 'result', 'output', 'answer', 'data']) {
    const found = extractText(value[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function pickString(v: unknown, key: string): string | null {
  if (!isRecord(v)) return null;
  const x = v[key];
  return typeof x === 'string' && x.length > 0 ? x : null;
}

/** 解析 function call 的 arguments（模型給的是 JSON 字串） */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

interface SessionInfo {
  voiceSessionId: string;
  clientSecret: string;
  offerUrl: string;
  offerHeaders: Record<string, string>;
  expiresAtMs: number;
}

interface ActiveRun {
  runId: string;
  agentId: string | null;
  agentSessionKey: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// 主體
// ────────────────────────────────────────────────────────────────────────────

export function createTalk(deps: TalkDeps): TalkController {
  const { rpc, config, hal, onEnded } = deps;
  const sessionKey = config.sessionKey;

  let session: SessionInfo | null = null;
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let outputSource: MediaStreamAudioSourceNode | null = null;
  let outputAnalyser: AnalyserNode | null = null;
  let activeRun: ActiveRun | null = null;
  let starting: Promise<void> | null = null;
  let stopping = false;

  /** speaking / thinking 時不切 TTL（M0 §B10：說話中不切，延到 idle 再切） */
  let busy = false;
  let renewPending = false;
  /** 已經送出過 transcript 的 entryId，避免重複（entryId 在同一 voiceSessionId 內具冪等性） */
  const sentTranscripts = new Set<string>();
  /** 已處理過的 function call id，避免 output_item.done 與 arguments.done 重複觸發 */
  const handledCalls = new Set<string>();

  let idleTimer: number | undefined;
  let armTimer: number | undefined;
  let ttlTimer: number | undefined;

  function clearTimer(id: number | undefined): void {
    if (id !== undefined) window.clearTimeout(id);
  }

  // ── 狀態 ──────────────────────────────────────────────────────────────────

  function setPhase(phase: 'listening' | 'thinking' | 'speaking'): void {
    busy = phase !== 'listening';
    hal.setState(phase);
    if (!busy && renewPending) {
      renewPending = false;
      void renewSession();
    }
  }

  // ── 逾時 ──────────────────────────────────────────────────────────────────

  function resetIdleTimer(): void {
    clearTimer(idleTimer);
    idleTimer = window.setTimeout(() => {
      console.info('[hal/talk] 靜默逾時，關閉 session 回到喚醒詞監聽');
      void stop('idle-timeout');
    }, Math.max(5, config.idleTimeoutSec) * 1000);
  }

  /**
   * 誤觸發保險（計劃書 §6 細節 2）：喚醒後 HAL_WAKE_ARM_TIMEOUT 內若沒有偵測到語音，
   * 靜默關閉 session 退回監聽，避免誤觸發後空轉付費。
   */
  function armNoSpeechTimer(): void {
    clearTimer(armTimer);
    armTimer = window.setTimeout(() => {
      console.info('[hal/talk] 喚醒後未偵測到語音，靜默關閉 session');
      void stop('no-speech');
    }, config.wake.armTimeoutMs);
  }

  function noteSpeechDetected(): void {
    clearTimer(armTimer);
    armTimer = undefined;
    resetIdleTimer();
  }

  // ── TTL：只能 close + 重建（M0 §B10 確認官方沒有 renew / refresh） ─────────

  function scheduleTtl(expiresAtMs: number): void {
    clearTimer(ttlTimer);
    const delay = Math.max(1_000, expiresAtMs - RENEW_MARGIN_MS - Date.now());
    ttlTimer = window.setTimeout(() => {
      if (busy) {
        // 說話中／等 Agent 中不切，延到回 listening 再切
        console.info('[hal/talk] TTL 到期但正在說話，延到 idle 再重建');
        renewPending = true;
        return;
      }
      void renewSession();
    }, delay);
  }

  /** close 舊 session → 立刻建新的。整段沒有任何提示音或畫面變化，使用者無感。 */
  async function renewSession(): Promise<void> {
    if (session === null || stopping) return;
    console.info('[hal/talk] TTL 將到期，重建 session');
    try {
      await teardown(/* notifyGateway */ true);
      // 重建時重新產生 voiceSessionId：舊的那顆已隨 close 結束，
      // 而記憶連續性靠的是 sessionKey（agent session），不是 voiceSessionId。
      await openSession(false);
    } catch (err) {
      console.error('[hal/talk] TTL 重建失敗', err);
      hal.setState('error');
      await teardown(false);
      onEnded('error');
    }
  }

  // ── 逐字稿（M0 §B5 步驟 12） ──────────────────────────────────────────────

  function sendTranscript(entryId: string, role: 'user' | 'assistant', text: string): void {
    if (session === null || text.trim().length === 0) return;
    if (sentTranscripts.has(entryId)) return;
    sentTranscripts.add(entryId);
    rpc
      .call('talk.client.transcript', {
        sessionKey,
        voiceSessionId: session.voiceSessionId,
        entryId,
        role,
        text,
        timestamp: Date.now(),
      })
      .catch((err: unknown) => {
        // 逐字稿失敗不該中斷對話，只記 console
        console.error('[hal/talk] talk.client.transcript 失敗', err);
      });
  }

  // ── toolCall（M0 §B5 步驟 8–10、§B8） ────────────────────────────────────

  async function awaitRunResult(runId: string): Promise<string> {
    let offChat: () => void = () => {};
    let hardTimer: number | undefined;

    const chatPromise = new Promise<string>((resolve, reject) => {
      offChat = rpc.on('chat', (payload) => {
        if (!isRecord(payload) || payload['runId'] !== runId) return;
        const state = payload['state'];
        if (state === 'final') {
          resolve(extractText(payload) ?? '');
        } else if (state === 'error' || state === 'aborted') {
          reject(new Error(`[hal/talk] agent run ${String(state)}`));
        }
      });
    });

    const waitPromise = rpc
      .call('agent.wait', { runId, timeoutMs: AGENT_WAIT_MS }, { timeoutMs: AGENT_WAIT_MS + 5_000 })
      .then((v) => extractText(v) ?? '')
      .catch((err: unknown) => {
        // agent.wait 可能沒被 BFF 放行，退回只靠 `chat` 事件
        console.warn('[hal/talk] agent.wait 失敗，改等 chat 事件', err);
        return chatPromise;
      });

    const hardTimeout = new Promise<never>((_, reject) => {
      hardTimer = window.setTimeout(
        () => reject(new Error('[hal/talk] consult 逾時')),
        AGENT_WAIT_MS + 15_000,
      );
    });

    try {
      return await Promise.race([chatPromise, waitPromise, hardTimeout]);
    } finally {
      offChat();
      clearTimer(hardTimer);
    }
  }

  function sendToModel(msg: unknown): void {
    if (dc === null || dc.readyState !== 'open') {
      console.warn('[hal/talk] data channel 未開啟，丟棄訊息');
      return;
    }
    dc.send(JSON.stringify(msg));
  }

  function submitToolResult(callId: string, output: unknown): void {
    sendToModel({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof output === 'string' ? output : JSON.stringify(output),
      },
    });
    // 讓模型把結果講出來
    sendToModel({ type: 'response.create' });
  }

  async function handleFunctionCall(callId: string, name: string, rawArgs: unknown): Promise<void> {
    if (session === null) return;
    if (handledCalls.has(callId)) return;
    handledCalls.add(callId);
    const args = parseArgs(rawArgs);

    if (name === TOOL_CONSULT) {
      // 送出 toolCall 後、結果回來前 = thinking（契約 §6）
      setPhase('thinking');
      try {
        const res = await rpc.call('talk.client.toolCall', {
          sessionKey,
          voiceSessionId: session.voiceSessionId,
          callId,
          name,
          args,
        });
        const runId = pickString(res, 'runId');
        if (runId === null) throw new Error('talk.client.toolCall 沒有回 runId');
        activeRun = {
          runId,
          agentId: pickString(res, 'agentId'),
          agentSessionKey: pickString(res, 'agentSessionKey'),
        };
        const text = await awaitRunResult(runId);
        activeRun = null;
        submitToolResult(callId, text.length > 0 ? text : '(no content)');
      } catch (err) {
        activeRun = null;
        console.error('[hal/talk] agent consult 失敗', err);
        submitToolResult(callId, { error: 'agent_consult_failed' });
      } finally {
        if (busy) setPhase('listening');
        resetIdleTimer();
      }
      return;
    }

    if (name === TOOL_CONTROL) {
      // 語音狀態查詢／打斷／跟進（M0 §B8）
      try {
        const text = extractText(args) ?? '';
        const mode = pickString(args, 'mode') ?? 'status';
        await rpc.call('talk.client.steer', { sessionKey, text, mode });
        submitToolResult(callId, { ok: true });
      } catch (err) {
        console.error('[hal/talk] talk.client.steer 失敗', err);
        submitToolResult(callId, { error: 'steer_failed' });
      }
      return;
    }

    // describe_view 需要 camera-frame capability；open_HAL 沒有鏡頭，一律回不支援。
    const reason =
      name === TOOL_DESCRIBE_VIEW
        ? 'open_HAL has no camera'
        : `Tool "${name}" not available in browser Talk`;
    console.warn('[hal/talk] 拒絕未支援的工具', name);
    submitToolResult(callId, { error: reason });
  }

  // ── data channel 事件 ─────────────────────────────────────────────────────

  function handleRealtimeEvent(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    const type = typeof msg['type'] === 'string' ? msg['type'] : '';

    // 使用者開始說話：解除誤觸發保險，並中止仍在跑的 Agent 回合（步驟 14）
    if (type === 'input_audio_buffer.speech_started') {
      noteSpeechDetected();
      const run = activeRun;
      if (run !== null && run.agentSessionKey !== null) {
        rpc
          .call('chat.abort', {
            sessionKey: run.agentSessionKey,
            ...(run.agentId !== null ? { agentId: run.agentId } : {}),
            runId: run.runId,
          })
          .catch((err: unknown) => console.error('[hal/talk] chat.abort 失敗', err));
      }
      if (busy) setPhase('listening');
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      resetIdleTimer();
      return;
    }

    // 輸出音訊開始 → speaking（實際亮度由 attachOutput 的 analyser 驅動）
    if (
      type === 'response.audio.delta' ||
      type === 'response.output_audio.delta' ||
      type === 'output_audio_buffer.started'
    ) {
      if (!busy || hal.eye.getState() !== 'speaking') setPhase('speaking');
      return;
    }

    if (
      type === 'response.done' ||
      type === 'response.audio.done' ||
      type === 'response.output_audio.done' ||
      type === 'output_audio_buffer.stopped'
    ) {
      setPhase('listening');
      resetIdleTimer();
      return;
    }

    // 定稿逐字稿（步驟 12）
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const id = pickString(msg, 'item_id') ?? `user-${Date.now()}`;
      const text = typeof msg['transcript'] === 'string' ? msg['transcript'] : '';
      sendTranscript(id, 'user', text);
      return;
    }
    if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {
      const id = pickString(msg, 'item_id') ?? `assistant-${Date.now()}`;
      const text = typeof msg['transcript'] === 'string' ? msg['transcript'] : '';
      sendTranscript(id, 'assistant', text);
      return;
    }

    // function call（步驟 7）
    if (type === 'response.function_call_arguments.done') {
      const callId = pickString(msg, 'call_id');
      const name = pickString(msg, 'name');
      if (callId !== null && name !== null) void handleFunctionCall(callId, name, msg['arguments']);
      return;
    }
    if (type === 'response.output_item.done') {
      const item = msg['item'];
      if (isRecord(item) && item['type'] === 'function_call') {
        const callId = pickString(item, 'call_id');
        const name = pickString(item, 'name');
        if (callId !== null && name !== null) void handleFunctionCall(callId, name, item['arguments']);
      }
      return;
    }

    if (type === 'error') {
      console.error('[hal/talk] realtime error 事件', msg['error'] ?? msg);
    }
  }

  // ── 建立 / 拆除 session ───────────────────────────────────────────────────

  async function createSession(): Promise<SessionInfo> {
    // 契約 §4.2：瀏覽器只能帶 voiceSessionId，其餘由 BFF 覆寫。
    // M0 §B5：schema 是 closed object，多傳欄位會被拒絕；voice 欄位名是 `voice` 不是 speakerVoice。
    const voiceSessionId = newVoiceSessionId();
    const res = await rpc.call('talk.client.create', { voiceSessionId });
    if (!isRecord(res)) throw new Error('talk.client.create 回傳格式非預期');

    const clientSecret = pickString(res, 'clientSecret');
    if (clientSecret === null) throw new Error('talk.client.create 沒有回 clientSecret');

    const offerUrl = pickString(res, 'offerUrl') ?? DEFAULT_OFFER_URL;
    let absolute: URL;
    try {
      absolute = new URL(offerUrl);
    } catch {
      // 契約 §5：相對路徑代表 gateway-control-v1 模式，需要 BFF 代理
      // POST /plugins/openai/realtime/calls —— v1 不支援。
      throw new Error(
        `offerUrl 是相對路徑（${offerUrl}），代表 gateway-control-v1 模式；` +
          'v1 不支援此路徑（契約 §5），請確認 BFF 的 OpenAI Platform 憑證設定。',
      );
    }
    if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') {
      throw new Error(`offerUrl 協定非預期：${absolute.protocol}`);
    }

    const expiresAtMs = toEpochMs(res['expiresAt']) ?? Date.now() + TTL_MS;
    // M0 §B10：Control UI 的 REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS = 5000
    if (expiresAtMs - MIN_TTL_MS <= Date.now()) {
      throw new Error('Realtime browser session expired during startup');
    }

    const headers: Record<string, string> = {};
    const rawHeaders = res['offerHeaders'];
    if (isRecord(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders)) if (typeof v === 'string') headers[k] = v;
    }

    return {
      voiceSessionId: pickString(res, 'voiceSessionId') ?? voiceSessionId,
      clientSecret,
      offerUrl: absolute.toString(),
      offerHeaders: headers,
      expiresAtMs,
    };
  }

  /**
   * 建立一次 session。
   * `armForWake`：只有「喚醒詞觸發的第一次」才要開誤觸發保險；
   * TTL 重建是在對話進行中，若也開保險會在 5 秒後把好好的對話砍掉。
   */
  async function openSession(armForWake: boolean): Promise<void> {
    // 步驟 1：先拿麥克風（必須在 talk.client.create 之前）
    const audio = await hal.ensureAudio();
    const track = audio.stream.getAudioTracks()[0];
    if (track === undefined) throw new Error('麥克風沒有 audio track');

    // 步驟 3（前半）：先建 session 拿短效憑證
    const info = await createSession();
    session = info;
    sentTranscripts.clear();
    handledCalls.clear();

    // 步驟 4：RTCPeerConnection —— **只在 session 建立之後才開**（安全紅線 5）
    const peer = new RTCPeerConnection();
    pc = peer;

    peer.addTrack(track, audio.stream);

    const channel = peer.createDataChannel(DATA_CHANNEL_LABEL);
    dc = channel;
    channel.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (typeof ev.data === 'string') handleRealtimeEvent(ev.data);
    });
    channel.addEventListener('open', () => console.info('[hal/talk] data channel 已開啟'));

    peer.addEventListener('track', (ev: RTCTrackEvent) => {
      const remote = ev.streams[0];
      if (remote === undefined) return;
      // 播放：不掛進 DOM（整頁不得新增任何元素／UI 紅線），HTMLAudioElement 自己就能播
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = remote;
      void el.play().catch((err: unknown) => console.error('[hal/talk] 輸出音訊播放失敗', err));
      audioEl = el;

      // 步驟 6：輸出音訊接到紅眼（speaking 的亮度來源）
      try {
        const src = audio.ctx.createMediaStreamSource(remote);
        const analyser = audio.ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        src.connect(analyser); // 不接 destination：播放交給 <audio>，避免重複出聲
        outputSource = src;
        outputAnalyser = analyser;
        hal.attachOutput(analyser);
      } catch (err) {
        console.error('[hal/talk] 無法建立輸出 analyser（紅眼不會跟隨振幅）', err);
      }
    });

    peer.addEventListener('connectionstatechange', () => {
      const s = peer.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        if (stopping || pc !== peer) return;
        console.error('[hal/talk] WebRTC 連線中斷', s);
        hal.setState('error');
        void teardown(true).then(() => onEnded('error'));
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    // 步驟 5：POST offerUrl（headers 照 M0 §B5 的實際寫法）
    const res = await fetch(info.offerUrl, {
      method: 'POST',
      body: offer.sdp ?? '',
      headers: {
        ...info.offerHeaders,
        Authorization: `Bearer ${info.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
    });
    if (!res.ok) throw new Error(`Realtime WebRTC setup failed (${res.status})`);
    const answerSdp = await res.text();
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // WebRTC 已連上 → listening（契約 §6）
    setPhase('listening');
    scheduleTtl(info.expiresAtMs);
    if (armForWake) armNoSpeechTimer();
    resetIdleTimer();
    console.info('[hal/talk] session 已建立', {
      voiceSessionId: info.voiceSessionId,
      expiresAt: new Date(info.expiresAtMs).toISOString(),
    });
  }

  /** 拆掉本地資源；notifyGateway=true 時同時送 talk.client.close（步驟 15） */
  async function teardown(notifyGateway: boolean): Promise<void> {
    clearTimer(idleTimer);
    clearTimer(armTimer);
    clearTimer(ttlTimer);
    idleTimer = undefined;
    armTimer = undefined;
    ttlTimer = undefined;
    activeRun = null;
    renewPending = false;
    busy = false;

    hal.attachOutput(null);
    outputSource?.disconnect();
    outputAnalyser?.disconnect();
    outputSource = null;
    outputAnalyser = null;

    if (audioEl !== null) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl = null;
    }

    dc?.close();
    dc = null;

    if (pc !== null) {
      // 只拆 sender，不停麥克風 track —— stream 的擁有者是 window.hal，
      // 喚醒詞引擎待會還要繼續用它。
      for (const sender of pc.getSenders()) {
        try {
          pc.removeTrack(sender);
        } catch {
          /* 已經拆掉了 */
        }
      }
      pc.close();
      pc = null;
    }

    const info = session;
    session = null;
    if (notifyGateway && info !== null) {
      try {
        // 步驟 15：sessionKey 與 voiceSessionId 兩個都必填（M0 §B5）
        await rpc.call('talk.client.close', { sessionKey, voiceSessionId: info.voiceSessionId });
      } catch (err) {
        console.error('[hal/talk] talk.client.close 失敗', err);
      }
    }
  }

  // ── 對外 ──────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (session !== null || starting !== null) return starting ?? undefined;
    stopping = false;
    starting = (async () => {
      try {
        await openSession(true);
      } catch (err) {
        console.error('[hal/talk] session 建立失敗', err);
        hal.setState('error');
        await teardown(true);
        onEnded('error');
      }
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  async function stop(reason: TalkEndReason = 'stopped'): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      if (starting !== null) {
        try {
          await starting;
        } catch {
          /* 已在 start 內處理 */
        }
      }
      if (session === null && pc === null) return;
      await teardown(true);
      onEnded(reason);
    } finally {
      stopping = false;
    }
  }

  return {
    get active(): boolean {
      return session !== null || starting !== null;
    },
    start,
    stop,
  };
}
