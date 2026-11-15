import { randomBytes } from "node:crypto";

// 체험 기록을 묶는 브라우저 식별 쿠키. 로그인 기능은 없다.
export const ANON_COOKIE = "jobsim_anon";

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
