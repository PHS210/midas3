import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "../lib/db/database.js";
import { deleteAdminSetting, getAdminSetting, setAdminSetting } from "../lib/db/repos.js";
import type { ServerConfig } from "./config.js";
import { ApiError } from "./http.js";

// 관리자 암호.
// - 처음 암호는 설정 파일의 ADMIN_PASSWORD다.
// - 관리자 화면에서 바꾸면 DB(admin_settings)에 해시로 남고, 그 뒤로는 그 암호만 통한다(설정 파일보다 먼저).
// - 암호를 잊었으면 ADMIN_PASSWORD_RESET=true로 서버를 켠다. 화면에서 바꾼 암호를 지우고 처음 암호로 돌아간다.
// - 틀린 암호는 IP마다 1분에 10번까지다(ADMIN_PASSWORD_MAX_ATTEMPTS, 0이면 끔). 10번째부터 1분 동안은 맞는 암호도 받지 않는다
//   (맞는 암호만 통과시키면 틀린 암호를 끝없이 넣어 볼 수 있어 제한의 뜻이 없다).
//   IP는 trustedClientIp(http.ts)로 본다. 요청이 보낸 X-Forwarded-For를 그대로 믿으면 값을 바꿔 가며 제한을 피할 수 있다.

const SETTING_KEY = "admin_password_hash";
const MIN_LENGTH = 4;
const MAX_LENGTH = 100;
// 암호는 요청 머리(x-api-token)에 실려 온다. 브라우저가 머리에 실을 수 있는, 공백 없는 글자만 받는다.
const ALLOWED = /^[\x21-\x7e]+$/;
const ATTEMPT_WINDOW_MS = 60_000;
const FAILURE_TABLE_MAX = 5_000;   // 틀린 횟수를 기억하는 IP 수의 위쪽 끝(메모리가 끝없이 늘지 않게)
const SALT_BYTES = 16;
const HASH_BYTES = 64;

