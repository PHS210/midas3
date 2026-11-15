import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/lib/db/database.js";
import { AdminAuth } from "../../src/server/adminAuth.js";
import { loadServerConfig } from "../../src/server/config.js";
import { Client, startTestServer } from "./helpers/testServer.js";

// 관리자 암호: 처음 암호(설정 파일), 화면에서 바꾸기, 되돌리기, 틀린 암호 제한.

const MAX = 10;   // 같은 IP에서 1분 동안 받는 틀린 암호의 수(기본값)
const configWith = (env: Record<string, string>) => loadServerConfig(env as NodeJS.ProcessEnv);
const codeOf = (fn: () => void) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

test("관리자 암호: 처음에는 설정 값, 바꾸면 새 암호만 통하고 서버를 다시 켜도 유지된다", () => {
  const db = openDatabase(":memory:");
  const auth = new AdminAuth({ db, config: configWith({ ADMIN_PASSWORD: "first1" }) });
  assert.equal(auth.hasPassword(), true);
  assert.deepEqual([auth.attempt("a", "first1"), auth.attempt("a", "nope")], ["ok", "wrong"]);

  auth.changePassword("a", "first1", "next2");
  assert.deepEqual([auth.attempt("b", "next2"), auth.attempt("b", "first1")], ["ok", "wrong"]);
  // DB에는 암호가 그대로 들어 있지 않다
  const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password_hash'").get() as { value: string };
  assert.ok(stored.value.startsWith("scrypt$") && !stored.value.includes("next2"));

  // 다시 켜도(같은 DB, 새 객체) 바꾼 암호가 통한다. 설정 파일의 값이 달라져도 화면에서 바꾼 암호가 이긴다
  const again = new AdminAuth({ db, config: configWith({ ADMIN_PASSWORD: "other3" }) });
  assert.deepEqual([again.attempt("c", "next2"), again.attempt("c", "other3"), again.attempt("c", "first1")], ["ok", "wrong", "wrong"]);

  // 암호가 어디에도 없으면 없다고 답한다
  assert.equal(new AdminAuth({ db: openDatabase(":memory:"), config: configWith({}) }).hasPassword(), false);
});

test("암호 바꾸기 거절: 지금 암호가 틀림, 4자 미만, 같은 암호, 공백이나 한글", () => {
  const auth = new AdminAuth({ db: openDatabase(":memory:"), config: configWith({ ADMIN_PASSWORD: "first1" }) });
  assert.equal(codeOf(() => auth.changePassword("a", "wrong", "next2")), "ADMIN_PASSWORD_WRONG");
  assert.equal(codeOf(() => auth.changePassword("a", "first1", "abc")), "ADMIN_PASSWORD_INVALID");
  assert.equal(codeOf(() => auth.changePassword("a", "first1", "first1")), "ADMIN_PASSWORD_SAME");
  assert.equal(codeOf(() => auth.changePassword("a", "first1", "ab cd")), "ADMIN_PASSWORD_INVALID");
  assert.equal(codeOf(() => auth.changePassword("a", "first1", "암호암호")), "ADMIN_PASSWORD_INVALID");
  assert.equal(codeOf(() => auth.changePassword("a", "first1", "x".repeat(101))), "ADMIN_PASSWORD_INVALID");
  assert.equal(auth.attempt("a", "first1"), "ok");   // 거절된 뒤에도 암호는 그대로다
  assert.equal(codeOf(() => auth.changePassword("a", "first1", "abcd")), "ok");   // 4자는 된다
  assert.deepEqual([auth.attempt("a", "abcd"), auth.attempt("a", "first1")], ["ok", "wrong"]);
});

test("되돌리기 설정: 켜고 서버를 켜면 처음 암호로 돌아가고, 켜져 있는 동안은 바꿀 수 없다", () => {
  const db = openDatabase(":memory:");
  new AdminAuth({ db, config: configWith({ ADMIN_PASSWORD: "first1" }) }).changePassword("a", "first1", "next2");
  const logs: string[] = [];
  const reset = new AdminAuth({ db, config: configWith({ ADMIN_PASSWORD: "first1", ADMIN_PASSWORD_RESET: "true" }), log: (m) => logs.push(m) });
  assert.deepEqual([reset.attempt("a", "first1"), reset.attempt("a", "next2")], ["ok", "wrong"]);
  assert.equal(logs.length, 1);
  assert.equal(codeOf(() => reset.changePassword("a", "first1", "next3")), "ADMIN_PASSWORD_RESET_ON");
  // 설정을 지우고 다시 켜면 처음 암호 그대로이고 다시 바꿀 수 있다
  const after = new AdminAuth({ db, config: configWith({ ADMIN_PASSWORD: "first1" }) });
  assert.equal(codeOf(() => after.changePassword("a", "first1", "next3")), "ok");
});

