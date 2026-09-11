// ─────────────────────────────────────────────────────────────────────────────
// open_HAL BFF 的進入點：HTTP 伺服器、靜態檔、路由、/admin 反向代理、優雅關閉。
//
// 路由一覽（契約 §1）：
//   GET  /                 → cookie 或 ?k 有效時回 HAL Face，否則回全黑頁（200）
//   GET  /hal-config.json  → 前端執行期設定（PICOVOICE_ACCESS_KEY 唯一的出口）
//   GET  /healthz          → 不需認證；Gateway 未就緒時回 503
//   GET  /assets/* 等      → Vite build 產物（需 cookie）
//   WS   /hal              → 白名單 RPC 轉接（見 hal-ws.ts）
//   ANY  /admin/*          → Basic Auth 後反向代理到 Gateway Control UI（含 WS upgrade）
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  buildClearCookie,
  buildSetCookie,
  checkBasicAuth,
  hasValidAccessCookie,
  isValidAccessKey,
} from "./auth.js";
import { config, redacted } from "./config.js";
import { GatewaySupervisor, probeStarted } from "./gateway.js";
import { GatewayClient } from "./gateway-client.js";
import { HalWsHub } from "./hal-ws.js";

function log(...args: unknown[]): void {
  console.log("[hal-server]", ...args);
}

// ── 全黑頁（契約 §1）────────────────────────────────────────────────────────
// 不得回 401/403 文字、不得洩漏任何訊息，也不含任何 <script>。
const BLACK_PAGE =
  "<!doctype html><meta charset=utf-8><title></title>" +
  "<style>html,body{margin:0;height:100%;background:#000}</style>";

