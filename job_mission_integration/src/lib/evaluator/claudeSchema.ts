// Claude 구조화 출력용 채점 스키마. Anthropic SDK의 zod 도우미가 zod v4 스키마를 받기 때문에
// schema.ts의 LlmEvaluationSchema(zod v3)와 같은 모양을 zod/v4로 다시 적는다.
// 두 스키마가 어긋나지 않는지는 tests/unit/evaluator.test.ts가 확인한다.
import * as z from "zod/v4";

const AXES = ["AX1", "AX2", "AX3", "AX4", "AX5"] as const;
const AxisSchema = z.enum(AXES);

const EvidenceSchema = z.object({
  quote: z.string().min(1).describe("Short exact or near-exact evidence from the answer."),
  behavior: z.string().min(1).describe("Observed behavior represented by the quote."),
  level: z.number().int().min(1).max(4),
  primary_axis: AxisSchema,
  secondary_axes: z.array(AxisSchema).max(2),
  rationale: z.string().min(1).describe("Brief reason grounded in the quote.")
});

const AxisResultSchema = z.object({
  score: z.number().int().min(0).max(4),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema),
  reason: z.string()
});

export const ClaudeEvaluationSchema = z.object({
  mission_id: z.string(),
  axes: z.object({
    AX1: AxisResultSchema,
    AX2: AxisResultSchema,
    AX3: AxisResultSchema,
    AX4: AxisResultSchema,
    AX5: AxisResultSchema
  }),
  flags: z.array(z.enum([
    "too_short",
    "off_topic",
    "ambiguous",
    "low_confidence",
    "possible_prompt_injection"
  ])),
  prompt_version: z.string()
});
