import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptionInterchangeError,
  parseSubRip,
  parseWebVtt,
  serializeSubRip,
  serializeWebVtt,
  validateCaptionTrack,
  type CaptionErrorCode,
  type CaptionTrack,
} from "../lib/interchange/captions";
import { rational } from "../lib/language/rational";

function throwsCaption(action: () => unknown, code: CaptionErrorCode, pattern?: RegExp) {
  assert.throws(action, (error) => error instanceof CaptionInterchangeError && error.code === code && (!pattern || pattern.test(error.message)));
}

const canonicalVtt = `WEBVTT

導入
00:00:01.000 --> 00:00:02.250 line:10.5%,start position:25.125%,line-left size:50% align:start
こんにちは世界 👋
Second line

outro
00:00:02.250 --> 00:00:04.000
مرحبا بالعالم 👨‍👩‍👧
`;

test("WebVTT BOM/CRLF input round-trips to canonical UTF-8 with structured horizontal settings", () => {
  const input = `\ufeffWEBVTT\r\n\r\n導入\r\n00:01.000 --> 00:02.250 align:start size:50% position:25.125%,line-left line:10.500%,start\r\nこんにちは世界 👋\r\nSecond line\r\n\r\noutro\r\n00:02.250 --> 00:04.000\r\nمرحبا بالعالم 👨‍👩‍👧\r\n`;
  const track = parseWebVtt(input);
  assert.deepEqual(track.cues.map((cue) => cue.id), ["導入", "outro"]);
  assert.deepEqual(track.cues[0].start, rational(1));
  assert.deepEqual(track.cues[0].end, rational(9, 4));
  assert.deepEqual(track.cues[0].settings, {
    line: { value: rational(21, 2), unit: "percent", align: "start" },
    position: { value: rational(201, 8), align: "line-left" },
    size: rational(50),
    align: "start",
  });
  assert.equal(serializeWebVtt(track), canonicalVtt);
  assert.deepEqual(parseWebVtt(serializeWebVtt(track)), track);
});

const canonicalSrt = "10\r\n00:00:00,125 --> 00:00:01,500\r\nFirst line\r\n第二行\r\n\r\n2\r\n00:00:01,500 --> 00:00:03,000\r\nCafé — déjà vu\r\n";

test("SubRip preserves cue IDs and authored order while emitting canonical CRLF", () => {
  const input = `\ufeff10\n00:00:00,125 --> 00:00:01,500\nFirst line\n第二行\n\n2\n00:00:01,500 --> 00:00:03,000\nCafé — déjà vu\n`;
  const track = parseSubRip(input);
  assert.deepEqual(track.cues.map((cue) => cue.id), ["10", "2"]);
  assert.equal(serializeSubRip(track), canonicalSrt);
  assert.deepEqual(parseSubRip(serializeSubRip(track)), track);
  assert.match(serializeWebVtt(track), /10\n00:00:00\.125/);
  assert.ok(serializeWebVtt(track).indexOf("\n10\n") < serializeWebVtt(track).indexOf("\n2\n"));
});

test("SRT export fails rather than discarding WebVTT-only identity or settings", () => {
  const vtt = parseWebVtt(canonicalVtt);
  throwsCaption(() => serializeSubRip(vtt), "CUT_CAPTION_ID", /positive canonical decimal/);
  const numericWithSettings = structuredClone(vtt);
  numericWithSettings.cues[0].id = "1";
  numericWithSettings.cues[1].id = "2";
  throwsCaption(() => serializeSubRip(numericWithSettings), "CUT_CAPTION_UNSUPPORTED", /cannot preserve/);
});

