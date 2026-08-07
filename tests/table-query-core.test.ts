import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CutTableQueryError,
  cutTableRowKeyIdentity,
  evaluateCutTableQuery,
  loadCutTableFromLockedResource,
  validateCutTableQueryPlan,
  type CutLockedTableInput,
  type CutTableQueryErrorCode,
} from "../lib/language/table-query";

type Json = null | boolean | number | string | Json[] | { [name: string]: Json };

function exact(numerator: string | number, denominator: string | number = 1) {
  return { numerator: String(numerator), denominator: String(denominator) };
}

const salesSchema = {
  fields: [
    { name: "id", type: { kind: "string", maxBytes: 16 } },
    { name: "region", type: { kind: "string", maxBytes: 16 } },
    { name: "day", type: { kind: "date" } },
    { name: "active", type: { kind: "boolean" } },
    { name: "amount", type: { kind: "number" } },
  ],
  key: ["id"],
};

const regionsSchema = {
  fields: [
    { name: "code", type: { kind: "string", maxBytes: 16 } },
    { name: "label", type: { kind: "string", maxBytes: 32 } },
    { name: "rank", type: { kind: "number" } },
  ],
  key: ["code"],
};

function table(schema: Json, rows: Json[]): Json {
  return { format: "cut-table", version: 1, schema, rows };
}

const sales = table(salesSchema as Json, [
  { id: "s1", region: "north", day: "2024-02-29", active: true, amount: exact(5, 2) },
  { id: "s2", region: "south", day: "2024-03-01", active: true, amount: exact(3) },
  { id: "s3", region: "north", day: "2024-03-02", active: false, amount: exact(1, 2) },
  { id: "s4", region: "north", day: "2024-03-03", active: true, amount: exact(7, 2) },
] as Json[]);

const regions = table(regionsSchema as Json, [
  { code: "south", label: "South", rank: exact(2) },
  { code: "north", label: "North", rank: exact(1) },
] as Json[]);

function lockedBytes(id: string, bytes: Uint8Array): CutLockedTableInput {
  return {
    resource: {
      id,
      kind: "data",
      state: "locked",
      lockVersion: 2,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    },
    bytes,
  };
}

function locked(id: string, document: Json): CutLockedTableInput {
  return lockedBytes(id, Buffer.from(JSON.stringify(document), "utf8"));
}

function expectError(
  operation: () => unknown,
  code: CutTableQueryErrorCode,
  path?: string | RegExp,
  message?: RegExp,
) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CutTableQueryError, String(error));
    assert.equal(error.code, code);
    if (typeof path === "string") assert.equal(error.path, path);
    else if (path) assert.match(error.path, path);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function queryPlan(result = "ordered") {
  return {
    format: "cut-query-plan",
    version: 1,
    sources: [
      { name: "sales", resourceId: "sales_data", schema: salesSchema },
      { name: "regions", resourceId: "region_data", schema: regionsSchema },
    ],
    steps: [
      {
        id: "active_sales",
        op: "filter",
        input: "sales",
        where: { op: "compare", field: "active", operator: "eq", value: true },
      },
      {
        id: "labeled_sales",
        op: "inner-join",
        left: "active_sales",
        right: "regions",
        on: [{ left: "region", right: "code" }],
        select: [
          { from: "left", field: "id", as: "sale_id" },
          { from: "left", field: "day", as: "day" },
          { from: "left", field: "amount", as: "amount" },
          { from: "right", field: "label", as: "category" },
        ],
        key: ["sale_id"],
      },
      {
        id: "by_category",
        op: "group",
        input: "labeled_sales",
        by: [{ field: "category", as: "category" }],
      },
      {
        id: "summary",
        op: "aggregate",
        input: "by_category",
        values: [
          { as: "total", function: "sum", field: "amount" },
          { as: "average", function: "mean", field: "amount" },
          { as: "rows", function: "count" },
          { as: "first_day", function: "min", field: "day" },
          { as: "last_day", function: "max", field: "day" },
        ],
      },
      {
        id: "ordered",
        op: "sort",
        input: "summary",
        by: [{ field: "total", direction: "desc" }],
      },
      {
        id: "plot_series",
        op: "series",
        input: "ordered",
        x: "category",
        values: [
          { field: "total", as: "total" },
          { field: "average", as: "average" },
          { field: "rows", as: "rows" },
        ],
      },
    ],
    result,
  };
}

