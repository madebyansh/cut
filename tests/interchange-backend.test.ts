import test from "node:test";
import assert from "node:assert/strict";
import {
  CutInterchangeBackendError,
  CutInterchangeBackendRegistry,
  defineCutInterchangeExportBackend,
  dispatchCutInterchangeExport,
} from "../lib/interchange/backend";
import {
  cutOtioInterchangeBackend,
  cutOtioInterchangeBackendDescriptor,
  exportCutTimelineToOtio,
  type CutOtioExportOptions,
  type CutOtioInterchangeReport,
  type OtioTimeline,
} from "../lib/interchange/otio";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import {
  timelineSummaryBackendDescriptor,
  timelineSummaryInterchangeBackend,
  type TimelineSummaryArtifact,
  type TimelineSummaryInterchangeReport,
} from "./fixtures/interchange/timeline-summary-backend";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function minimalIr() {
  return compile(`
    cut 0.4;
    project "interchange backend fixture";
    timeline main(duration: 1s, fps: 24) {
      scene only(duration: 1s) {}
    }
    export out = render(main);
  `);
}

test("the production OTIO exporter executes through the registered common interchange backend", () => {
  const ir = minimalIr();
  const before = structuredClone(ir);
  const registry = new CutInterchangeBackendRegistry().register(cutOtioInterchangeBackend);
  const dispatched = dispatchCutInterchangeExport<
    CutOtioExportOptions,
    OtioTimeline,
    CutOtioInterchangeReport,
    "cut.otio-json"
  >(registry, cutOtioInterchangeBackendDescriptor.id, {
    ir,
    composition: "main",
    options: {},
  });
  const publicExport = exportCutTimelineToOtio(ir, { compositionId: "main" });

  assert.deepEqual(dispatched.artifact, publicExport.timeline);
  assert.deepEqual(dispatched.report, publicExport.report);
  assert.deepEqual(dispatched.report.backend, {
    id: "cut.otio-json",
    implementation: "cut-otio-json-export-v1",
    sourceMeaning: "cut-av-ir-v3-editorial",
  });
  assert.equal(dispatched.execution.backend.id, "cut.otio-json");
  assert.equal(dispatched.execution.source.buildId, ir.buildId);
  assert.match(dispatched.execution.source.semanticSha256, /^[a-f0-9]{64}$/u);
  assert.equal(dispatched.execution.source.compositionId, ir.compositions[0].id);
  assert.equal(dispatched.execution.status, dispatched.report.status);
  assert.equal(dispatched.execution.unsupportedSemanticCount, dispatched.report.unsupportedSemantics.length);
  assert.deepEqual(ir, before, "backend dispatch must not mutate caller-owned CutAVIR");
  assert.deepEqual(registry.descriptors(), [cutOtioInterchangeBackendDescriptor]);
});

test("an unrelated adapter receives the same editorial envelope and returns one typed loss report", () => {
  const ir = minimalIr();
  const result = dispatchCutInterchangeExport<
    Record<string, never>,
    TimelineSummaryArtifact,
    TimelineSummaryInterchangeReport,
    "fixture.timeline-summary"
  >(
    new CutInterchangeBackendRegistry().register(timelineSummaryInterchangeBackend),
    "fixture.timeline-summary",
    { ir, composition: "main", options: {} },
  );

  assert.equal(result.artifact.format, "cut-interchange-timeline-summary");
  assert.equal(result.artifact.source.buildId, ir.buildId);
  assert.equal(result.artifact.source.semanticSha256, result.execution.source.semanticSha256);
  assert.equal(result.artifact.composition.id, ir.compositions[0].id);
  assert.deepEqual(result.artifact.composition.sceneIds, ir.compositions[0].sceneIds);
  assert.deepEqual(result.artifact.scenes, [{
    id: ir.scenes[ir.compositions[0].sceneIds[0]].id,
    name: "only",
    start: { numerator: "0", denominator: "1" },
    duration: { numerator: "1", denominator: "1" },
  }]);
  assert.equal(result.report.status, "lossy-editorial");
  assert.equal(result.report.unsupportedSemantics[0].code, "CUT_TIMELINE_SUMMARY_EXECUTION_OMITTED");
  assert.equal(result.execution.unsupportedSemanticCount, 1);
});

