import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { compareRational, rational, type Rational, zeroRational } from "../language/rational";

export const cutFootageSemanticRules = Object.freeze([
  "cut-rational-reduced-v1",
  "cut-rational-non-negative-v1",
  "cut-rational-positive-v1",
  "cut-half-open-range-v1",
  "cut-handles-non-negative-v1",
] as const);
export type CutFootageSemanticRule = (typeof cutFootageSemanticRules)[number];

type SemanticValidator = ((rule: unknown, value: unknown) => boolean) & { errors?: ErrorObject[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rationalValue(value: unknown): Rational | undefined {
  const item = record(value);
  if (!item || typeof item.numerator !== "string" || typeof item.denominator !== "string") return undefined;
  try {
    const reduced = rational(item.numerator, item.denominator);
    return reduced.numerator === item.numerator && reduced.denominator === item.denominator ? reduced : undefined;
  } catch { return undefined; }
}

const validateCutFootageSemantic: SemanticValidator = function validate(rule: unknown, value: unknown) {
  const fail = (message: string) => {
    validateCutFootageSemantic.errors = [{ keyword: "cutSemantic", dataPath: "", schemaPath: "", message, params: { rule } }];
    return false;
  };
  if (!cutFootageSemanticRules.includes(rule as CutFootageSemanticRule)) return fail("is not one supported CUT footage semantic rule");
  const exact = rationalValue(value);
  if (rule === "cut-rational-reduced-v1") return exact ? true : fail("must be one reduced rational");
  if (rule === "cut-rational-non-negative-v1") return exact && compareRational(exact, zeroRational) >= 0 ? true : fail("must be one non-negative reduced rational");
  if (rule === "cut-rational-positive-v1") return exact && compareRational(exact, zeroRational) > 0 ? true : fail("must be one positive reduced rational");
  const item = record(value);
  if (rule === "cut-half-open-range-v1") {
    const start = rationalValue(item?.start), end = rationalValue(item?.end);
    return start && end && compareRational(start, zeroRational) >= 0 && compareRational(end, start) > 0 ? true : fail("must be one non-negative half-open range with end after start");
  }
  const head = rationalValue(item?.head), tail = rationalValue(item?.tail);
  return head && tail && compareRational(head, zeroRational) >= 0 && compareRational(tail, zeroRational) >= 0 ? true : fail("must have non-negative reduced head and tail handles");
};

export function compileCutFootageSchema(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true, strictKeywords: true });
  ajv.addKeyword("cutSemantic", {
    errors: true,
    metaSchema: { enum: cutFootageSemanticRules },
    validate: validateCutFootageSemantic,
  });
  return ajv.compile(schema);
}
