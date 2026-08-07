import type { IRValue } from "./ir";
import { CutTableQueryError, validateCutTableQueryPlan } from "./table-query";

/** Decode the public, closed table-plan IR representation without accepting
 * deferred calls, host objects, JSON strings, or resource paths. Schema byte
 * limits and the plan version are integer controls; authored numeric cells
 * remain exact rational values. */
function hostValue(value: IRValue, path: string): unknown {
  if (value.kind === "string" || value.kind === "boolean") return value.value;
  if (value.kind === "array") return value.items.map((item, index) => hostValue(item, `${path}[${index}]`));
  if (value.kind === "object") return Object.fromEntries(Object.entries(value.entries).map(([name, item]) => [name, hostValue(item, `${path}.${name}`)]));
  if (value.kind === "quantity" && value.dimension === "scalar" && value.unit === "scalar") {
    if (path === "$.version" || path.endsWith(".maxBytes")) {
      if (value.magnitude.denominator !== "1") throw new CutTableQueryError("CUT_TABLE_SCHEMA_LIMIT", path, "must be a whole Number");
      const integer = Number(value.magnitude.numerator);
      if (!Number.isSafeInteger(integer)) throw new CutTableQueryError("CUT_TABLE_SCHEMA_LIMIT", path, "must be a safe whole Number");
      return integer;
    }
    return Object.freeze({ ...value.magnitude });
  }
  throw new CutTableQueryError("CUT_QUERY_PLAN_TYPE", path, `contains unsupported typed IR value ${value.kind}`);
}

/** Validate and type one table query embedded in CutAVIR. The returned plan is
 * canonical, deeply immutable, and safe to share between inspect, cache, and
 * the reference runtime. */
export function cutTableQueryPlanFromIr(value: IRValue) {
  return validateCutTableQueryPlan(hostValue(value, "$"));
}
