import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { importOtioTimeline, CutOtioImportError } from "../lib/interchange/otio-import";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRResource } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

const source = `cut 0.4;
project "OTIO V6 exact picture time maps";
import { PictureClip, PictureTrack, Sequence, speedPoint } from "@cut/edit";

asset picture: VideoAsset = video("media/picture.mkv");

timeline main(duration: 3s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    Sequence(duration: 3s) {
      PictureTrack(trackId: "picture.main") {
        PictureClip(
          source: picture,
          range: 0s ..< 1s,
          duration: 1s,
          speedRamp: [
            speedPoint(at: 0s, rate: 0.5),
            speedPoint(at: 500ms, rate: 1.5),
            speedPoint(at: 1s, rate: 0.5)
          ],
          editId: "picture.ramp"
        );
        PictureClip(
          source: picture,
          range: 1s ..< 2s,
          duration: 1s,
          playback: "freeze",
          freezeAt: 1500ms,
          editId: "picture.freeze"
        );
        PictureClip(
          source: picture,
          range: 2s ..< 3s,
          duration: 1s,
          tailHandle: 250ms,
          frameSelection: "nearest",
          editId: "picture.nearest"
        );
      }
    }
  }
}

export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

const splitRampSource = `cut 0.4;
project "OTIO V6 materialized split ramp";
import { PictureClip, PictureTrack, Sequence, speedPoint, split } from "@cut/edit";

asset picture: VideoAsset = video("media/picture.mkv");

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(sourceDuration: 1s, edits: [split(at: 500ms)], trackId: "picture.main") {
        PictureClip(
          source: picture,
          range: 0s ..< 1s,
          duration: 1s,
          speedRamp: [
            speedPoint(at: 0s, rate: 0.5),
            speedPoint(at: 500ms, rate: 1.5),
            speedPoint(at: 1s, rate: 0.5)
          ],
          editId: "picture.ramp"
        );
      }
    }
  }
}

export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

function compile(text = source) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function lockPicture(resource: IRResource) {
  resource.state = "locked";
  resource.sha256 = "a".repeat(64);
  resource.metadata = {
    lockVersion: 2,
    bytes: 1024,
    probe: {
      kind: "media",
      identity: {
        streams: [{
          index: 0,
          type: "video",
          frameRate: rational(24),
        }],
      },
      selected: {
        video: {
          streamIndex: 0,
          duration: rational(10),
          durationSource: "decoded-video-cadence",
          timeBase: rational(1, 24),
          frameRate: rational(24),
        },
      },
    },
  };
}

function locked(text = source) {
  const ir = compile(text);
  Object.values(ir.resources).forEach(lockPicture);
  ir.determinism.semantic = "locked";
  return ir;
}

function cutMetadata(value: ReturnType<typeof exportCutTimelineToOtio>) {
  return value.timeline.metadata.cut as {
    editorial_profile: {
      semanticSha256: string;
      losses: Array<{
        code: string;
        target: { kind: string };
        subject: { id: string };
      }>;
    };
    editorial_profile_picture_time_map_extension: {
      format: string;
      version: number;
      semanticSha256: string;
      authorities: Array<{
        authorityId: string;
        itemId: string;
        execution: string;
        policy: string;
        resource: { id: string; sha256: string };
        clock: { kind: string; streamIndex: number };
        timeMap: { kind: string };
        authoritySha256: string;
      }>;
    };
  };
}

function pictureMaps(ir: CutAVIR) {
  return Object.values(ir.nodes)
    .filter((node) => node.op === "cut.edit.picture_track")
    .flatMap((node) => node.editorial?.kind === "picture-track"
      ? node.editorial.items.filter((item) => item.kind === "picture")
        .map((item) => item.timeMap)
      : []);
}

function importProfileError(error: unknown) {
  return error instanceof CutOtioImportError
    && error.code === "CUT_OTIO_IMPORT_PROFILE";
}