test("틀린 암호를 1분에 10번 넣으면 그 IP는 맞는 암호도 막히고, 1분이 지나면 풀린다", () => {
  let now = 1_000_000;
  const auth = new AdminAuth({ db: openDatabase(":memory:"), config: configWith({ ADMIN_PASSWORD: "first1" }), now: () => now });
  for (let i = 0; i < MAX - 1; i += 1) assert.equal(auth.attempt("1.1.1.1", `bad${i}`), "wrong");
  assert.equal(auth.attempt("1.1.1.1", "first1"), "ok");   // 9번까지는 맞는 암호가 통한다
  assert.equal(auth.attempt("1.1.1.1", "bad-last"), "wrong");
  assert.equal(auth.attempt("1.1.1.1", "first1"), "locked");
  assert.equal(codeOf(() => auth.changePassword("1.1.1.1", "first1", "next2")), "ADMIN_TOO_MANY_ATTEMPTS");
  const wait = auth.retryAfterSec("1.1.1.1");
  assert.ok(wait > 0 && wait <= 60, String(wait));
  assert.equal(auth.attempt("2.2.2.2", "first1"), "ok");   // 다른 IP는 영향이 없다
  now += 60_001;
  assert.equal(auth.attempt("1.1.1.1", "first1"), "ok");
  // 암호 바꾸기 창에서 지금 암호를 틀린 것도 한 번으로 센다
  for (let i = 0; i < MAX; i += 1) assert.equal(codeOf(() => auth.changePassword("3.3.3.3", "bad", "next2")), "ADMIN_PASSWORD_WRONG");
  assert.equal(auth.attempt("3.3.3.3", "first1"), "locked");
});

test("경로: 바꾸면 예전 암호는 관리자 생성과 채용공고 경로에서 모두 막히고 새 암호가 통한다", async () => {
  const srv = await startTestServer({ configure: (c) => { c.admin.password = "first1"; } });
  try {
    const c = new Client(srv.base);
    const old = { "x-api-token": "first1" };
    const neu = { "x-api-token": "next2" };
    const status = (headers?: Record<string, string>) => c.request("GET", "/api/admin/mission-generation/status", undefined, headers);
    const change = (body: unknown, headers?: Record<string, string>) => c.request("POST", "/api/admin/password", body, headers);
    assert.equal((await status(old)).status, 200);

    // 암호 없이는 못 바꾼다. 지금 암호가 틀려도, 모양이 틀려도 못 바꾼다
    assert.equal((await change({ currentPassword: "first1", newPassword: "next2" })).status, 401);
    const wrong = await change({ currentPassword: "zzzz", newPassword: "next2" }, old);
    assert.deepEqual([wrong.status, wrong.json.error.code], [403, "ADMIN_PASSWORD_WRONG"]);
    assert.equal((await change({ currentPassword: "first1" }, old)).status, 400);
    assert.equal((await status(old)).status, 200);

    const changed = await change({ currentPassword: "first1", newPassword: "next2" }, old);
    assert.deepEqual([changed.status, changed.json], [200, { ok: true }]);
    assert.deepEqual([(await status(old)).status, (await status(neu)).status], [401, 200]);
    const postings = (headers: Record<string, string>) => c.request("GET", "/api/admin/postings/status", undefined, headers);
    assert.deepEqual([(await postings(old)).status, (await postings(neu)).status], [401, 200]);
    assert.equal((await c.get("/health")).json.admin_lock_enabled, true);

    // 틀린 암호가 10번이 되면 맞는 암호도 429를 받는다(세는 것: 위의 zzzz와 아래 9번. 바로 앞 암호로 보낸 2번은 세지 않는다)
    for (let i = 0; i < MAX - 2; i += 1) assert.equal((await status({ "x-api-token": `bad${i}` })).status, 401);
    assert.equal((await status(neu)).status, 200);
    await status({ "x-api-token": "bad-last" });
    const locked = await status(neu);
    assert.deepEqual([locked.status, locked.json.error.code], [429, "ADMIN_TOO_MANY_ATTEMPTS"]);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
  } finally {
    await srv.close();
  }
});

