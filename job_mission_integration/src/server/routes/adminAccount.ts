import express from "express";
import { AdminPasswordChangeRequestSchema } from "../../lib/api/contracts.js";
import type { AdminAuth } from "../adminAuth.js";
import type { ServerConfig } from "../config.js";
import { ApiError, trustedClientIp } from "../http.js";
import { requireAdmin } from "../middleware.js";

// 관리자 계정 경로. 지금은 암호 바꾸기 하나다.
export function adminAccountRouter(deps: { config: ServerConfig; auth: AdminAuth }) {
  const { config, auth } = deps;
  const router = express.Router();
  // 조회 전용 열기(ADMIN_DEMO_UNLOCK)와 상관없이 항상 암호가 필요하다.
  const guard = requireAdmin(config, auth, { allowDemoRead: false });

  // 암호 바꾸기: 지금 암호가 맞아야 하고, 새 암호는 4~100자의 공백 없는 영문 · 숫자 · 기호여야 한다.
  router.post("/api/admin/password", guard, (req, res) => {
    const parsed = AdminPasswordChangeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "ADMIN_PASSWORD_BAD_REQUEST", "currentPassword and newPassword are required.", parsed.error.issues);
    }
    try {
      auth.changePassword(trustedClientIp(req), parsed.data.currentPassword, parsed.data.newPassword);
    } catch (error) {
      if (error instanceof ApiError && error.code === "ADMIN_TOO_MANY_ATTEMPTS") {
        res.setHeader("Retry-After", String((error.details as { retry_after_sec?: number } | undefined)?.retry_after_sec ?? 1));
      }
      throw error;
    }
    res.json({ ok: true });
  });

  return router;
}
