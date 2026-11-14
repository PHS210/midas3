import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsTemperature } from "../../src/lib/evaluator/evaluateAnswer.js";

test("gpt-5·o 계열에는 temperature를 보내지 않는다", () => {
  for (const model of ["gpt-5-nano", "gpt-5.4-nano", "GPT-5", "o3-mini", "o4-mini"]) assert.equal(supportsTemperature(model), false, model);
  for (const model of ["gpt-4o-mini", "gpt-4.1"]) assert.equal(supportsTemperature(model), true, model);
});

// ── Claude 채점 ─────────────────────────────────────────────
import http from "node:http";
import { z as zv4 } from "zod/v4";
import { ClaudeEvaluationSchema } from "../../src/lib/evaluator/claudeSchema.js";
import { LlmEvaluationSchema, AXES } from "../../src/lib/evaluator/schema.js";
import {
  evaluateAnswer,
  getAnthropicEvalEffort,
  getEvalModel,
  getEvalProvider,
  supportsAnthropicFallback
} from "../../src/lib/evaluator/evaluateAnswer.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const sampleEvaluation = {
  mission_id: "m1",
  axes: Object.fromEntries(AXES.map((a) => [a, {
    score: a === "AX1" ? 3 : 0,
    confidence: 0.8,
    evidence: a === "AX1" ? [{ quote: "4주 데이터를 비교", behavior: "자료 비교", level: 3, primary_axis: "AX1", secondary_axes: [], rationale: "수치 비교" }] : [],
    reason: a === "AX1" ? "자료를 비교함" : "근거 없음"
  }])),
  flags: [],
  prompt_version: "eval-test"
};

test("Claude 스키마(zod v4)와 서버 스키마(zod v3)가 같은 모양이다", () => {
  assert.deepEqual(LlmEvaluationSchema.parse(sampleEvaluation), ClaudeEvaluationSchema.parse(sampleEvaluation));
  const json = zv4.toJSONSchema(ClaudeEvaluationSchema) as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(json.properties).sort(), Object.keys(LlmEvaluationSchema.shape).sort());
  // 한쪽만 받아들이는 값이 없는지
  const bad = { ...sampleEvaluation, flags: ["unknown_flag"] };
  assert.equal(LlmEvaluationSchema.safeParse(bad).success, false);
  assert.equal(ClaudeEvaluationSchema.safeParse(bad).success, false);
});

test("채점 AI 고르기: 설정 > Claude 키 > OpenAI 키, 모델·effort 기본값", () => {
  withEnv({ EVAL_LLM_PROVIDER: undefined, ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", ANTHROPIC_EVAL_MODEL: undefined, ANTHROPIC_EVAL_EFFORT: undefined }, () => {
    assert.equal(getEvalProvider(), "anthropic");
    assert.equal(getEvalModel(), "claude-opus-5-5");
    assert.equal(getAnthropicEvalEffort(), "medium");
  });
  withEnv({ EVAL_LLM_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "y", OPENAI_EVAL_MODEL: undefined }, () => {
    assert.equal(getEvalProvider(), "openai");
    assert.equal(getEvalModel(), "gpt-5-nano");
  });
  withEnv({ EVAL_LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "x" }, () => assert.equal(getEvalProvider(), "openai"));
  withEnv({ ANTHROPIC_EVAL_EFFORT: "high" }, () => assert.equal(getAnthropicEvalEffort(), "high"));
  withEnv({ ANTHROPIC_EVAL_EFFORT: "weird" }, () => assert.equal(getAnthropicEvalEffort(), "medium"));
  assert.equal(supportsAnthropicFallback("claude-opus-5-5"), true);
  assert.equal(supportsAnthropicFallback("claude-haiku-5-5"), false);
});

test("Claude 채점: 구조화 출력 요청을 보내고 응답을 서버 스키마로 받는다(가짜 API 서버)", async () => {
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(sampleEvaluation) }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 }
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, EVAL_LLM_PROVIDER: "anthropic", EVAL_MODE: "" });
  delete process.env.ANTHROPIC_EVAL_MODEL;
  try {
    const answer = "먼저 지난 4주 데이터를 비교하고, 어제 수치가 30% 낮은 원인을 가설로 세워 검증하겠습니다. 결과는 팀에 공유하겠습니다.";
    const result = await evaluateAnswer({
      mission: { mission_id: "m1", job_name: "데이터분석가", title: "점검", scenario: "상황", task: "과제", axis_signals: { AX1: 1, AX2: 0, AX3: 0, AX4: 0, AX5: 0 } } as never,
      answer
    });
    assert.equal(requests.length, 1);
    const { headers, body } = requests[0];
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.output_config.effort, "medium");
    assert.equal(body.fallbacks, "default");
    assert.match(String(headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal(body.temperature, undefined);
    assert.ok(typeof body.system === "string" && body.system.length > 0);
    assert.equal(result.evaluation.source, "llm");
    assert.equal(result.evaluation.model, "claude-opus-5-5");
    assert.equal(result.evaluation.axes.AX1.score, 3);
  } finally {
    process.env = saved;
    server.close();
  }
});
