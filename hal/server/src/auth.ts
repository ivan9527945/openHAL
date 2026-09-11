// ─────────────────────────────────────────────────────────────────────────────
// 存取控制：HAL_ACCESS_KEY cookie、/admin Basic Auth、rate limit。
//
// 所有密鑰比對一律 timing-safe：先各自取 SHA-256 再比對固定長度的 digest，
// 因此長度不同也會走完完全相同的路徑，不會從回應時間洩漏任何資訊。
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, timingSafeEqual } from "node:crypto";

import { config } from "./config.js";

/** cookie 名稱（契約 §1）。 */
export const COOKIE_NAME = "hal_key";

/** 固定時間的字串比對。 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** 解析 Cookie header，回傳鍵值表。格式異常的片段直接忽略。 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === "") continue;
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      out.set(name, value);
    }
  }
  return out;
}

/** cookie 是否帶著正確的 HAL_ACCESS_KEY。 */
export function hasValidAccessCookie(cookieHeader: string | undefined): boolean {
  const value = parseCookies(cookieHeader).get(COOKIE_NAME) ?? "";
  return timingSafeEqualStr(value, config.halAccessKey);
}

/** `?k=` 帶進來的金鑰是否正確。 */
export function isValidAccessKey(candidate: string | null): boolean {
  return timingSafeEqualStr(candidate ?? "", config.halAccessKey);
}

/**
 * 契約 §1 的 Set-Cookie。
 * Secure 預設必開；本機 http 開發時 Secure cookie 會被瀏覽器丟掉，
 * 此時才用 HAL_INSECURE_COOKIE=1 關掉（啟動時會印警告）。
 */
export function buildSetCookie(): string {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(config.halAccessKey)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=31536000",
  ];
  if (!config.insecureCookie) attrs.splice(2, 0, "Secure");
  return attrs.join("; ");
}

/** 清掉 cookie（金鑰錯誤時用，避免舊 cookie 一直卡著）。 */
export function buildClearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** /admin 的 Basic Auth。帳號與密碼都走固定時間比對，且一定兩個都比完。 */
export function checkBasicAuth(header: string | undefined): boolean {
  let user = "";
  let pass = "";
  if (typeof header === "string" && header.slice(0, 6).toLowerCase() === "basic ") {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep >= 0) {
        user = decoded.slice(0, sep);
        pass = decoded.slice(sep + 1);
      }
    } catch {
      // 解不開就用空字串往下走，照樣付出兩次比對的時間成本。
    }
  }
  const userOk = timingSafeEqualStr(user, config.adminUser);
  const passOk = timingSafeEqualStr(pass, config.adminPass);
  return userOk && passOk;
}

/**
 * 記憶體內的滑動視窗 rate limit。
 * 單人使用的服務，key 數量極少，用陣列存時間戳就夠了，不需要任何外部相依。
 */
export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 記錄一次請求；回傳 true 代表放行。 */
  hit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    if (this.#hits.size > 256) this.#prune(cutoff);
    return true;
  }

  forget(key: string): void {
    this.#hits.delete(key);
  }

  #prune(cutoff: number): void {
    for (const [k, v] of this.#hits) {
      if (v.length === 0 || v[v.length - 1]! <= cutoff) this.#hits.delete(k);
    }
  }
}

/** 取用戶端 IP。Railway 在 BFF 前面有一層代理，因此取 X-Forwarded-For 的第一段。 */
export function clientIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = (raw ?? "").split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : (remoteAddress ?? "unknown");
}