function resources() {
  return [locked("sales_data", sales), locked("region_data", regions)];
}

test("strict cut-table v1 retains exact cells, source order, byte identity, and frozen values", () => {
  const input = locked("sales_data", sales);
  const loaded = loadCutTableFromLockedResource(input);
  assert.equal(loaded.format, "cut-source-table");
  assert.match(loaded.id, /^[a-f0-9]{64}$/u);
  assert.match(loaded.schemaId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(loaded.rows.map((row) => row.id), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(loaded.rows[0].amount, exact(5, 2));
  assert.equal(typeof loaded.rows[0].amount, "object", "authoritative exact numbers never become JS number cells");
  assert.equal(loaded.rows[0].day, "2024-02-29");
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.rows[0]));
  assert.equal(loadCutTableFromLockedResource(input).id, loaded.id);

  const semanticallySameDifferentBytes = lockedBytes(
    "sales_data",
    Buffer.from(`${JSON.stringify(sales, null, 2)}\n`, "utf8"),
  );
  assert.notEqual(loadCutTableFromLockedResource(semanticallySameDifferentBytes).id, loaded.id, "source identity binds locked bytes, not only parsed semantics");

  const unicodeSchema = { fields: [{ name: "id", type: { kind: "string", maxBytes: 8 } }], key: ["id"] };
  const composed = "é", decomposed = "e\u0301";
  const unicode = loadCutTableFromLockedResource(locked("unicode", table(unicodeSchema as Json, [{ id: composed }, { id: decomposed }] as Json[])));
  assert.deepEqual(unicode.rows.map((row) => row.id), [composed, decomposed]);
  assert.notEqual(unicode.rows[0].id, unicode.rows[1].id, "CUT preserves authored Unicode bytes/code points and performs no normalization");
});

test("composite key identities are type-tagged and length-safe rather than delimiter-concatenated", () => {
  const stringSchema = {
    fields: [{ name: "a", type: { kind: "string", maxBytes: 16 } }, { name: "b", type: { kind: "string", maxBytes: 16 } }],
    key: ["a", "b"],
  } as const;
  assert.notEqual(
    cutTableRowKeyIdentity(stringSchema, { a: "a", b: "b|c" }),
    cutTableRowKeyIdentity(stringSchema, { a: "a|b", b: "c" }),
  );
  assert.notEqual(
    cutTableRowKeyIdentity({ fields: [{ name: "a", type: { kind: "string", maxBytes: 16 } }], key: ["a"] }, { a: "1" }),
    cutTableRowKeyIdentity({ fields: [{ name: "a", type: { kind: "number" } }], key: ["a"] }, { a: exact(1) }),
  );
});

test("typed filter, join, group, exact aggregate, stable sort, and series return proved rows and cells", () => {
  const checked = validateCutTableQueryPlan(queryPlan());
  assert.equal(checked.output.kind, "table");
  assert.match(checked.id, /^[a-f0-9]{64}$/u);
  const result = evaluateCutTableQuery(queryPlan(), resources());
  assert.equal(result.kind, "table");
  if (result.kind !== "table") return;
  assert.deepEqual(result.schema.key, ["category"]);
  assert.deepEqual(result.rows.map((row) => ({ ...row })), [
    {
      category: "North",
      total: exact(6),
      average: exact(3),
      rows: exact(2),
      first_day: "2024-02-29",
      last_day: "2024-03-03",
    },
    {
      category: "South",
      total: exact(3),
      average: exact(3),
      rows: exact(1),
      first_day: "2024-03-01",
      last_day: "2024-03-01",
    },
  ]);
  assert.equal(typeof result.rows[0].total, "object");
  assert.match(result.id, /^[a-f0-9]{64}$/u);

  const series = evaluateCutTableQuery(queryPlan("plot_series"), resources());
  assert.equal(series.kind, "series");
  if (series.kind !== "series") return;
  assert.deepEqual(series.schema.key.map((field) => field.name), ["category"]);
  assert.deepEqual(series.points.map((point) => ({ key: { ...point.key }, x: point.x, values: { ...point.values } })), [
    { key: { category: "North" }, x: "North", values: { total: exact(6), average: exact(3), rows: exact(2) } },
    { key: { category: "South" }, x: "South", values: { total: exact(3), average: exact(3), rows: exact(1) } },
  ]);
});

