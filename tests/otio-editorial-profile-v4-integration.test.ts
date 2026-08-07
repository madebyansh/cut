import test from "node:test";
import assert from "node:assert/strict";
import { stableJsonStringify } from "../lib/core/stable";
import { parseCutLanguage } from "../lib/language/parser";
import { compileCutModule } from "../lib/language/compiler";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import {
  CutOtioImportError,
  importOtioTimeline,
} from "../lib/interchange/otio-import";

const source = `cut 0.4;
project "OTIO nested TimelineEdit V4 integration";
import { Precomp, Rect } from "cut:visual";
import {
  Gap,
  PictureTrack,
  Sequence,
  TimelineEdit,
  avTime,
  editInsert,
  editOperand,
  editOperandPart,
  editOverwrite,
  editSelection,
  editorialMetadata,
  editorialMetadataEntry
} from "@cut/edit";

timeline main(duration: 4s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack(
        trackId: "picture.nested",
        role: "graphics",
        metadata: editorialMetadata(entries: [
          editorialMetadataEntry(
            key: "org.cutlang.test.track",
            value: "nested"
          )
        ])
      ) {
        Precomp(
          source: overlay,
          range: 0s ..< 1s,
          x: 1px,
          y: -1px,
          scale: 0.75,
          rotation: 7deg,
          opacity: 75%,
          editId: "nested.source",
          role: "graphics",
          metadata: editorialMetadata(entries: [
            editorialMetadataEntry(
              key: "org.cutlang.test.item",
              value: "source"
            )
          ])
        );
        Precomp(
          source: overlay,
          range: 1s ..< 3s,
          editId: "nested.body",
          role: "b-roll"
        );
        Gap(duration: 1s);
      }
    }
    TimelineEdit(id: "nested-placement", operations: [
      editInsert(
        picture: editSelection(trackIds: ["picture.nested"]),
        at: avTime(picture: 1s),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "picture",
            sourceOriginId: "nested.source",
            originId: "nested.inserted",
            duration: 1s,
            metadata: editorialMetadata(entries: [
              editorialMetadataEntry(
                key: "org.cutlang.test.item",
                value: "inserted"
              )
            ])
          )
        ])
      ),
      editOverwrite(
        picture: editSelection(trackIds: ["picture.nested"]),
        at: avTime(picture: 3s),
        operand: editOperand(parts: [
          editOperandPart(
            domain: "picture",
            sourceOriginId: "nested.source",
            originId: "nested.overwritten",
            duration: 1s,
            metadata: editorialMetadata(entries: [
              editorialMetadataEntry(
                key: "org.cutlang.test.item",
                value: "overwritten"
              )
            ])
          )
        ])
      )
    ]);
  }
}

timeline overlay(duration: 3s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene red(duration: 1s) {
    Rect(width: 24px, height: 16px, fill: #ef233c);
  }
  scene green(duration: 1s) {
    Rect(width: 24px, height: 16px, fill: #24a148);
  }
  scene blue(duration: 1s) {
    Rect(width: 24px, height: 16px, fill: #2667ff);
  }
}

export out = render(main);
`;

function compile(text = source) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

type NestedProfileMetadata = {
  editorial_profile?: {
    semanticSha256: string;
    losses: Array<{
      code: string;
      target: { kind: string };
      subject: { id: string };
      message: string;
    }>;
    tracks: Array<{
      items: Array<{
        id: string;
        kind: string;
        nesting?: null | { semanticSha256: string };
      }>;
    }>;
  };
  editorial_profile_nested_extension?: {
    format: string;
    version: number;
    semanticSha256: string;
    lineageSegments: Array<{
      originId: string;
      sourceAuthorityId: string;
      placementPolicy: "structural-only" | "static-same-track-copy";
    }>;
    placements: Array<{
      itemId: string;
      role?: string;
      metadata?: Readonly<Record<string, string>>;
    }>;
  };
};

