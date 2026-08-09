import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFootageRealSmoke } from "./assert-footage-real-smoke.mjs";

const adapterSha256 = "d3e57c66bb0eaaca433427f16fd7b48df8d8f9aacfce19f4ea86e8bb9879afbe";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const rational = (numerator, denominator = "1") => ({ numerator, denominator });
const range = (start, end) => ({ semantics: "half-open", start: rational(start), end: rational(end) });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function signed(body, field) { return { ...body, [field]: sha256(JSON.stringify(canonical(body))) }; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-real-assert-"));
  const project = join(root, "project"), reports = join(root, "reports"), home = join(root, "home"), payload = join(home, ".payload");
  await Promise.all([
    mkdir(join(project, ".cut/footage"), { recursive: true }), mkdir(join(project, "media"), { recursive: true }),
    mkdir(join(project, "selects"), { recursive: true }), mkdir(reports), mkdir(payload, { recursive: true }),
  ]);
  const main = Buffer.from("cut 0.4;\n"), lock = Buffer.from("locked\n"), dog = Buffer.from("dog-video"), dashboard = Buffer.from("dashboard-video"), vector = Buffer.from("vector-bytes"), clip = Buffer.from("exact-dog-selection");
  await Promise.all([
    writeFile(join(project, "main.cut"), main), writeFile(join(project, "cut.lock"), lock),
    writeFile(join(project, "media/dog-outdoors.mp4"), dog), writeFile(join(project, "media/laptop-dashboard.mp4"), dashboard),
    writeFile(join(project, ".cut/footage/index.vectors"), vector), writeFile(join(project, "selects/dog.mp4"), clip),
  ]);
  const backend = { protocolVersion: 1, provider: "huggingface-transformers-js", model: `Xenova/clip-vit-base-patch32@d15189d7028b43f1d3e65039190477f6af591c2a+adapter.${adapterSha256}`, dimensions: 512, normalization: "l2" };
  const index = signed({
    format: "cut-footage-index", version: 1, root: "media",
    sources: [
      { locator: "media/dog-outdoors.mp4", bytes: dog.length, sha256: sha256(dog), duration: rational("2"), probeSha256: "1".repeat(64), streams: [{ index: 0, type: "video", timeBase: rational("1", "24"), frameRate: rational("24") }] },
      { locator: "media/laptop-dashboard.mp4", bytes: dashboard.length, sha256: sha256(dashboard), duration: rational("2"), probeSha256: "2".repeat(64), streams: [{ index: 0, type: "video", timeBase: rational("1", "24"), frameRate: rational("24") }] },
    ],
    chunkPolicy: { duration: rational("8"), overlap: rational("2") },
    chunks: [
      { id: "chunk-dog", sourceLocator: "media/dog-outdoors.mp4", sourceSha256: sha256(dog), streamIndex: 0, range: range("0", "2") },
      { id: "chunk-dashboard", sourceLocator: "media/laptop-dashboard.mp4", sourceSha256: sha256(dashboard), streamIndex: 0, range: range("0", "2") },
    ],
    backend, vectorArtifact: { locator: ".cut/footage/index.vectors", bytes: vector.length, sha256: sha256(vector) },
    creation: { cutVersion: "0.4.0-alpha.4", backendProtocolVersion: 1 },
  }, "indexSha256");
  const search = signed({
    format: "cut-footage-search", version: 1, indexLocator: ".cut/footage/index.json", indexSha256: index.indexSha256,
    query: { text: "a dog outdoors", thresholdPpm: 0 },
    matches: [
      { id: "match-dog", scorePpm: 820000, chunkIds: ["chunk-dog"], sourceSelection: { locator: "media/dog-outdoors.mp4", sha256: sha256(dog), streamIndex: 0, range: range("0", "2") } },
      { id: "match-dashboard", scorePpm: 620000, chunkIds: ["chunk-dashboard"], sourceSelection: { locator: "media/laptop-dashboard.mp4", sha256: sha256(dashboard), streamIndex: 0, range: range("0", "2") } },
    ],
  }, "searchSha256");
  const extract = signed({
    format: "cut-footage-extract", version: 1, searchSha256: search.searchSha256, indexSha256: index.indexSha256,
    matchId: "match-dog", label: "candidate-only-not-cut-lock", sourceSelection: search.matches[0].sourceSelection,
    requestedHandles: { head: rational("1", "2"), tail: rational("1", "2") }, effectiveHandles: { head: rational("0"), tail: rational("0") }, finalRange: range("0", "2"),
    toolchain: { ffmpeg: { name: "ffmpeg", version: "7.1" }, ffprobe: { name: "ffprobe", version: "7.1" } },
    output: { locator: "selects/dog.mp4", bytes: clip.length, sha256: sha256(clip), streams: [{ index: 0, type: "video", codec: "h264" }] },
  }, "extractSha256");
  await Promise.all([
    writeFile(join(project, ".cut/footage/index.json"), `${JSON.stringify(canonical(index))}\n`),
    writeFile(join(reports, "index.json"), `${JSON.stringify(canonical(index))}\n`),
    writeFile(join(project, ".cut/footage/search.json"), `${JSON.stringify(canonical(search))}\n`),
    writeFile(join(reports, "search-first.json"), `${JSON.stringify(canonical(search))}\n`),
    writeFile(join(reports, "search-second.json"), `${JSON.stringify(canonical(search))}\n`),
    writeFile(join(project, "selects/dog.mp4.cut-footage.json"), `${JSON.stringify(canonical(extract))}\n`),
    writeFile(join(reports, "extract.json"), `${JSON.stringify(canonical(extract))}\n`),
    writeFile(join(reports, "protected.json"), JSON.stringify({ "main.cut": sha256(main), "cut.lock": sha256(lock) })),
    writeFile(join(reports, "extract-ffprobe.json"), JSON.stringify({ streams: [{ index: 0, codec_name: "h264", codec_type: "video" }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000" } })),
  ]);
  const setup = { format: "cut-footage-local-setup-report", version: 1, status: "installed", backend: "local", identity: backend };
  const doctor = { format: "cut-footage-local-doctor-report", version: 1, status: "pass", backend: "local", checks: [{ code: "CUTFD1000", name: "Local footage backend", status: "pass", detail: "ready" }] };
  await Promise.all([
    writeFile(join(reports, "setup-first.json"), JSON.stringify(setup)),
    writeFile(join(reports, "setup-second.json"), JSON.stringify({ ...setup, status: "ready" })),
    writeFile(join(reports, "doctor.json"), JSON.stringify(doctor)),
    writeFile(join(payload, "install-manifest.json"), JSON.stringify({
      format: "cut-footage-local-install", version: 1, backend: "local", adapterSha256,
      model: { provider: backend.provider, model: "Xenova/clip-vit-base-patch32", revision: "d15189d7028b43f1d3e65039190477f6af591c2a", dtype: "q8", device: "cpu", dimensions: 512,
        files: [
          { locator: "onnx/text_model_quantized.onnx", bytes: 64504507, sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a" },
          { locator: "onnx/vision_model_quantized.onnx", bytes: 89117001, sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299" },
        ] },
    })),
  ]);
  await symlink(".payload", join(home, "local-clip-v1"));
  return { project, reports, home };
}

test("real smoke assertion accepts the complete pinned semantic workflow", async () => {
  const value = await fixture();
  const report = await assertFootageRealSmoke(value.project, value.reports, value.home);
  assert.equal(report.status, "pass");
  assert.equal(report.firstMatch, "media/dog-outdoors.mp4");
  assert.equal(report.marginPpm, 200000);
});

test("real smoke assertion rejects wrong ranking, stale extraction, model drift, and changed protected source", async () => {
  for (const mutate of [
    async (value) => { const path = join(value.project, ".cut/footage/search.json"); const search = JSON.parse(await (await import("node:fs/promises")).readFile(path)); search.matches.reverse(); await writeFile(path, JSON.stringify(search)); },
    async (value) => { await writeFile(join(value.project, "selects/dog.mp4"), "changed"); },
    async (value) => { const path = join(value.home, ".payload/install-manifest.json"); const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path)); manifest.model.revision = "wrong"; await writeFile(path, JSON.stringify(manifest)); },
    async (value) => { await writeFile(join(value.project, "main.cut"), "changed"); },
    async (value) => { await writeFile(join(value.reports, "index.json"), "{}\n"); },
    async (value) => { await writeFile(join(value.reports, "search-second.json"), "{}\n"); },
    async (value) => { await writeFile(join(value.reports, "extract.json"), "{}\n"); },
  ]) {
    const value = await fixture(); await mutate(value);
    await assert.rejects(assertFootageRealSmoke(value.project, value.reports, value.home), /CUT_FOOTAGE_REAL_SMOKE/u);
  }
});
