import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";

const source = `cut 0.4;
project "audio-reactive schema";
import { Group, Rect } from "cut:visual";
import { AmplitudeEnvelope, mapNumber } from "@cut/data";
asset score: AudioAsset = audio("assets/score.wav");
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene proof(duration: 1s) {
    let energy: Signal<Ratio> = AmplitudeEnvelope(
      source: score,
      range: 0s ..< 1s,
      at: 0s,
      detector: "peak",
      window: 20ms,
      hop: 10ms,
      attack: 20ms,
      release: 100ms,
      floor: 1%,
      ceiling: 90%
    );
    Group(scale: 1) as pulse { Rect(width: 40px, height: 40px, fill: #ff0044); }
    set pulse.scale = mapNumber(energy, from: 1, to: 1.2);
  }
}
export out = render(main);`;

function compile() {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

test("the closed public CutAVIR schema admits the complete audio-amplitude producer and refuses hidden fields", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  const canonical = compile();
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));

  const hostile = structuredClone(canonical) as typeof canonical & {
    signals: Record<string, { producer?: Record<string, unknown> }>;
  };
  const produced = Object.values(hostile.signals).find((signal) => signal.producer)?.producer;
  assert.ok(produced);
  produced.hiddenRenderer = "film-specific";
  assert.equal(validate(hostile), false);
  assert.ok(validate.errors?.some((error) => error.keyword === "additionalProperties"
    && (error.params as { additionalProperty?: string }).additionalProperty === "hiddenRenderer"), JSON.stringify(validate.errors));
});