test("plan typing is closed and fails unknown fields, references, conflicts, and type errors before resource access", () => {
  const unknown = structuredClone(queryPlan());
  (unknown.steps[0] as unknown as Record<string, unknown>).javascript = "eval";
  expectError(
    () => evaluateCutTableQuery(unknown, "not resources"),
    "CUT_QUERY_PLAN_UNKNOWN_FIELD",
    "$.plan.steps[0].javascript",
  );

  const forward = structuredClone(queryPlan());
  forward.steps[0].input = "future_step";
  expectError(() => validateCutTableQueryPlan(forward), "CUT_QUERY_PLAN_REFERENCE", "$.steps[0].input");

  const conflict = structuredClone(queryPlan());
  const join = conflict.steps[1] as typeof conflict.steps[number] & { select: Array<{ from: string; field: string; as: string }> };
  join.select[1].as = "sale_id";
  expectError(() => validateCutTableQueryPlan(conflict), "CUT_QUERY_SCHEMA_CONFLICT", "$.steps[1].select[1].as");

  const typeMismatch = structuredClone(queryPlan());
  const mismatchJoin = typeMismatch.steps[1] as typeof typeMismatch.steps[number] & { on: Array<{ left: string; right: string }> };
  mismatchJoin.on[0].right = "rank";
  expectError(() => validateCutTableQueryPlan(typeMismatch), "CUT_QUERY_PLAN_TYPE_ERROR", "$.steps[1].on[0].right");

  const badAggregate = structuredClone(queryPlan());
  const aggregate = badAggregate.steps[3] as typeof badAggregate.steps[number] & { values: Array<{ as: string; function: string; field?: string }> };
  aggregate.values[0].field = "day";
  expectError(() => validateCutTableQueryPlan(badAggregate), "CUT_QUERY_PLAN_TYPE_ERROR", "$.steps[3].values[0].field");

  const unknownPredicateField = structuredClone(queryPlan());
  const filter = unknownPredicateField.steps[0] as typeof unknownPredicateField.steps[number] & { where: { field: string } };
  filter.where.field = "missing";
  expectError(() => validateCutTableQueryPlan(unknownPredicateField), "CUT_QUERY_PLAN_FIELD", "$.steps[0].where.field");

  const floatLiteral = structuredClone(queryPlan());
  floatLiteral.steps[0].where = { op: "compare", field: "amount", operator: "gt", value: 0.1 } as unknown as typeof floatLiteral.steps[0]["where"];
  expectError(() => validateCutTableQueryPlan(floatLiteral), "CUT_TABLE_CELL_TYPE", "$.steps[0].where.value");
});

test("strict scanner rejects duplicate decoded keys, malformed UTF-8, and bounded JSON before ordinary parsing", () => {
  const duplicate = Buffer.from(
    '{"format":"cut-table","version":1,"schema":{"fields":[{"name":"id","type":{"kind":"string","maxBytes":8}}],"key":["id"]},"rows":[{"id":"a","\\u0069d":"b"}]}',
    "utf8",
  );
  expectError(
    () => loadCutTableFromLockedResource(lockedBytes("duplicate", duplicate)),
    "CUT_TABLE_JSON_DUPLICATE_KEY",
    "$.table.rows[0].id",
  );

  const malformed = Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  expectError(
    () => loadCutTableFromLockedResource(lockedBytes("malformed", malformed)),
    "CUT_TABLE_JSON_ENCODING",
    "$.table",
  );

  expectError(
    () => loadCutTableFromLockedResource(locked("bounded", sales), { limits: { maxJsonNodes: 4 } }),
    "CUT_TABLE_JSON_LIMIT",
    /^\$\.table/u,
    /maxJsonNodes=4/u,
  );
});