test("경로: 조회만 열린 상태에서는 암호 없이 읽을 수 있어도 암호를 바꿀 수 없다", async () => {
  const srv = await startTestServer({ configure: (c) => { c.admin.password = "first1"; c.admin.demoUnlock = true; } });
  try {
    const c = new Client(srv.base);
    assert.equal((await c.request("GET", "/api/admin/mission-generation/status")).status, 200);
    assert.equal((await c.request("POST", "/api/admin/password", { currentPassword: "first1", newPassword: "next2" })).status, 401);
    assert.equal((await c.request("GET", "/api/admin/mission-generation/status", undefined, { "x-api-token": "first1" })).status, 200);
  } finally {
    await srv.close();
  }
});

test("암호를 두 번 바꾸면 처음 바꾼 암호도 막힌다", () => {
  const auth = new AdminAuth({ db: openDatabase(":memory:"), config: configWith({ ADMIN_PASSWORD: "first1" }) });
  auth.changePassword("a", "first1", "next2");
  assert.equal(auth.attempt("a", "next2"), "ok");
  auth.changePassword("a", "next2", "third3");
  assert.deepEqual([auth.attempt("b", "third3"), auth.attempt("b", "next2"), auth.attempt("b", "first1")], ["ok", "wrong", "wrong"]);
});

test("저장된 해시가 깨져 있으면 어떤 암호도 받지 않는다", () => {
  for (const broken of ["scrypt$ab$zz", "scrypt$00112233445566778899aabbccddeeff$ab", "scrypt$$", "plain"]) {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO admin_settings (key, value, updated_at) VALUES ('admin_password_hash', ?, '2026-01-01T00:00:00.000Z')").run(broken);
    const auth = new AdminAuth({ db, config: configWith({ ADMIN_PASSWORD: "first1" }) });
    assert.deepEqual([auth.attempt("a", "anything"), auth.attempt("a", "first1"), auth.attempt("a", "")], ["wrong", "wrong", "wrong"], broken);
  }
});

test("틀린 횟수: 바로 앞 암호는 세지 않고, 10번째에서 1분을 다시 재며, 0이면 제한이 꺼진다", () => {
  let now = 1_000_000;
  const auth = new AdminAuth({ db: openDatabase(":memory:"), config: configWith({ ADMIN_PASSWORD: "first1" }), now: () => now });
  // 암호를 바꾼 직후 예전 암호로 오는 요청(다른 창, 다른 사람)은 틀렸다고 답하되 횟수에 넣지 않는다
  auth.changePassword("a", "first1", "next2");
  for (let i = 0; i < MAX + 3; i += 1) assert.equal(auth.attempt("a", "first1"), "wrong");
  assert.equal(auth.attempt("a", "next2"), "ok");

  // 6초 간격으로 10번 틀리면(0초 ~ 54초), 첫 번째에서 1분이 지나도 10번째부터 1분 동안 막힌다
  for (let i = 0; i < MAX; i += 1) {
    assert.equal(auth.attempt("b", `bad${i}`), "wrong");
    now += 6_000;
  }
  now += 5_000;   // 첫 실패에서 65초, 10번째 실패에서 11초
  assert.equal(auth.attempt("b", "next2"), "locked");
  now += 50_000;  // 10번째 실패에서 61초
  assert.equal(auth.attempt("b", "next2"), "ok");

  const off = new AdminAuth({ db: openDatabase(":memory:"), config: configWith({ ADMIN_PASSWORD: "first1", ADMIN_PASSWORD_MAX_ATTEMPTS: "0" }) });
  for (let i = 0; i < MAX * 2; i += 1) assert.equal(off.attempt("c", `bad${i}`), "wrong");
  assert.equal(off.attempt("c", "first1"), "ok");
});

test("경로: X-Forwarded-For를 바꿔 가며 보내도 틀린 횟수를 피하지 못한다", async () => {
  const srv = await startTestServer({ configure: (c) => { c.admin.password = "first1"; } });
  try {
    const c = new Client(srv.base);
    const status = (token: string, forwarded: string) =>
      c.request("GET", "/api/admin/mission-generation/status", undefined, { "x-api-token": token, "x-forwarded-for": forwarded });
    for (let i = 0; i < MAX; i += 1) assert.equal((await status(`bad${i}`, `10.0.0.${i + 1}`)).status, 401);
    assert.equal((await status("first1", "10.0.0.99")).status, 429);
  } finally {
    await srv.close();
  }
});