test("WebVTT rejects unsupported blocks, markup, malformed timing, controls, and settings", () => {
  const cases: Array<[string, CaptionErrorCode, RegExp]> = [
    ["WEBVTT metadata\n\n", "CUT_CAPTION_FORMAT", /exact WEBVTT header/],
    ["WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000\n\n", "CUT_CAPTION_UNSUPPORTED", /header metadata/],
    ["WEBVTT\n\nSTYLE\n::cue { color: red }\n", "CUT_CAPTION_UNSUPPORTED", /STYLE blocks/],
    ["WEBVTT\n\nREGION\nid:r1\n", "CUT_CAPTION_UNSUPPORTED", /REGION blocks/],
    ["WEBVTT\n\nNOTE source comment\nnot preserved\n", "CUT_CAPTION_UNSUPPORTED", /NOTE blocks/],
    ["WEBVTT\n\nid\n00:60.000 --> 00:61.000\ntext\n", "CUT_CAPTION_TIME", /exact milliseconds/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:01.00\ntext\n", "CUT_CAPTION_TIME", /exact milliseconds/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:01.000\ntext\n", "CUT_CAPTION_TIME", /positive duration/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000\n<i>styled<\/i>\n", "CUT_CAPTION_MARKUP", /does not render or strip/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000\nTom &amp; Jerry\n", "CUT_CAPTION_MARKUP", /does not render or strip/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000 line:10% line:20%\ntext\n", "CUT_CAPTION_SETTING", /repeats setting/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000 vertical:rl\ntext\n", "CUT_CAPTION_UNSUPPORTED", /vertical semantics/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000 position:101%\ntext\n", "CUT_CAPTION_SETTING", /0% through 100%/],
    ["WEBVTT\n\n00:01.000 --> 00:02.000\nmissing identifier\n", "CUT_CAPTION_FORMAT", /identifier/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000\nunsafe\ttext\n", "CUT_CAPTION_TEXT", /unsafe control/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000\ntext\rnext\n", "CUT_CAPTION_FORMAT", /Bare carriage/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000\nmid\ufeffbom\n", "CUT_CAPTION_ENCODING", /BOM is valid only/],
    ["WEBVTT\n\nid\n00:01.000 --> 00:02.000\nnoncharacter\ufffe\n", "CUT_CAPTION_TEXT", /unsafe control/],
    ["WEBVTT\n\nid\uffff\n00:01.000 --> 00:02.000\ntext\n", "CUT_CAPTION_TEXT", /unsafe control/],
  ];
  for (const [input, code, pattern] of cases) throwsCaption(() => parseWebVtt(input), code, pattern);
});

test("duplicate IDs and ambiguous or non-monotonic overlaps fail closed", () => {
  const duplicate = `WEBVTT

same
00:00:00.000 --> 00:00:01.000
one

same
00:00:01.000 --> 00:00:02.000
two
`;
  throwsCaption(() => parseWebVtt(duplicate), "CUT_CAPTION_ID", /Duplicate/);
  const overlap = duplicate.replace("same\n00:00:01.000", "next\n00:00:00.999");
  throwsCaption(() => parseWebVtt(overlap), "CUT_CAPTION_OVERLAP", /no overlap lane semantics/);
  const outOfOrder = duplicate.replace("same\n00:00:01.000 --> 00:00:02.000", "next\n00:00:00.000 --> 00:00:00.500");
  throwsCaption(() => parseWebVtt(outOfOrder), "CUT_CAPTION_OVERLAP", /overlaps or precedes/);
});

test("SubRip rejects noncanonical IDs, settings, timing, and formatting tags", () => {
  throwsCaption(() => parseSubRip("01\n00:00:00,000 --> 00:00:01,000\ntext\n"), "CUT_CAPTION_ID", /positive canonical decimal/);
  throwsCaption(() => parseSubRip("1\n00:00:00,000 --> 00:00:01,000 align:start\ntext\n"), "CUT_CAPTION_TIME", /unsupported settings/);
  throwsCaption(() => parseSubRip("1\n-00:00:00,001 --> 00:00:01,000\ntext\n"), "CUT_CAPTION_TIME", /exact milliseconds/);
  throwsCaption(() => parseSubRip("1\n00:00:00,000 --> 00:00:01,000\n{\\an8}positioned\n"), "CUT_CAPTION_MARKUP", /does not render or strip/);
  throwsCaption(() => parseSubRip(Uint8Array.from([0xc3, 0x28])), "CUT_CAPTION_ENCODING", /valid UTF-8/);
});

test("parser and serializer enforce independent byte, cue, line, and text budgets", () => {
  const one = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhello\n";
  const two = `${one.trimEnd()}\n\n2\n00:00:01.000 --> 00:00:02.000\nworld\n`;
  const multiline = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\na\nb\n";
  throwsCaption(() => parseWebVtt(one, { maxBytes: 10 }), "CUT_CAPTION_BUDGET", /maxBytes/);
  throwsCaption(() => parseWebVtt(two, { maxCues: 1 }), "CUT_CAPTION_BUDGET", /maxCues/);
  throwsCaption(() => parseWebVtt(multiline, { maxLines: 1 }), "CUT_CAPTION_BUDGET", /maxLines/);
  throwsCaption(() => parseWebVtt(multiline, { maxLinesPerCue: 1 }), "CUT_CAPTION_BUDGET", /maxLinesPerCue/);
  throwsCaption(() => parseWebVtt(one, { maxCueTextBytes: 4 }), "CUT_CAPTION_BUDGET", /maxCueTextBytes/);
  throwsCaption(() => parseWebVtt(two, { maxTextBytes: 9 }), "CUT_CAPTION_BUDGET", /maxTextBytes/);
  const track = parseWebVtt(one);
  throwsCaption(() => serializeWebVtt(track, { maxBytes: 10 }), "CUT_CAPTION_BUDGET", /maxBytes/);
});

test("typed caption tracks require canonical millisecond time and safe lossless payloads", () => {
  const track: CaptionTrack = {
    format: "cut-caption-track",
    version: 1,
    cues: [{ id: "cue", start: rational(0), end: rational(1), lines: ["plain Unicode ✓"] }],
  };
  assert.equal(validateCaptionTrack(track), track);

  const submillisecond = structuredClone(track);
  submillisecond.cues[0].end = rational(1, 3);
  throwsCaption(() => serializeWebVtt(submillisecond), "CUT_CAPTION_TIME", /exactly representable in milliseconds/);

  const unreduced = structuredClone(track);
  unreduced.cues[0].end = { numerator: "2", denominator: "2" };
  throwsCaption(() => serializeWebVtt(unreduced), "CUT_CAPTION_TIME", /reduced canonical rational/);

  const unknownSetting = structuredClone(track);
  unknownSetting.cues[0].settings = { snapToLines: true } as never;
  throwsCaption(() => serializeWebVtt(unknownSetting), "CUT_CAPTION_SETTING", /unsupported field/);

  const unsafe = structuredClone(track);
  unsafe.cues[0].lines = ["hidden\u202econtrol"];
  throwsCaption(() => serializeWebVtt(unsafe), "CUT_CAPTION_TEXT", /unsafe control/);

  const xmlNoncharacter = structuredClone(track);
  xmlNoncharacter.cues[0].lines = ["forbidden\uffff"];
  throwsCaption(() => serializeWebVtt(xmlNoncharacter), "CUT_CAPTION_TEXT", /unsafe control/);
});