test("schema, rows, exact numbers, string bytes, and Gregorian dates fail at exact paths", () => {
  const unknownRoot = structuredClone(sales) as Record<string, Json>;
  unknownRoot.private = true;
  expectError(() => loadCutTableFromLockedResource(locked("unknown", unknownRoot)), "CUT_TABLE_UNKNOWN_FIELD", "$.table.private");

  const unsafeField = structuredClone(sales) as { schema: { fields: Array<{ name: string }> } };
  unsafeField.schema.fields[0].name = "bad field";
  expectError(() => loadCutTableFromLockedResource(locked("unsafe", unsafeField as unknown as Json)), "CUT_TABLE_SCHEMA_NAME", "$.table.schema.fields[0].name");

  const unknownCell = structuredClone(sales) as { rows: Array<Record<string, Json>> };
  unknownCell.rows[0].extra = true;
  expectError(() => loadCutTableFromLockedResource(locked("cell_extra", unknownCell as unknown as Json)), "CUT_TABLE_ROW_FIELD", "$.table.rows[0].extra");

  const noncanonical = structuredClone(sales) as { rows: Array<{ amount: { numerator: string; denominator: string } }> };
  noncanonical.rows[0].amount = exact(2, 2);
  expectError(() => loadCutTableFromLockedResource(locked("fraction", noncanonical as unknown as Json)), "CUT_TABLE_CELL_VALUE", "$.table.rows[0].amount");

  const floatCell = structuredClone(sales) as { rows: Array<{ amount: unknown }> };
  floatCell.rows[0].amount = 0.1;
  expectError(() => loadCutTableFromLockedResource(locked("float", floatCell as unknown as Json)), "CUT_TABLE_CELL_TYPE", "$.table.rows[0].amount");

  const duplicateKey = structuredClone(sales) as { rows: Array<{ id: string }> };
  duplicateKey.rows[1].id = "s1";
  expectError(() => loadCutTableFromLockedResource(locked("key", duplicateKey as unknown as Json)), "CUT_TABLE_ROW_DUPLICATE_KEY", "$.table.rows[1].id");

  for (const invalidDate of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-2-01"]) {
    const invalid = structuredClone(sales) as { rows: Array<{ day: string }> };
    invalid.rows[0].day = invalidDate;
    expectError(() => loadCutTableFromLockedResource(locked("date_bad", invalid as unknown as Json)), "CUT_TABLE_CELL_VALUE", "$.table.rows[0].day");
  }
  for (const validDate of ["2000-02-29", "2024-02-29"]) {
    const valid = structuredClone(sales) as { rows: Array<{ day: string }> };
    valid.rows[0].day = validDate;
    assert.equal(loadCutTableFromLockedResource(locked("date_ok", valid as unknown as Json)).rows[0].day, validDate);
  }

  const boundedStringSchema = structuredClone(sales) as { schema: { fields: Array<{ name: string; type: { kind: string; maxBytes?: number } }> }; rows: Array<{ region: string }> };
  boundedStringSchema.schema.fields.find((field) => field.name === "region")!.type.maxBytes = 2;
  boundedStringSchema.rows[0].region = "éé";
  expectError(() => loadCutTableFromLockedResource(locked("bytes", boundedStringSchema as unknown as Json)), "CUT_TABLE_CELL_LIMIT", "$.table.rows[0].region", /4 UTF-8 bytes/u);
});