test("registration and report validation fail closed with stable backend diagnostics", () => {
  const ir = minimalIr();
  const registry = new CutInterchangeBackendRegistry().register(cutOtioInterchangeBackend);
  assert.throws(
    () => registry.register(cutOtioInterchangeBackend),
    (error) => error instanceof CutInterchangeBackendError
      && error.code === "CUT_INTERCHANGE_BACKEND_DUPLICATE"
      && error.backendId === "cut.otio-json",
  );
  assert.throws(
    () => registry.resolve("fixture.missing"),
    (error) => error instanceof CutInterchangeBackendError
      && error.code === "CUT_INTERCHANGE_BACKEND_NOT_FOUND",
  );

  const badReport = defineCutInterchangeExportBackend<
    Record<string, never>,
    Record<string, never>,
    TimelineSummaryInterchangeReport,
    "fixture.timeline-summary"
  >({
    descriptor: timelineSummaryBackendDescriptor,
    exportEditorial(source) {
      const composition = source.ir.compositions[0];
      assert.ok(composition);
      return {
        artifact: {},
        report: {
          format: "cut-fixture-interchange-report",
          version: 1,
          backend: {
            id: "fixture.timeline-summary",
            implementation: "forged-implementation",
            sourceMeaning: "cut-av-ir-v3-editorial",
          },
          source: { buildId: source.identity.buildId, compositionId: composition.id },
          status: "lossless-editorial",
          unsupportedSemantics: [],
        },
      };
    },
  });
  assert.throws(
    () => dispatchCutInterchangeExport(
      new CutInterchangeBackendRegistry().register(badReport),
      "fixture.timeline-summary",
      { ir, composition: "main", options: {} },
    ),
    (error) => error instanceof CutInterchangeBackendError
      && error.code === "CUT_INTERCHANGE_BACKEND_REPORT"
      && /backend identity/u.test(error.message),
  );
});

test("unknown adapter failures and editorial-input mutation are refused without mutating caller IR", () => {
  const ir = minimalIr();
  const before = structuredClone(ir);
  const throwing = defineCutInterchangeExportBackend<
    Record<string, never>,
    Record<string, never>,
    TimelineSummaryInterchangeReport,
    "fixture.timeline-summary"
  >({
    descriptor: timelineSummaryBackendDescriptor,
    exportEditorial() {
      throw new Error("untyped adapter failure");
    },
  });
  assert.throws(
    () => dispatchCutInterchangeExport(
      new CutInterchangeBackendRegistry().register(throwing),
      "fixture.timeline-summary",
      { ir, options: {} },
    ),
    (error) => error instanceof CutInterchangeBackendError
      && error.code === "CUT_INTERCHANGE_BACKEND_EXECUTION"
      && error.causeValue instanceof Error,
  );

  const mutating = defineCutInterchangeExportBackend<
    Record<string, never>,
    Record<string, never>,
    TimelineSummaryInterchangeReport,
    "fixture.timeline-summary"
  >({
    descriptor: timelineSummaryBackendDescriptor,
    exportEditorial(source) {
      (source.ir as CutAVIR).project = "mutated inside adapter";
      throw new Error("mutation plus failure");
    },
  });
  assert.throws(
    () => dispatchCutInterchangeExport(
      new CutInterchangeBackendRegistry().register(mutating),
      "fixture.timeline-summary",
      { ir, options: {} },
    ),
    (error) => error instanceof CutInterchangeBackendError
      && error.code === "CUT_INTERCHANGE_BACKEND_MUTATION",
  );
  assert.deepEqual(ir, before, "the backend receives an isolated clone, never caller-owned CutAVIR");
});
