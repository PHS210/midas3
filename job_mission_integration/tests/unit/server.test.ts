import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startTestServer } from "./helpers/testServer.js";
import { pythonSpawnEnv } from "../../src/lib/adminGeneration/commands.js";

const MISSION_KEY = "jobsim_service_v1__mission_K000001080_easy_001";
const GOOD_ANSWER = "3월을 색으로 강조해야 합니다. 2월 49,000명에서 3월 41,000명으로 8,000명 줄어 전월 대비 감소폭이 가장 크니, 차트의 수치부터 다시 확인하겠습니다.";

test("공통: /health에 DB 상태, 없는 API는 같은 오류 형식", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const health = await c.get("/health");
    assert.equal(health.json.database.ok, true);
    assert.ok(health.json.database.schema_version >= 1);
    const missing = await c.get("/api/nothing-here");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, "NOT_FOUND");
    const badJson = await c.request("POST", "/api/attempts", undefined, { "Content-Type": "application/json" });
    assert.ok([400].includes(badJson.status));
    const raw = await fetch(`${srv.base}/api/attempts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error.code, "BAD_JSON");
  } finally {
    await srv.close();
  }
});

test("공통: 다른 사이트에서 온 상태 변경 요청은 막는다", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const blocked = await c.post("/api/attempts", { job_codes: ["K000001080"] }, { Origin: "http://evil.example" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, "ORIGIN_NOT_ALLOWED");
    const allowed = await c.post("/api/attempts", { job_codes: ["K000001080"] }, { Origin: srv.base });
    assert.equal(allowed.status, 201);
  } finally {
    await srv.close();
  }
});

test("관리자 API: 암호가 없으면 열리지 않고, 시연 잠금 해제는 조회만 허용", async () => {
  const noPassword = await startTestServer({ configure: (c) => { c.admin.password = ""; c.admin.demoUnlock = false; } });
  try {
    const res = await new Client(noPassword.base).get("/api/admin/mission-generation/jobs");
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "ADMIN_PASSWORD_NOT_SET");
  } finally {
    await noPassword.close();
  }
  const demo = await startTestServer({ configure: (c) => { c.admin.password = "pw"; c.admin.demoUnlock = true; } });
  try {
    const c = new Client(demo.base);
    assert.equal((await c.get("/api/admin/mission-generation/jobs")).status, 200);
    const gen = await c.post("/api/admin/mission-generation/runs", { jobCode: "K000001080", execJobId: "exec_001", unitKey: "20010107:03", difficulty: "easy", review: true });
    assert.equal(gen.status, 401);
    assert.equal((await c.get("/api/admin/postings/status")).status, 401);
    assert.equal((await c.request("GET", "/api/admin/postings/status", undefined, { "x-api-token": "pw" })).status, 200);
  } finally {
    await demo.close();
  }
});

test("체험 기록: 브라우저에 묶이고, 제출한 미션의 해설만 그 브라우저에서 열린다", async () => {
  const srv = await startTestServer();
  const anon = new Client(srv.base);
  try {
    const attempt = (await anon.post("/api/attempts", { job_codes: ["K000001080"], pre_answers: { K000001080: { q1: "데이터 정리" } } })).json.attempt;
    assert.ok(attempt.id);
    const locked = await anon.get(`/api/missions/${MISSION_KEY}/explanation?attempt_id=${attempt.id}`);
    assert.equal(locked.status, 403);
    assert.equal(locked.json.error.code, "EXPLANATION_LOCKED");

    const evaluated = await anon.post("/api/evaluate", { mission_key: MISSION_KEY, answer: GOOD_ANSWER, attempt_id: attempt.id });
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.json.scoring.mode, "fake");
    assert.equal(evaluated.json.scoring.server_mission, true);
    assert.ok(evaluated.json.attempt_mission_id);
    assert.equal(evaluated.json.evaluation.source, "fake");
    const quotes = Object.values(evaluated.json.evaluation.axes).flatMap((axis: any) => axis.evidence.map((e: any) => e.quote));
    assert.ok(quotes.every((q: string) => GOOD_ANSWER.includes(q)));

    const opened = await anon.get(`/api/missions/${MISSION_KEY}/explanation?attempt_id=${attempt.id}`);
    assert.equal(opened.status, 200);
    assert.ok(opened.json.rubric.length > 0);
    // 다른 브라우저는 열 수 없다
    assert.equal((await new Client(srv.base).get(`/api/missions/${MISSION_KEY}/explanation?attempt_id=${attempt.id}`)).status, 404);
    // 로그인·내 기록 API는 없다
    assert.equal((await anon.get("/api/auth/session")).status, 404);
    assert.equal((await anon.get("/api/me/summary")).status, 404);
    assert.equal((await anon.get(`/api/attempts/${attempt.id}`)).status, 404);
  } finally {
    await srv.close();
  }
});

test("채점: 서버에 없는 미션은 거절하고, 남의 기록에는 저장하지 않는다", async () => {
  const srv = await startTestServer();
  try {
    const a = new Client(srv.base);
    const b = new Client(srv.base);
    assert.equal((await a.post("/api/evaluate", { mission_key: "nope", answer: GOOD_ANSWER })).status, 404);
    const attempt = (await a.post("/api/attempts", { job_codes: ["K000001080"] })).json.attempt;
    const stolen = await b.post("/api/evaluate", { mission_key: MISSION_KEY, answer: GOOD_ANSWER, attempt_id: attempt.id });
    assert.equal(stolen.status, 404);
  } finally {
    await srv.close();
  }
});

test("직무 API: 537개 목록, 상세의 비슷한 직무와 체험 가능 여부, 강점 축", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const list = await c.get("/api/jobs");
    assert.equal(list.json.total, 537);
    assert.equal(list.json.fields.length, 10);
    assert.equal(list.json.experienceable.length, 50); // 카탈로그의 직업 50개(직업마다 쉬움·보통·어려움 미션 하나씩)
    const detail = await c.get("/api/jobs/K000001080");
    assert.equal(detail.json.job.experienceable, true);
    assert.ok(detail.json.job.missions.length >= 1);
    assert.equal(detail.json.job.similar.length, 6);
    assert.ok(detail.json.job.similar[0].common.length > 0);
    // 고정 데이터 모드인데 스냅샷을 아직 만들지 않아 error
    assert.equal(detail.json.job.postings_status, "error");
    assert.equal((await c.get("/api/jobs/K000000824")).json.job.experienceable, false);
    assert.equal((await c.get("/api/jobs/K12")).status, 400);
    assert.equal((await c.get("/api/jobs/K999999999")).status, 404);
    // 비교 기능은 없다(직무 상세 경로의 잘못된 코드로 처리됨)
    assert.equal((await c.get("/api/jobs/compare?codes=K000001080,K000000872")).status, 400);
    const byAxis = await c.get("/api/jobs/by-axis/AX1");
    assert.ok(byAxis.json.jobs.length > 0);
    assert.equal((await c.get("/api/jobs/by-axis/AX9")).status, 400);
  } finally {
    await srv.close();
  }
});

test("결과 요약: 추천 계산 대상이 아닌 직업(정보보안전문가)도 체험한 직업의 적합도와 분석 기준이 나온다", async () => {
  const srv = await startTestServer();
  const c = new Client(srv.base);
  try {
    const body = (code: string) => ({ selectedJobs: [code], missionScoresByJob: { [code]: [{ AX1: 0.9, AX2: 0.6, AX3: 0.5, AX4: 0.5, AX5: 0.3 }] } });
    const outside = await c.post("/api/recommendations", body("K000000832"));
    assert.equal(outside.status, 200);
    assert.ok(outside.json.compatibility.K000000832 > 0, `적합도 ${outside.json.compatibility.K000000832}`);
    assert.equal(outside.json.selectedJobMeta.K000000832.referenceJobName, "정보보안전문가");
    assert.match(outside.json.jobInsights.K000000832.detail, /^정보보안전문가 미션 1개 기준/);
    // 묶음 C1에는 추천 계산 대상 직업이 없어 비슷한 직업 추천은 비어 있다
    assert.deepEqual(outside.json.recommendations.K000000832, []);

    // 대상 직업(데이터분석가)은 지금처럼 비슷한 직업 3개가 나온다
    const inside = await c.post("/api/recommendations", body("K000001080"));
    assert.equal(inside.json.recommendations.K000001080.length, 3);
  } finally {
    await srv.close();
  }
});

test("관리자 생성 경로는 Python을 Claude로 고정해 부른다", () => {
  const env = pythonSpawnEnv({ MISSION_LLM_PROVIDER: "openai", PATH: "x" });
  assert.equal(env.MISSION_LLM_PROVIDER, "anthropic");
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.PYTHONUNBUFFERED, "1");
  assert.equal(env.PATH, "x");
});