test("resource lock state, size, digest, and aggregate byte budgets fail before unsafe parsing", () => {
  const canonical = locked("sales_data", sales);
  const unlocked = structuredClone(canonical) as unknown as { resource: Record<string, unknown>; bytes: Uint8Array };
  unlocked.resource.state = "unlocked";
  expectError(() => loadCutTableFromLockedResource(unlocked), "CUT_TABLE_RESOURCE_STATE", "$.resource.state");

  const wrongSize = { resource: { ...canonical.resource, bytes: canonical.resource.bytes + 1 }, bytes: canonical.bytes };
  expectError(() => loadCutTableFromLockedResource(wrongSize), "CUT_TABLE_RESOURCE_INTEGRITY", "$.bytes");

  const wrongHash = { resource: { ...canonical.resource, sha256: "0".repeat(64) }, bytes: canonical.bytes };
  expectError(() => loadCutTableFromLockedResource(wrongHash), "CUT_TABLE_RESOURCE_INTEGRITY", "$.resource.sha256");

  expectError(
    () => loadCutTableFromLockedResource(canonical, { limits: { maxInputBytes: 32 } }),
    "CUT_TABLE_RESOURCE_LIMIT",
    "$.resource.bytes",
  );
  expectError(
    () => evaluateCutTableQuery(queryPlan(), resources(), { limits: { maxTotalInputBytes: 100 } }),
    "CUT_TABLE_RESOURCE_LIMIT",
    "$.resources",
    /before parsing/u,
  );
});

test("locked bytes are snapshotted and shared, proxied, accessor, and symbol-bearing inputs fail without invoking code", () => {
  const mutable = Buffer.from(JSON.stringify(sales), "utf8");
  const input = lockedBytes("snapshot", mutable);
  const loaded = loadCutTableFromLockedResource(input);
  mutable.fill(0);
  assert.deepEqual(loaded.rows[0].amount, exact(5, 2));
  assert.equal(loaded.rows[0].id, "s1", "post-call mutation of caller-owned bytes cannot alter the parsed result");

  if (typeof SharedArrayBuffer !== "undefined") {
    const source = Buffer.from(JSON.stringify(sales), "utf8");
    const shared = new Uint8Array(new SharedArrayBuffer(source.byteLength));
    shared.set(source);
    expectError(
      () => loadCutTableFromLockedResource(lockedBytes("shared", shared)),
      "CUT_TABLE_RESOURCE_TYPE",
      "$.bytes",
      /SharedArrayBuffer/u,
    );
  }

  const proxied = new Proxy(Buffer.from(JSON.stringify(sales), "utf8"), {});
  const proxyHash = createHash("sha256").update(Buffer.from(JSON.stringify(sales), "utf8")).digest("hex");
  expectError(
    () => loadCutTableFromLockedResource({
      resource: { id: "proxy", kind: "data", state: "locked", lockVersion: 2, sha256: proxyHash, bytes: Buffer.byteLength(JSON.stringify(sales)) },
      bytes: proxied,
    }),
    "CUT_TABLE_RESOURCE_TYPE",
    "$.bytes",
    /direct ordinary/u,
  );

  let invoked = false;
  const accessorResource = { ...locked("accessor", sales).resource } as Record<string, unknown>;
  Object.defineProperty(accessorResource, "id", {
    enumerable: true,
    get() { invoked = true; return "accessor"; },
  });
  expectError(
    () => loadCutTableFromLockedResource({ resource: accessorResource, bytes: Buffer.from(JSON.stringify(sales), "utf8") }),
    "CUT_TABLE_RESOURCE_TYPE",
    "$.resource.id",
    /accessor/u,
  );
  assert.equal(invoked, false, "closed boundary rejects the descriptor before reading it");

  const symbolInput = locked("symbol", sales) as unknown as Record<PropertyKey, unknown>;
  symbolInput[Symbol("hidden")] = true;
  expectError(
    () => loadCutTableFromLockedResource(symbolInput),
    "CUT_TABLE_RESOURCE_TYPE",
    "$",
    /symbol-keyed/u,
  );

  const accessorPlan = structuredClone(queryPlan());
  let stepGetterInvoked = false;
  Object.defineProperty(accessorPlan.steps, "0", {
    enumerable: true,
    configurable: true,
    get() { stepGetterInvoked = true; return queryPlan().steps[0]; },
  });
  expectError(() => validateCutTableQueryPlan(accessorPlan), "CUT_QUERY_PLAN_TYPE", "$.steps[0]", /accessor/u);
  assert.equal(stepGetterInvoked, false);
});