// ── 安全 header ─────────────────────────────────────────────────────────────
/**
 * CSP 每一條指令的理由（寫錯會讓喚醒詞 WASM 或 WebRTC 安靜失效，改之前請讀完）：
 *
 * - default-src 'self'      基準線：沒有特別列出的資源類型一律只允許同源。
 * - script-src 'self' 'wasm-unsafe-eval'
 *                           喚醒詞引擎（Porcupine Web）是 WebAssembly。CSP 預設會擋掉
 *                           WebAssembly.compile/instantiate，必須有 'wasm-unsafe-eval'
 *                           才能編譯 WASM；它只放行 WASM，不會放行 eval()。
 *                           （安全紅線 5 要求喚醒詞在瀏覽器本機跑，這條是前提。）
 * - worker-src 'self' blob: 喚醒詞引擎在 Web Worker 裡跑音訊，且常以 blob: URL 建立 worker。
 * - style-src 'self' 'unsafe-inline'
 *                           hal/face/index.html 內嵌一段 <style> 先鋪黑底（避免載入閃白），
 *                           且紅眼動畫以 element.style 寫 CSS 變數。
 * - img-src 'self' data:    空 favicon 用 data: URI；HAL 素材是同源檔案。
 * - media-src 'self' blob:  WebRTC 遠端音訊以 MediaStream 播放（部分路徑會走 blob:）。
 * - connect-src 'self' https://api.openai.com wss://api.openai.com
 *                           兩件事：(1) /hal 的同源 WSS —— CSP3 起 'self' 已涵蓋同源 ws/wss；
 *                           (2) M0 §B6 路徑 A：瀏覽器把 SDP offer 直接 POST 到
 *                           https://api.openai.com/v1/realtime/calls，不經 BFF。
 *                           少了這一條，session 會在 SDP 交換那一步安靜失敗。
 *                           註：WebRTC 的 ICE/媒體流本身不受 connect-src 管轄
 *                           （瀏覽器未實作 webrtc-src），CSP 能顧到的就是上面那個 fetch。
 * - font-src 'self' / object-src 'none' / frame-src 'none' / frame-ancestors 'none'
 *   / base-uri 'none' / form-action 'none'
 *                           HAL 臉沒有字型、外掛、iframe、表單，全部關掉；
 *                           frame-ancestors 'none' 同時擋掉點擊劫持。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' https://api.openai.com wss://api.openai.com",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function securityHeaders(res: ServerResponse, withCsp: boolean): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // 麥克風只給自己這個 origin（安全紅線 5 的連帶要求）。
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  // /admin 代理的是 Gateway 官方 Control UI，套我們的 CSP 只會把它弄壞，
  // 所以 CSP 只加在 open_HAL 自己產生的回應上。Control UI 由 Basic Auth 保護。
  if (withCsp) res.setHeader("Content-Security-Policy", CSP);
}

// ── 靜態檔 ──────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function sendBlackPage(res: ServerResponse, clearCookie = false): void {
  securityHeaders(res, true);
  if (clearCookie) res.setHeader("Set-Cookie", buildClearCookie());
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(BLACK_PAGE);
}

function sendNotFound(res: ServerResponse): void {
  securityHeaders(res, true);
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("");
}

function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  // 路徑正規化後必須仍落在 faceDist 內，否則視為路徑穿越。
  const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(config.faceDistDir, rel);
  if (!filePath.startsWith(config.faceDistDir + path.sep) && filePath !== config.faceDistDir) {
    sendNotFound(res);
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendNotFound(res);
    return;
  }
  if (!stat.isFile()) {
    sendNotFound(res);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  securityHeaders(res, true);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": String(stat.size),
    // Vite 的 /assets/* 檔名帶 hash，可以長快取；其餘一律不快取。
    "Cache-Control": rel.startsWith("assets" + path.sep)
      ? "private, max-age=31536000, immutable"
      : "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

// ── /admin 反向代理（D5、M0 §D19）───────────────────────────────────────────
// 目標是 Gateway 的 Control UI。建議把 gateway.controlUi.basePath 設成 "/admin"，
// 這樣路徑可以原樣轉發、不必改寫（改 basePath 需要重啟 Gateway）。
function requireBasicAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (checkBasicAuth(req.headers.authorization)) return true;
  securityHeaders(res, true);
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="open_HAL admin", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("");
  return false;
}

function proxyAdmin(req: IncomingMessage, res: ServerResponse): void {
  const headers = { ...req.headers };
  // 絕不把 BFF 的 Basic Auth 憑證往下游帶。
  delete headers.authorization;
  headers.host = `127.0.0.1:${config.gatewayPort}`;

  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: config.gatewayPort,
      method: req.method ?? "GET",
      path: req.url ?? "/admin",
      headers,
    },
    (upRes) => {
      securityHeaders(res, false);
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    log("/admin 代理失敗：", err.message);
    if (!res.headersSent) {
      securityHeaders(res, true);
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("");
  });
  req.pipe(upstream);
}

/** Control UI 會直接連 Gateway 的 WebSocket，所以 upgrade 也必須代理（M0 §D19 注意事項 1）。 */
function proxyAdminUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const headers = { ...req.headers };
  delete headers.authorization;
  headers.host = `127.0.0.1:${config.gatewayPort}`;

  const upstream = http.request({
    host: "127.0.0.1",
    port: config.gatewayPort,
    method: "GET",
    path: req.url ?? "/admin",
    headers,
  });

  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? "Switching Protocols"}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${item}`);
      else if (v !== undefined) lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead.length > 0) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
  });
  upstream.on("response", () => socket.destroy()); // 對端不肯 upgrade
  upstream.on("error", (err) => {
    log("/admin WS 代理失敗：", err.message);
    socket.destroy();
  });
  if (head.length > 0) socket.unshift(head);
  upstream.end();
}

// ── 組裝 ────────────────────────────────────────────────────────────────────
const supervisor = new GatewaySupervisor();
const gatewayClient = new GatewayClient();
const halWs = new HalWsHub(gatewayClient);

async function handleHealthz(res: ServerResponse): Promise<void> {
  const status = supervisor.status();
  const started = status.running ? await probeStarted() : false;
  const ready = started && gatewayClient.ready;
  const ok = status.running && ready;
  const body = JSON.stringify({
    ok,
    server: "up",
    gateway: { running: status.running, ready, restarts: status.restarts },
  });
  securityHeaders(res, true);
  res.writeHead(ok ? 200 : 503, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** 契約 §2：PICOVOICE_ACCESS_KEY 唯一被允許進入瀏覽器的途徑（安全紅線 6）。 */
function handleHalConfig(res: ServerResponse): void {
  const hasPicovoice = config.picovoiceAccessKey !== null;
  const body = JSON.stringify({
    sessionKey: config.sessionKey,
    idleTimeoutSec: config.idleTimeoutSec,
    wake: {
      engine: hasPicovoice ? "porcupine" : "vad",
      accessKey: config.picovoiceAccessKey,
      keywordUrl: "/wake/hal.ppn",
      modelUrl: "/wake/porcupine_params.pv",
      sensitivity: config.wakeSensitivity,
    },
  });
  securityHeaders(res, true);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  // /healthz：Railway 的 healthcheck 要打它，不需認證（契約 §3）。
  if (pathname === "/healthz") {
    void handleHealthz(res);
    return;
  }

  // /admin：Basic Auth 後原樣代理到 Gateway Control UI。
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!requireBasicAuth(req, res)) return;
    proxyAdmin(req, res);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    sendNotFound(res);
    return;
  }

  // 首頁：?k=<HAL_ACCESS_KEY> → 種 cookie 後 302 回 /，把 key 從網址列清掉。
  if (pathname === "/") {
    const k = url.searchParams.get("k");
    if (k !== null) {
      if (isValidAccessKey(k)) {
        securityHeaders(res, true);
        res.writeHead(302, {
          Location: "/",
          "Set-Cookie": buildSetCookie(),
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }
      sendBlackPage(res, true);
      return;
    }
    if (!hasValidAccessCookie(req.headers.cookie)) {
      sendBlackPage(res);
      return;
    }
    serveStatic(req, res, "/index.html");
    return;
  }

  // 以下一律需要 cookie；沒有就回 404（不洩漏任何存在與否以外的資訊）。
  if (!hasValidAccessCookie(req.headers.cookie)) {
    sendNotFound(res);
    return;
  }

  if (pathname === "/hal-config.json") {
    handleHalConfig(res);
    return;
  }

  serveStatic(req, res, pathname);
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/hal") {
    halWs.handleUpgrade(req, socket, head);
    return;
  }
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!checkBasicAuth(req.headers.authorization)) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="open_HAL admin"\r\nConnection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    proxyAdminUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

// ── 啟動 ────────────────────────────────────────────────────────────────────
log("設定：", JSON.stringify(redacted()));
if (config.insecureCookie) {
  log("⚠ HAL_INSECURE_COOKIE=1：cookie 不帶 Secure 屬性。僅限本機 http 開發，絕不可用於正式部署。");
}
if (!fs.existsSync(config.faceDistDir)) {
  log(`⚠ 找不到前端產物（${config.faceDistDir}），請先跑 npm --prefix hal/face run build。`);
}

if (config.skipGateway) {
  log("⚠ HAL_SKIP_GATEWAY=1：不啟動 Gateway 子行程，/healthz 會一直回 503。");
} else {
  supervisor.start();
  gatewayClient.start();
}

server.listen(config.port, () => {
  log(`監聽 http://0.0.0.0:${config.port}`);
});

// ── 優雅關閉：先收 HTTP，再關 WS，最後關 Gateway 子行程 ────────────────────
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，開始關閉…`);
  server.close();
  halWs.close();
  gatewayClient.stop();
  await supervisor.stop();
  log("已關閉。");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