export type AttemptResult = "ok" | "wrong" | "locked";

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, HASH_BYTES).toString("hex")}`;
}

// 저장된 값의 모양이 조금이라도 다르면(길이, 16진수가 아닌 글자) 어떤 암호도 받지 않는다.
function matchesHash(stored: string, candidate: string): boolean {
  const [scheme, saltHex, hashHex, ...rest] = stored.split("$");
  if (scheme !== "scrypt" || rest.length || !/^[0-9a-f]+$/.test(saltHex ?? "") || !/^[0-9a-f]+$/.test(hashHex ?? "")) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false;
  return timingSafeEqual(scryptSync(candidate, salt, HASH_BYTES), expected);
}

export interface AdminAuthDeps {
  db: Db;
  config: ServerConfig;
  now?: () => number;
  log?: (message: string) => void;
}

export class AdminAuth {
  private readonly db: Db;
  private readonly config: ServerConfig;
  private readonly now: () => number;
  // 화면에서 바꾼 암호의 해시. 없으면 설정 파일의 암호를 쓴다.
  private storedHash: string | null;
  // 이번에 서버가 켜진 뒤 맞다고 확인한 암호의 SHA-256. 요청마다 scrypt를 돌리지 않으려고 둔다.
  private verified: Buffer | null = null;
  // 이번에 서버가 켜진 뒤 화면에서 바꾸기 바로 앞의 암호(SHA-256). 바꾼 직후 다른 창과 다른 사람이
  // 예전 암호로 보내는 요청을 틀린 횟수에 넣지 않으려고 둔다(통과시키지는 않는다).
  private previous: Buffer | null = null;
  private readonly maxAttempts: number;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(deps: AdminAuthDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.maxAttempts = this.config.admin.maxAttempts;
    const log = deps.log ?? ((message: string) => console.warn(message));
    if (this.config.admin.passwordReset && getAdminSetting(this.db, SETTING_KEY) !== null) {
      deleteAdminSetting(this.db, SETTING_KEY);
      log("[admin] ADMIN_PASSWORD_RESET가 켜져 있어 화면에서 바꾼 관리자 암호를 지웠어. 지금 암호는 ADMIN_PASSWORD야. 이 설정을 지우고 서버를 다시 켜.");
    }
    this.storedHash = getAdminSetting(this.db, SETTING_KEY);
  }

  // 암호가 하나라도 정해져 있나(설정 파일 또는 화면에서 바꾼 것)
  hasPassword(): boolean {
    return Boolean(this.storedHash) || Boolean(this.config.admin.password);
  }

  // 암호 하나를 받아 본다. 틀리면 그 IP의 틀린 횟수에 더한다.
  attempt(ip: string, candidate: string): AttemptResult {
    if (this.isLocked(ip)) return "locked";
    // 바로 앞 암호는 틀린 것이 확실하다. scrypt를 돌리지 않고, 횟수에도 넣지 않는다.
    if (candidate && this.previous !== null && timingSafeEqual(digest(candidate), this.previous)) return "wrong";
    if (this.matches(candidate)) return "ok";
    this.recordFailure(ip);
    return "wrong";
  }

  // 막힌 IP가 다시 넣을 수 있을 때까지 남은 초(막히지 않았으면 0)
  retryAfterSec(ip: string): number {
    const entry = this.failures.get(ip);
    if (!entry || !this.maxAttempts || entry.count < this.maxAttempts) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  // 화면에서 암호 바꾸기. 안 되면 ApiError를 던진다.
  changePassword(ip: string, current: string, next: string): void {
    if (this.config.admin.passwordReset) {
      throw new ApiError(409, "ADMIN_PASSWORD_RESET_ON", "ADMIN_PASSWORD_RESET is on. Remove it and restart the server before changing the password.");
    }
    const result = this.attempt(ip, current);
    if (result === "locked") throw this.lockedError(ip);
    if (result !== "ok") throw new ApiError(403, "ADMIN_PASSWORD_WRONG", "Current password is wrong.");
    if (next.length < MIN_LENGTH || next.length > MAX_LENGTH || !ALLOWED.test(next)) {
      throw new ApiError(400, "ADMIN_PASSWORD_INVALID", "New password must be 4 to 100 printable ASCII characters without spaces.");
    }
    if (next === current) throw new ApiError(400, "ADMIN_PASSWORD_SAME", "New password must differ from the current one.");
    const hash = hashPassword(next);
    setAdminSetting(this.db, SETTING_KEY, hash);
    this.storedHash = hash;
    this.verified = digest(next);
    this.previous = digest(current);
  }

  lockedError(ip: string): ApiError {
    const retryAfterSec = this.retryAfterSec(ip) || 1;
    return new ApiError(429, "ADMIN_TOO_MANY_ATTEMPTS", "Too many wrong passwords. Retry later.", { retry_after_sec: retryAfterSec });
  }

  private matches(candidate: string): boolean {
    if (!candidate) return false;
    const given = digest(candidate);
    if (this.storedHash) {
      if (this.verified && timingSafeEqual(given, this.verified)) return true;
      if (!matchesHash(this.storedHash, candidate)) return false;
      this.verified = given;
      return true;
    }
    const initial = this.config.admin.password;
    return Boolean(initial) && timingSafeEqual(given, digest(initial));
  }

  private isLocked(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.failures.delete(ip);
      return false;
    }
    return this.maxAttempts > 0 && entry.count >= this.maxAttempts;
  }

  private recordFailure(ip: string) {
    if (!this.maxAttempts) return;   // 제한을 껐다
    const now = this.now();
    let entry = this.failures.get(ip);
    if (!entry) {
      if (this.failures.size >= FAILURE_TABLE_MAX) this.trimFailures(now);
      entry = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
      this.failures.set(ip, entry);
    }
    entry.count += 1;
    // 한도에 닿은 때부터 1분을 다시 잰다(첫 실패에서 1분이 거의 지난 뒤에 닿아도 1분 동안 막힌다)
    if (entry.count >= this.maxAttempts) entry.resetAt = now + ATTEMPT_WINDOW_MS;
  }

  // 표가 찼을 때만 부른다: 끝난 것을 지우고, 그래도 차 있으면 가장 먼저 들어온 것부터 지운다.
  private trimFailures(now: number) {
    for (const [key, entry] of this.failures) {
      if (entry.resetAt <= now) this.failures.delete(key);
    }
    for (const key of this.failures.keys()) {
      if (this.failures.size < FAILURE_TABLE_MAX) break;
      this.failures.delete(key);
    }
  }
}