function rgbaSha256(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

async function writeTinyPicture(root: string) {
  const media = resolve(root, "media");
  await mkdir(media, { recursive: true });
  const width = 16;
  const height = 16;
  const frames = Buffer.concat(Array.from({ length: 96 }, (_, frame) => {
    const red = (frame * 37 + 11) & 0xff;
    const green = (frame * 73 + 29) & 0xff;
    const blue = (frame * 109 + 47) & 0xff;
    return Buffer.from(Array.from(
      { length: width * height },
      () => [red, green, blue],
    ).flat());
  }));
  const raw = resolve(root, "picture.rgb");
  await writeFile(raw, frames);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24",
    "-video_size", `${width}x${height}`, "-framerate", "24", "-i", raw,
    "-frames:v", "96", "-c:v", "ffv1", "-level", "3",
    "-pix_fmt", "gbrp", resolve(media, "picture.mkv"),
  ]);
}

async function lockRealPicture(ir: CutAVIR, root: string) {
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  validateReferenceSession(ir);
}

async function frameHashes(ir: CutAVIR, root: string, frames: readonly number[]) {
  const composition = ir.compositions[0];
  const scene = ir.scenes[composition.sceneIds[0]];
  assert.ok(scene);
  const renderer = new ReferenceVisualRenderer(
    ir,
    composition,
    root,
    resolve(root, `.cut/v6-frame-cache-${createHash("sha256")
      .update(ir.buildId)
      .digest("hex")}`),
  );
  await renderer.prepare();
  try {
    const result: string[] = [];
    for (const frame of frames) {
      result.push(rgbaSha256((await renderer.sceneFrame(scene, frame, false)).data));
    }
    return result;
  } finally {
    renderer.close();
  }
}

test("production OTIO V6 authenticates and reimports exact final picture maps while retaining only generic target losses", () => {
  const first = exportCutTimelineToOtio(locked(), { compositionId: "main" });
  const cut = cutMetadata(first);
  const extension = cut.editorial_profile_picture_time_map_extension;
  assert.equal(extension.format, "cut-otio-editorial-picture-time-map-extension");
  assert.equal(extension.version, 6);
  assert.match(extension.semanticSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    extension.authorities.map((authority) => [
      authority.itemId,
      authority.timeMap.kind,
      authority.execution,
      authority.policy,
      authority.resource.id,
      authority.clock.kind,
      authority.clock.streamIndex,
    ]),
    [
      ["picture.ramp", "speed-ramp", "direct-picture-time-map-no-lineage", "cut-picture-time-map-v1", "picture", "frame", 0],
      ["picture.freeze", "freeze", "direct-picture-time-map-no-lineage", "cut-picture-time-map-v1", "picture", "frame", 0],
      ["picture.nearest", "constant", "direct-picture-time-map-no-lineage", "cut-picture-time-map-v1", "picture", "frame", 0],
    ],
  );
  assert.ok(extension.authorities.every((authority) =>
    /^[a-f0-9]{64}$/u.test(authority.authoritySha256)));
  assert.ok(extension.authorities.every((authority) =>
    !Object.keys(authority).some((key) =>
      /timeline|plan|operation|lineage/iu.test(key))));

  const relevantLosses = cut.editorial_profile.losses.filter((loss) =>
    new Set([
      "CUT_OTIO_VARIABLE_RETIME_UNSUPPORTED",
      "CUT_OTIO_FREEZE_RETIME_UNSUPPORTED",
      "CUT_OTIO_FRAME_SELECTION_UNSUPPORTED",
    ]).has(loss.code));
  assert.deepEqual(
    relevantLosses.map((loss) => [loss.code, loss.target.kind, loss.subject.id]),
    [
      ["CUT_OTIO_VARIABLE_RETIME_UNSUPPORTED", "generic-otio", "picture.ramp"],
      ["CUT_OTIO_FREEZE_RETIME_UNSUPPORTED", "generic-otio", "picture.freeze"],
      ["CUT_OTIO_FRAME_SELECTION_UNSUPPORTED", "generic-otio", "picture.nearest"],
    ],
  );
  assert.equal(
    relevantLosses.some((loss) => loss.target.kind === "cut-roundtrip"),
    false,
  );
  assert.deepEqual(first.report.editorialProfile?.pictureTimeMapExtension, {
    format: extension.format,
    version: 6,
    semanticSha256: extension.semanticSha256,
    authorities: 3,
  });

  const nativeClips = first.timeline.tracks.children[0].children.filter(
    (child) => child.OTIO_SCHEMA === "Clip.2",
  );
  assert.equal(nativeClips.length, 3);
  nativeClips.forEach((clip, index) => {
    if (clip.OTIO_SCHEMA !== "Clip.2") throw new Error("missing clip");
    assert.deepEqual(
      (clip.metadata.cut as { picture_time_map_authority: unknown })
        .picture_time_map_authority,
      extension.authorities[index],
    );
  });

  const imported = importOtioTimeline(JSON.stringify(first.timeline));
  assert.equal(imported.report.status, "lossless-editorial");
  assert.deepEqual(imported.report.editorialProfile?.pictureTimeMapExtension, {
    format: extension.format,
    version: 6,
    semanticSha256: extension.semanticSha256,
    authorities: 3,
  });
  assert.match(imported.source, /speedPoint\(at: 0s, rate: \(1 \/ 2\)\)/u);
  assert.match(imported.source, /playback: "freeze", freezeAt: \(3s \/ 2\)/u);
  assert.match(imported.source, /frameSelection: "nearest"/u);
  assert.doesNotMatch(imported.source, /TimelineEdit|editSplit|editTrim|editSlide/iu);
  const importedIr = compile(imported.source);
  assert.deepEqual(pictureMaps(importedIr), pictureMaps(compile()));
  Object.values(importedIr.resources).forEach(lockPicture);
  importedIr.determinism.semantic = "locked";
  const second = exportCutTimelineToOtio(importedIr, { compositionId: "main" });
  const secondCut = cutMetadata(second);
  assert.equal(
    secondCut.editorial_profile_picture_time_map_extension.semanticSha256,
    extension.semanticSha256,
  );
  assert.deepEqual(
    secondCut.editorial_profile_picture_time_map_extension.authorities,
    extension.authorities,
  );
});