function nestedIdentity(text = source) {
  const ir = compile(text);
  const presented = Object.values(ir.nodes).find((node) =>
    node.op === "cut.visual.precomp"
      && Object.hasOwn(node.inputs, "x"));
  assert.ok(presented);
  const exactPresentation = stableJsonStringify(Object.fromEntries(
    ["x", "y", "scale", "rotation", "opacity"]
      .map((name) => [name, presented.inputs[name]!] as const),
  ));
  const exported = exportCutTimelineToOtio(ir, { compositionId: "main" });
  const cut = exported.timeline.metadata.cut as NestedProfileMetadata;
  const profile = cut.editorial_profile;
  const extension = cut.editorial_profile_nested_extension;
  assert.ok(profile);
  assert.ok(extension);
  const sourceItem = profile.tracks
    .flatMap((track) => track.items)
    .find((item) => item.id === "nested.source");
  const sourceLineage = extension.lineageSegments.find((segment) =>
    segment.originId === "nested.source");
  assert.ok(sourceItem?.nesting);
  assert.ok(sourceLineage);
  return {
    exported,
    cut,
    profile,
    extension,
    exactPresentation,
    nestingSemanticSha256: sourceItem.nesting.semanticSha256,
    sourceAuthorityId: sourceLineage.sourceAuthorityId,
  };
}

test("production OTIO export/import executes the separate nested V4 authority without overstating reconstruction", () => {
  const baseline = nestedIdentity();
  const { exported, cut, profile, extension, exactPresentation } = baseline;
  assert.equal(
    extension.format,
    "cut-otio-editorial-nested-placement-extension",
  );
  assert.equal(extension.version, 4);
  assert.match(extension.semanticSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    extension.placements.map((placement) => placement.itemId),
    [
      "nested.source",
      "nested.inserted",
      "nested.body",
      "nested.overwritten",
    ],
  );
  assert.deepEqual(
    extension.placements.map((placement) => [
      placement.itemId,
      placement.role,
      placement.metadata?.["org.cutlang.test.item"],
    ]),
    [
      ["nested.source", "graphics", "source"],
      ["nested.inserted", "graphics", "inserted"],
      ["nested.body", "b-roll", undefined],
      ["nested.overwritten", "graphics", "overwritten"],
    ],
  );
  assert.ok(extension.lineageSegments.every((segment) =>
    segment.placementPolicy === "static-same-track-copy"));
  assert.equal(exported.report.editorialProfile?.nestedExtension?.placements, 4);
  assert.ok(exported.report.unsupportedSemantics.every((issue) =>
    issue.code !== "CUT_OTIO_EDITORIAL_PROFILE_UNAVAILABLE"));
  const presentationLosses = profile.losses.filter((loss) =>
    loss.code === "CUT_OTIO_NESTED_INSTANCE_CONTROLS_UNSUPPORTED");
  assert.equal(presentationLosses.length, 6);
  assert.deepEqual(
    presentationLosses.reduce<Record<string, number>>((counts, loss) => {
      counts[loss.target.kind] = (counts[loss.target.kind] ?? 0) + 1;
      return counts;
    }, {}),
    { "cut-roundtrip": 3, "generic-otio": 3 },
  );
  assert.ok(presentationLosses.every((loss) =>
    loss.message.includes(exactPresentation)));
  const repeated = exportCutTimelineToOtio(compile(), {
    compositionId: "main",
  });
  assert.deepEqual(
    (repeated.timeline.metadata.cut as typeof cut)
      .editorial_profile_nested_extension,
    extension,
    "same-source V4 export must repeat the exact policy-bound extension",
  );

  assert.throws(
    () => importOtioTimeline(JSON.stringify(exported.timeline)),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_LOSSY_REFUSED",
  );
  const imported = importOtioTimeline(JSON.stringify(exported.timeline), {
    allowLossy: true,
  });
  assert.equal(
    imported.report.editorialProfile?.nestedExtension?.semanticSha256,
    extension.semanticSha256,
  );
  assert.ok(imported.report.losses.some((loss) =>
    loss.code === "CUT_OTIO_NESTING_EXECUTABLE_IMPORT_UNSUPPORTED"));
  assert.ok(imported.report.losses.some((loss) =>
    loss.code === "CUT_OTIO_NESTED_INSTANCE_CONTROLS_UNSUPPORTED"
      && loss.message.includes(exactPresentation)));
  assert.doesNotThrow(() => compile(imported.source));
  const lossyReexport = exportCutTimelineToOtio(compile(imported.source), {
    compositionId: "main",
  });
  assert.equal(
    (lossyReexport.timeline.metadata.cut as typeof cut)
      .editorial_profile_nested_extension,
    undefined,
    "explicit lossy import must not manufacture V4 authority on re-export",
  );

  const hostilePolicy = structuredClone(exported.timeline);
  const hostilePolicyExtension = (
    hostilePolicy.metadata.cut as typeof cut
  ).editorial_profile_nested_extension;
  assert.ok(hostilePolicyExtension);
  hostilePolicyExtension.lineageSegments[0]!.placementPolicy =
    "structural-only";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(hostilePolicy), {
      allowLossy: true,
    }),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_PROFILE",
    "policy-tampered V4 bytes must refuse before lossy import/re-export",
  );

  const hostile = structuredClone(exported.timeline);
  const stack = hostile.tracks.children
    .flatMap((track) => track.children)
    .find((item) => item.OTIO_SCHEMA === "Stack.1");
  assert.ok(stack && stack.OTIO_SCHEMA === "Stack.1");
  (stack.metadata.cut as Record<string, unknown>).editorial_role = "forged";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(hostile), { allowLossy: true }),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_PROFILE",
  );

  const hostileNestingIdentity = structuredClone(exported.timeline);
  const nestedStack = hostileNestingIdentity.tracks.children
    .flatMap((track) => track.children)
    .find((item) => item.OTIO_SCHEMA === "Stack.1"
      && item.name === "overlay");
  assert.ok(nestedStack && nestedStack.OTIO_SCHEMA === "Stack.1");
  (nestedStack.metadata.cut as {
    exact_nesting: { semanticSha256: string };
  }).exact_nesting.semanticSha256 = "0".repeat(64);
  assert.throws(
    () => importOtioTimeline(JSON.stringify(hostileNestingIdentity), {
      allowLossy: true,
    }),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_PROFILE",
    "native nested presentation authority tampering must fail before lossy import",
  );

  const hostileSourceAuthority = structuredClone(exported.timeline);
  const hostileSourceExtension = (
    hostileSourceAuthority.metadata.cut as NestedProfileMetadata
  ).editorial_profile_nested_extension;
  assert.ok(hostileSourceExtension);
  hostileSourceExtension.lineageSegments[0]!.sourceAuthorityId =
    "authority_000000000000000000000000";
  assert.throws(
    () => importOtioTimeline(JSON.stringify(hostileSourceAuthority), {
      allowLossy: true,
    }),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_PROFILE",
    "V4 source presentation authority tampering must fail before lossy import",
  );
});