test("plan schema must exactly equal the locked table schema, including field order and string bounds", () => {
  const changedBound = structuredClone(queryPlan());
  changedBound.sources[0].schema.fields[0].type.maxBytes = 15;
  expectError(
    () => evaluateCutTableQuery(changedBound, resources()),
    "CUT_QUERY_SOURCE_SCHEMA",
    "$.plan.sources[0].schema.fields[0].type.maxBytes",
  );

  const changedOrder = structuredClone(queryPlan());
  [changedOrder.sources[0].schema.fields[0], changedOrder.sources[0].schema.fields[1]] = [
    changedOrder.sources[0].schema.fields[1],
    changedOrder.sources[0].schema.fields[0],
  ];
  expectError(
    () => evaluateCutTableQuery(changedOrder, resources()),
    "CUT_QUERY_SOURCE_SCHEMA",
    "$.plan.sources[0].schema.fields[0].name",
  );
});

const orderLeftSchema = {
  fields: [
    { name: "id", type: { kind: "string", maxBytes: 8 } },
    { name: "code", type: { kind: "string", maxBytes: 8 } },
    { name: "bucket", type: { kind: "string", maxBytes: 8 } },
    { name: "amount", type: { kind: "number" } },
  ],
  key: ["id"],
};

const orderRightSchema = {
  fields: [
    { name: "rid", type: { kind: "string", maxBytes: 8 } },
    { name: "code", type: { kind: "string", maxBytes: 8 } },
    { name: "tag", type: { kind: "string", maxBytes: 8 } },
  ],
  key: ["rid"],
};

function orderResources() {
  return [
    locked("left_data", table(orderLeftSchema as Json, [
      { id: "l1", code: "x", bucket: "b", amount: exact(1) },
      { id: "l2", code: "x", bucket: "a", amount: exact(1) },
    ] as Json[])),
    locked("right_data", table(orderRightSchema as Json, [
      { rid: "r1", code: "x", tag: "é" },
      { rid: "r2", code: "x", tag: "z" },
    ] as Json[])),
  ];
}

function orderPlan(result = "joined") {
  return {
    format: "cut-query-plan",
    version: 1,
    sources: [
      { name: "left_rows", resourceId: "left_data", schema: orderLeftSchema },
      { name: "right_rows", resourceId: "right_data", schema: orderRightSchema },
    ],
    steps: [
      {
        id: "joined",
        op: "inner-join",
        left: "left_rows",
        right: "right_rows",
        on: [{ left: "code", right: "code" }],
        select: [
          { from: "left", field: "id", as: "id" },
          { from: "right", field: "rid", as: "rid" },
          { from: "left", field: "bucket", as: "bucket" },
          { from: "right", field: "tag", as: "tag" },
          { from: "left", field: "amount", as: "amount" },
        ],
        key: ["id", "rid"],
      },
      { id: "groups", op: "group", input: "joined", by: [{ field: "bucket", as: "bucket" }] },
      { id: "counts", op: "aggregate", input: "groups", values: [{ as: "count", function: "count" }] },
      { id: "stable_counts", op: "sort", input: "counts", by: [{ field: "count", direction: "desc" }] },
      { id: "utf8_tags", op: "sort", input: "joined", by: [{ field: "tag", direction: "asc" }] },
    ],
    result,
  };
}

