import {
  cutInterchangeBackendReportIdentity,
  defineCutInterchangeExportBackend,
  type CutInterchangeBackendDescriptor,
  type CutInterchangeLossReport,
} from "../../../lib/interchange/backend";
import type { Rational } from "../../../lib/language/rational";

export const timelineSummaryBackendDescriptor = Object.freeze({
  format: "cut-interchange-backend",
  version: 1,
  id: "fixture.timeline-summary",
  implementation: "fixture-timeline-summary-v1",
  target: "CUT conformance timeline summary JSON",
  direction: "export",
  sourceMeaning: "cut-av-ir-v3-editorial",
  artifact: Object.freeze({ mediaType: "application/json", extension: ".json" }),
  report: Object.freeze({ format: "cut-fixture-interchange-report", version: 1 }),
} as const satisfies CutInterchangeBackendDescriptor<
  "fixture.timeline-summary",
  "cut-fixture-interchange-report"
>);

export type TimelineSummaryInterchangeReport = CutInterchangeLossReport<
  "cut-fixture-interchange-report",
  "fixture.timeline-summary"
>;

export type TimelineSummaryArtifact = Readonly<{
  format: "cut-interchange-timeline-summary";
  version: 1;
  source: Readonly<{
    buildId: string;
    semanticSha256: string;
  }>;
  composition: Readonly<{
    id: string;
    name: string;
    duration: Rational;
    fps: Rational;
    sceneIds: readonly string[];
  }>;
  scenes: ReadonlyArray<Readonly<{
    id: string;
    name: string;
    start: Rational;
    duration: Rational;
  }>>;
}>;

export class TimelineSummaryBackendError extends Error {
  readonly code = "CUT_TIMELINE_SUMMARY_COMPOSITION_REQUIRED";

  constructor(message: string) {
    super(`${"CUT_TIMELINE_SUMMARY_COMPOSITION_REQUIRED"}: ${message}`);
    this.name = "TimelineSummaryBackendError";
  }
}

/**
 * A real second adapter used by the public conformance fixture. It translates
 * exact timeline/scene ownership and timing into a deterministic target
 * artifact, while explicitly reporting that executable node semantics are
 * absent. It is deliberately not a claimed production interchange format.
 */
export const timelineSummaryInterchangeBackend = defineCutInterchangeExportBackend<
  Record<string, never>,
  TimelineSummaryArtifact,
  TimelineSummaryInterchangeReport,
  "fixture.timeline-summary"
>({
  descriptor: timelineSummaryBackendDescriptor,
  exportEditorial(source) {
    const selector = source.selection.composition;
    let composition = selector === null
      ? undefined
      : source.ir.compositions.find((item) => item.id === selector || item.name === selector);
    if (!composition && selector === null && source.ir.compositions.length === 1) {
      composition = source.ir.compositions[0];
    }
    if (!composition) {
      throw new TimelineSummaryBackendError(
        selector === null
          ? "the fixture needs one unambiguous CUT composition"
          : `the fixture cannot resolve composition ${JSON.stringify(selector)}`,
      );
    }
    const scenes = composition.sceneIds.map((id) => {
      const scene = source.ir.scenes[id];
      if (!scene) {
        throw new TimelineSummaryBackendError(`composition ${JSON.stringify(composition.id)} references missing scene ${JSON.stringify(id)}`);
      }
      return Object.freeze({
        id: scene.id,
        name: scene.name,
        start: scene.start,
        duration: scene.duration,
      });
    });
    const report: TimelineSummaryInterchangeReport = Object.freeze({
      format: "cut-fixture-interchange-report",
      version: 1,
      backend: cutInterchangeBackendReportIdentity(timelineSummaryBackendDescriptor),
      source: Object.freeze({ buildId: source.identity.buildId, compositionId: composition.id }),
      status: "lossy-editorial",
      unsupportedSemantics: Object.freeze([{
        code: "CUT_TIMELINE_SUMMARY_EXECUTION_OMITTED",
        category: "node",
        disposition: "omitted" as const,
        subject: Object.freeze({ kind: "composition", id: composition.id, property: "executable-graph" }),
        message: "The conformance timeline-summary target retains exact composition and scene timing but intentionally omits executable node, signal, resource, effect, job, and output meaning.",
        provenance: composition.provenance,
      }]),
    });
    return Object.freeze({
      artifact: Object.freeze({
        format: "cut-interchange-timeline-summary",
        version: 1,
        source: Object.freeze({
          buildId: source.identity.buildId,
          semanticSha256: source.identity.semanticSha256,
        }),
        composition: Object.freeze({
          id: composition.id,
          name: composition.name,
          duration: composition.duration,
          fps: composition.fps,
          sceneIds: Object.freeze([...composition.sceneIds]),
        }),
        scenes: Object.freeze(scenes),
      }),
      report,
    });
  },
});