test("V6 reimport renders exact locked tiny-media pixels for ramp, freeze, and non-default sampling", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-otio-v6-pixels-"));
  await writeTinyPicture(root);
  const original = compile();
  await lockRealPicture(original, root);
  const exported = exportCutTimelineToOtio(original, { compositionId: "main" });
  const imported = compile(importOtioTimeline(JSON.stringify(exported.timeline)).source);
  await lockRealPicture(imported, root);
  const frames = [0, 5, 11, 23, 24, 35, 47, 48, 59, 71];
  const originalHashes = await frameHashes(original, root, frames);
  const importedHashes = await frameHashes(imported, root, frames);
  assert.deepEqual(importedHashes, originalHashes);
  assert.ok(new Set(originalHashes).size >= 5, originalHashes.join("\n"));
});

test("V6 round-trips the exact final maps produced by a materialized split without claiming edit lineage", () => {
  const original = locked(splitRampSource);
  const originalMaps = pictureMaps(original);
  assert.equal(originalMaps.length, 2);
  assert.ok(originalMaps.every((map) => map?.kind === "speed-ramp"));
  const exported = exportCutTimelineToOtio(original, { compositionId: "main" });
  const cut = cutMetadata(exported);
  assert.equal(
    cut.editorial_profile_picture_time_map_extension.authorities.length,
    2,
  );
  assert.ok(cut.editorial_profile_picture_time_map_extension.authorities
    .every((authority) => authority.execution === "direct-picture-time-map-no-lineage"));
  const imported = importOtioTimeline(JSON.stringify(exported.timeline));
  assert.doesNotMatch(imported.source, /TimelineEdit|split\(|trim\(/iu);
  const importedIr = compile(imported.source);
  assert.deepEqual(pictureMaps(importedIr), originalMaps);
  Object.values(importedIr.resources).forEach(lockPicture);
  importedIr.determinism.semantic = "locked";
  const reexported = exportCutTimelineToOtio(importedIr, {
    compositionId: "main",
  });
  assert.deepEqual(
    cutMetadata(reexported)
      .editorial_profile_picture_time_map_extension.authorities,
    cut.editorial_profile_picture_time_map_extension.authorities,
  );
});

test("V6 import refuses stale profile maps, missing native authority, resource mutation, and orphan extension", () => {
  const exported = exportCutTimelineToOtio(locked(), { compositionId: "main" });
  const staleMap = structuredClone(exported.timeline);
  const staleCut = staleMap.metadata.cut as Record<string, any>;
  staleCut.editorial_profile_picture_time_map_extension.authorities[0]
    .timeMap.points[1].rate.numerator = "2";
  assert.throws(() => importOtioTimeline(JSON.stringify(staleMap)), importProfileError);

  const missingNative = structuredClone(exported.timeline);
  const firstClip = missingNative.tracks.children[0].children.find(
    (child) => child.OTIO_SCHEMA === "Clip.2",
  );
  if (!firstClip || firstClip.OTIO_SCHEMA !== "Clip.2") throw new Error("missing clip");
  delete (firstClip.metadata.cut as Record<string, unknown>)
    .picture_time_map_authority;
  assert.throws(() => importOtioTimeline(JSON.stringify(missingNative)), importProfileError);

  const resourceMutation = structuredClone(exported.timeline);
  const resourceClip = resourceMutation.tracks.children[0].children.find(
    (child) => child.OTIO_SCHEMA === "Clip.2",
  );
  if (!resourceClip || resourceClip.OTIO_SCHEMA !== "Clip.2") throw new Error("missing clip");
  (resourceClip.media_references.DEFAULT_MEDIA.metadata.cut as Record<string, unknown>)
    .sha256 = "b".repeat(64);
  assert.throws(
    () => importOtioTimeline(JSON.stringify(resourceMutation)),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_RESOURCE"
      && error.path === "$.tracks.children[0].children[0].metadata.cut.resource_sha256",
  );

  const nativeV2Observation = structuredClone(exported.timeline);
  const nativeV2Clip = nativeV2Observation.tracks.children[0].children.find(
    (child) => child.OTIO_SCHEMA === "Clip.2",
  );
  if (!nativeV2Clip || nativeV2Clip.OTIO_SCHEMA !== "Clip.2") {
    throw new Error("missing clip");
  }
  nativeV2Clip.source_range.start_time.value += 1;
  assert.throws(
    () => importOtioTimeline(JSON.stringify(nativeV2Observation)),
    (error: unknown) => error instanceof CutOtioImportError
      && error.code === "CUT_OTIO_IMPORT_TIMING"
      && error.path === "$.tracks.children[0].children[0].metadata.cut.exact_source_start",
  );

  const v5ResourceAuthority = structuredClone(exported.timeline);
  const v5Cut = v5ResourceAuthority.metadata.cut as {
    editorial_profile_direct_media_extension: {
      authorities: Array<{ resource: { sha256: string } }>;
    };
  };
  v5Cut.editorial_profile_direct_media_extension.authorities[0]
    .resource.sha256 = "b".repeat(64);
  assert.throws(
    () => importOtioTimeline(JSON.stringify(v5ResourceAuthority)),
    importProfileError,
  );

  const orphan = structuredClone(exported.timeline);
  delete (orphan.metadata.cut as Record<string, unknown>).editorial_profile;
  assert.throws(() => importOtioTimeline(JSON.stringify(orphan)), importProfileError);
});

test("ordinary floor-sampled constant picture retime omits V6 exactly", () => {
  const ordinary = source
    .replace(/,\n          speedRamp: \[[\s\S]*?\n          \],/u, ',\n          playback: "normal",\n          rate: 1,')
    .replace(/,\n          playback: "freeze",\n          freezeAt: 1500ms,/u, ',\n          playback: "normal",\n          rate: 1,')
    .replace(/,\n          frameSelection: "nearest",/u, ',\n          playback: "normal",\n          rate: 1,');
  const exported = exportCutTimelineToOtio(locked(ordinary), {
    compositionId: "main",
  });
  assert.equal(
    (exported.timeline.metadata.cut as Record<string, unknown>)
      .editorial_profile_picture_time_map_extension,
    undefined,
  );
  assert.equal(exported.report.editorialProfile?.pictureTimeMapExtension, undefined);
  for (const child of exported.timeline.tracks.children[0].children) {
    if (child.OTIO_SCHEMA !== "Clip.2") continue;
    assert.equal(
      (child.metadata.cut as Record<string, unknown>).picture_time_map_authority,
      undefined,
    );
  }
});