test("join is left-major/right-source-order, groups are first-seen, sort is stable, and strings use UTF-8 byte order", () => {
  const joined = evaluateCutTableQuery(orderPlan(), orderResources());
  assert.equal(joined.kind, "table");
  if (joined.kind !== "table") return;
  assert.deepEqual(joined.rows.map((row) => `${row.id}:${row.rid}`), ["l1:r1", "l1:r2", "l2:r1", "l2:r2"]);

  const grouped = evaluateCutTableQuery(orderPlan("stable_counts"), orderResources());
  assert.equal(grouped.kind, "table");
  if (grouped.kind !== "table") return;
  assert.deepEqual(grouped.rows.map((row) => row.bucket), ["b", "a"], "equal-count stable sort retains first-seen group order");

  const utf8 = evaluateCutTableQuery(orderPlan("utf8_tags"), orderResources());
  assert.equal(utf8.kind, "table");
  if (utf8.kind !== "table") return;
  assert.deepEqual(utf8.rows.map((row) => `${row.tag}:${row.id}`), ["z:l1", "z:l2", "é:l1", "é:l2"]);
});

test("join, group, row, cell, and predicate budgets preflight before unsafe result allocation", () => {
  expectError(
    () => evaluateCutTableQuery(orderPlan(), orderResources(), { limits: { maxJoinRows: 3 } }),
    "CUT_QUERY_CARDINALITY",
    "$.plan.steps[0]",
    /before output row allocation/u,
  );
  expectError(
    () => evaluateCutTableQuery(orderPlan("counts"), orderResources(), { limits: { maxGroups: 1 } }),
    "CUT_QUERY_CARDINALITY",
    "$.plan.steps[1]",
    /before creating another group/u,
  );
  expectError(
    () => evaluateCutTableQuery(orderPlan(), orderResources(), { limits: { maxResultCells: 10 } }),
    "CUT_QUERY_CARDINALITY",
    "$.plan.steps[0]",
    /20 cells/u,
  );
  expectError(
    () => evaluateCutTableQuery(orderPlan(), orderResources(), { limits: { maxRowsPerSource: 1 } }),
    "CUT_TABLE_ROW_LIMIT",
    "$.resourcesById.left_data.table.rows",
  );
  expectError(
    () => evaluateCutTableQuery(orderPlan(), orderResources(), { limits: { maxCellsPerSource: 4 } }),
    "CUT_TABLE_ROW_LIMIT",
    "$.resourcesById.left_data.table.rows",
    /8 cells/u,
  );

  const duplicateJoinKey = structuredClone(orderPlan());
  duplicateJoinKey.steps[0].key = ["id"];
  expectError(
    () => evaluateCutTableQuery(duplicateJoinKey, orderResources()),
    "CUT_QUERY_RESULT_KEY",
    "$.plan.steps[0].rows[1].id",
  );

  const hostile = structuredClone(queryPlan());
  let predicate: Record<string, unknown> = { op: "compare", field: "active", operator: "eq", value: true };
  for (let index = 0; index < 8; index += 1) predicate = { op: "not", item: predicate };
  hostile.steps[0].where = predicate as typeof hostile.steps[0]["where"];
  expectError(
    () => validateCutTableQueryPlan(hostile, { limits: { maxPredicateNodes: 4 } }),
    "CUT_QUERY_PLAN_LIMIT",
    /^\$\.steps\[0\]\.where/u,
    /maxPredicateNodes=4/u,
  );
});

test("input resource array order is non-semantic while plan/data edits change identities", () => {
  const first = evaluateCutTableQuery(queryPlan(), resources());
  const reversed = evaluateCutTableQuery(queryPlan(), resources().reverse());
  assert.equal(first.id, reversed.id);
  assert.equal(first.planId, reversed.planId);

  const changed = structuredClone(queryPlan());
  const filter = changed.steps[0] as typeof changed.steps[number] & { where: { value: boolean } };
  filter.where.value = false;
  const changedResult = evaluateCutTableQuery(changed, resources());
  assert.notEqual(changedResult.planId, first.planId);
  assert.notEqual(changedResult.id, first.id);

  const editedSales = structuredClone(sales) as { rows: Array<{ amount: ReturnType<typeof exact> }> };
  editedSales.rows[0].amount = exact(9, 2);
  const dataResult = evaluateCutTableQuery(queryPlan(), [locked("sales_data", editedSales as unknown as Json), locked("region_data", regions)]);
  assert.equal(dataResult.planId, first.planId);
  assert.notEqual(dataResult.id, first.id);
});
