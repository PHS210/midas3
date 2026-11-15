import type express from "express";
import type { AdminAuth } from "./adminAuth.js";
import type { ServerConfig } from "./config.js";
import { extractApiToken, getClientIp, sendApiError, trustedClientIp } from "./http.js";

// 관리자 API 인증. 암호가 맞는지는 AdminAuth가 본다(처음 암호 또는 화면에서 바꾼 암호, 틀린 횟수 제한).
// - 암호가 어디에도 없으면 관리자 API는 열리지 않는다(예전에는 암호가 없으면 전부 통과했다).
// - ADMIN_DEMO_UNLOCK=true는 조회(GET)만 암호 없이 허용한다. 생성·내보내기·삭제는 항상 암호가 필요하다.
export function requireAdmin(config: ServerConfig, auth: AdminAuth, options: { allowDemoRead?: boolean } = {}): express.RequestHandler {
  return (req, res, next) => {
    if (options.allowDemoRead && config.admin.demoUnlock && (req.method === "GET" || req.method === "HEAD")) return next();
    if (!auth.hasPassword()) {
      return sendApiError(res, 503, "ADMIN_PASSWORD_NOT_SET", "ADMIN_PASSWORD is not configured on this server.");
    }
    const provided = extractApiToken(req);
    if (!provided) return sendApiError(res, 401, "AUTH_REQUIRED", "Missing or invalid API token.");
    const ip = trustedClientIp(req);
    const result = auth.attempt(ip, provided);
    if (result === "ok") return next();
    if (result === "locked") {
      const retryAfterSec = auth.retryAfterSec(ip) || 1;
      res.setHeader("Retry-After", String(retryAfterSec));
      return sendApiError(res, 429, "ADMIN_TOO_MANY_ATTEMPTS", "Too many wrong passwords. Retry later.", { retry_after_sec: retryAfterSec });
    }
    return sendApiError(res, 401, "AUTH_REQUIRED", "Missing or invalid API token.");
  };
}

type RateLimitBucket = { count: number; resetAt: number };

export function rateLimit(options: { windowMs: number; max: number; code?: string; message?: string }): express.RequestHandler {
  const buckets = new Map<string, RateLimitBucket>();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    const key = getClientIp(req);
    const existing = buckets.get(key);
    const bucket = (!existing || existing.resetAt <= now)
      ? { count: 0, resetAt: now + options.windowMs }
      : existing;
    if (bucket.count >= options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return sendApiError(
        res,
        429,
        options.code ?? "RATE_LIMITED",
        options.message ?? "Too many requests. Please retry later.",
        { retry_after_sec: retryAfterSec }
      );
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    return next();
  };
}