test("every admitted static Precomp presentation control changes the V2/V4 authority without losing the native profile", () => {
  const baseline = nestedIdentity();
  for (const [label, before, after] of [
    ["x", "x: 1px", "x: 2px"],
    ["y", "y: -1px", "y: -2px"],
    ["scale", "scale: 0.75", "scale: 0.8"],
    ["rotation", "rotation: 7deg", "rotation: 11deg"],
    ["opacity", "opacity: 75%", "opacity: 60%"],
  ] as const) {
    const changed = nestedIdentity(source.replace(before, after));
    assert.notEqual(
      changed.nestingSemanticSha256,
      baseline.nestingSemanticSha256,
      `${label} must change native nested semantic authority`,
    );
    assert.notEqual(
      changed.sourceAuthorityId,
      baseline.sourceAuthorityId,
      `${label} must change V4 source authority`,
    );
    assert.notEqual(
      changed.profile.semanticSha256,
      baseline.profile.semanticSha256,
      `${label} must change V2 profile identity`,
    );
    assert.notEqual(
      changed.extension.semanticSha256,
      baseline.extension.semanticSha256,
      `${label} must change V4 profile identity`,
    );
    assert.ok(changed.exported.report.unsupportedSemantics.every((issue) =>
      issue.code !== "CUT_OTIO_EDITORIAL_PROFILE_UNAVAILABLE"));
    assert.ok(changed.profile.losses
      .filter((loss) =>
        loss.code === "CUT_OTIO_NESTED_INSTANCE_CONTROLS_UNSUPPORTED")
      .every((loss) => loss.message.includes(changed.exactPresentation)));
  }
});
