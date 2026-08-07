import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { lexCut } from "../lib/language/lexer";
import { maximumParseDiagnostics, parseCutLanguage } from "../lib/language/parser";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError, CutCompileLimitError, CutCompileRationalLimitError } from "../lib/language/compiler";
import { applyCutLock, createCutLock, resolveLockedProjectPath } from "../lib/language/lock";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { propertyAt } from "../lib/runtime/reference/signals";
import { rational, rationalToNumber } from "../lib/language/rational";
import { builtinPackages } from "../lib/language/packages";
import { hash } from "../lib/core/stable";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { CutProjectError } from "../lib/project/manifest";

const parse = (source: string) => {
  const result = parseCutLanguage(source);
  assert.equal(result.diagnostics.length, 0, result.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(result.module);
  return result.module;
};

test("lexer distinguishes subtraction from identifiers", () => assert.deepEqual(lexCut("width-padding").slice(0, 3).map((item) => item.value), ["width", "-", "padding"]));
test("parser preserves timeline source order", () => {
  const cutModule = parse('cut 0.4; project "x"; timeline main(duration: 2s, fps: 24) { Text(content: "before"); scene one(duration: 1s) { Text(content: "inside"); } Text(content: "after"); } export out = render(main);');
  const timeline = cutModule.declarations.find((item) => item.kind === "timeline");
  assert.ok(timeline?.kind === "timeline"); assert.deepEqual(timeline.items.map((item) => item.kind), ["node", "scene", "node"]);
});
test("parser rejects positional arguments after named arguments", () => assert.match(parseCutLanguage('cut 0.4; project "x"; const bad = f(x: 1, 2);').diagnostics[0].message, /Positional arguments/));
test("parser recovers multiple independent syntax errors without exposing a partial AST", () => {
  const source = `cut 0.4;
project "multi-error";
const missing = ;
const ordering = f(x: 1, 2);
timeline main(duration: 1s, fps: 24) {
  scene one(duration: 1s) {
    let nestedMissing = ;
    let nestedOrdering = f(x: 1, 2);
  }
}
export out = render(main);`;
  const result = parseCutLanguage(source);
  assert.equal(result.module, null, "recovery diagnostics must never expose a partially recovered executable AST");
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["CUT1002", "CUT1002", "CUT1002", "CUT1002"]);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.span.start.offset),
    [source.indexOf(";", source.indexOf("const missing")), source.indexOf("2", source.indexOf("const ordering")), source.indexOf(";", source.indexOf("nestedMissing")), source.indexOf("2", source.indexOf("nestedOrdering"))],
  );
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.message), [
    'Expected an expression, found “;”.',
    "Positional arguments cannot follow named arguments.",
    'Expected an expression, found “;”.',
    "Positional arguments cannot follow named arguments.",
  ]);
});
test("parser syntax recovery has one closed diagnostic limit", () => {
  const source = Array.from({ length: maximumParseDiagnostics + 8 }, (_, index) => `unknown${index} value;`).join("\n");
  const result = parseCutLanguage(source);
  assert.equal(result.module, null);
  assert.equal(result.diagnostics.length, maximumParseDiagnostics);
  assert.ok(result.diagnostics.slice(0, -1).every((diagnostic) => diagnostic.code === "CUT1002"));
  assert.equal(result.diagnostics.at(-1)?.code, "CUT_DIAGNOSTIC_LIMIT");
  assert.match(result.diagnostics.at(-1)?.message ?? "", new RegExp(String(maximumParseDiagnostics)));
});
test("parser recovery ignores delimiter-like string bytes and resumes after an unclosed expression delimiter", () => {
  const source = `cut 0.4;
project "recovery-boundaries";
timeline main(duration: 1s, fps: 24) {
  scene one(duration: 1s) {
    let first = f(label: "{", value: ;
    let second = ;
  }
}`;
  const result = parseCutLanguage(source);
  assert.equal(result.module, null);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["CUT1002", "CUT1002"]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.span.start.offset), [
    source.indexOf(";", source.indexOf("value:")),
    source.indexOf(";", source.indexOf("let second")),
  ]);
});
test("parser recovery deduplicates propagated EOF failures before applying the diagnostic limit", () => {
  const prefix = Array.from({ length: maximumParseDiagnostics - 2 }, (_, index) => `unknown${index} value;`).join("\n");
  const source = `${prefix}\ntimeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { let value = 1;`;
  const result = parseCutLanguage(source);
  assert.equal(result.module, null);
  assert.equal(result.diagnostics.length, maximumParseDiagnostics - 1);
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.code === "CUT1002"));
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.span.start.offset === source.length).length, 1);
});
test("parser rejects excessive nesting with a source diagnostic instead of overflowing", () => {
  const nested = `${"(".repeat(300)}1${")".repeat(300)}`;
  const result = parseCutLanguage(`cut 0.4; project "deep"; const value = ${nested};`);
  assert.equal(result.module, null);
  assert.match(result.diagnostics[0]?.message ?? "", /nesting exceeds/);
});
test("type checker rejects mixed audiovisual dimensions", () => {
  const cutModule = parse('cut 0.4; project "x"; const impossible = 2s + 3px; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) {} } export out = render(main);');
  assert.ok(checkCutModule(cutModule).diagnostics.some((item) => item.code === "CUT2021"));
});
test("asset constructors are legal only as direct asset declaration initializers", () => {
  const valid = 'cut 0.4; project "assets"; asset source: VideoAsset = video("media/source.mp4");';
  assert.equal(checkCutModule(parse(valid)).diagnostics.filter((item) => item.severity === "error").length, 0);

  const invalidPrograms = [
    'cut 0.4; project "const-asset"; const source: VideoAsset = video("media/source.mp4");',
    'cut 0.4; project "let-asset"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { let source: VideoAsset = video("media/source.mp4"); } } export out = render(main);',
    'cut 0.4; project "argument-asset"; import { Video } from "cut:visual"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Video(source: video("media/source.mp4")); } } export out = render(main);',
  ];
  for (const source of invalidPrograms) {
    const constructorOffset = source.indexOf('video("media/source.mp4")');
    const diagnostics = checkCutModule(parse(source)).diagnostics.filter((item) => item.code === "CUT2057");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].message, 'Asset constructor “video” is only valid as the direct initializer of an asset declaration.');
    assert.match(diagnostics[0].hint ?? "", /asset name: VideoAsset = video\("path"\)/);
    assert.equal(diagnostics[0].span.start.offset, constructorOffset);
    assert.equal(diagnostics[0].span.end.offset, constructorOffset + "video".length);
    assert.throws(() => compileCutModule(parse(source)), CutCompileError);
  }
});
test("asset declarations reject aliases before lock resolution", () => {
  const source = 'cut 0.4; project "asset-alias"; asset original: VideoAsset = video("media/source.mp4"); asset copy: VideoAsset = original;';
  const diagnostic = checkCutModule(parse(source)).diagnostics.find((item) => item.code === "CUT2045");
  assert.equal(diagnostic?.message, 'asset “copy” must be created by a direct asset-constructor call.');
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);
});
test("positional and named media proxies both lower into canonical resource semantics", () => {
  const positional = compileCutModule(parse('cut 0.4; project "positional-proxy"; asset picture: VideoAsset = video("master.mov", "proxy.mp4"); asset sound: AudioAsset = audio("master.wav", "proxy.ogg");')).ir;
  const named = compileCutModule(parse('cut 0.4; project "named-proxy"; asset picture: VideoAsset = video(path: "master.mov", proxy: "proxy.mp4"); asset sound: AudioAsset = audio(path: "master.wav", proxy: "proxy.ogg");')).ir;
  for (const ir of [positional, named]) {
    assert.deepEqual(ir.resources.picture.proxy, { locator: "proxy.mp4" });
    assert.deepEqual(ir.resources.sound.proxy, { locator: "proxy.ogg" });
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(positional.resources).map(([id, resource]) => [id, { kind: resource.kind, locator: resource.locator, proxy: resource.proxy }])),
    Object.fromEntries(Object.entries(named.resources).map(([id, resource]) => [id, { kind: resource.kind, locator: resource.locator, proxy: resource.proxy }])),
  );
});
test("GeoPoint inputs accept structurally typed coordinate records", () => {
  const cutModule = parse('cut 0.4; project "geo"; import { Wavefront } from "@cut/geo"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Wavefront(origin: { latitude: 41, longitude: 129 }); } } export out = render(main);');
  assert.equal(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error").length, 0);
});
test("Path accepts closed Vec2 literals and rejects invalid point lookalikes", () => {
  const program = (points: string) => `cut 0.4; project "vectors"; import { Path } from "cut:visual"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Path(points: ${points}, stroke: #55d6be, width: 3px); } } export out = render(main);`;
  const valid = program("[{ x: 80px, y: 120px }, { x: 300px, y: 240px }, { x: 520px, y: 120px }]");
  assert.equal(checkCutModule(parse(valid)).diagnostics.filter((item) => item.severity === "error").length, 0);
  const node = Object.values(compileCutModule(parse(valid)).ir.nodes).find((item) => item.op === "cut.visual.path");
  assert.equal(node?.inputs.points.kind, "array");

  for (const points of [
    "[{ x: 80px }]",
    "[{ x: 80, y: 120px }]",
    "[{ x: 80px, y: 120px, label: \"not a coordinate\" }]",
    "[{ x: 80px, y: 120px }, { x: 300px, y: 240px, label: \"later extra\" }]",
  ]) {
    const source = program(points);
    assert.ok(checkCutModule(parse(source)).diagnostics.some((item) => ["CUT2011", "CUT2029"].includes(item.code)), points);
    assert.throws(() => compileCutModule(parse(source)), CutCompileError);
  }
});
test("top-level frame constants are rejected instead of silently assuming 30fps", () => {
  const cutModule = parse('cut 0.4; project "frames"; const beat = 12f; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) {} } export out = render(main);');
  const diagnostic = checkCutModule(cutModule).diagnostics.find((item) => item.code === "CUT2054");
  assert.match(diagnostic?.message ?? "", /ambiguous.*timeline's fps/);
  assert.throws(() => compileCutModule(cutModule), CutCompileError);
});
test("frame literals inside a timeline use that timeline's exact fps", () => {
  const source = 'cut 0.4; project "frames"; timeline main(duration: 48f, fps: 24) { scene one(duration: 24f) {} scene two(duration: 24f) {} } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir;
  assert.deepEqual(ir.compositions[0].duration, { numerator: "2", denominator: "1" });
  assert.deepEqual(Object.values(ir.scenes).map((scene) => scene.duration), [{ numerator: "1", denominator: "1" }, { numerator: "1", denominator: "1" }]);
});
test("forward top-level constants and asset paths resolve independent of declaration order", () => {
  const source = 'cut 0.4; project "forward"; import { Video } from "cut:visual"; const SOURCE = source; asset source: VideoAsset = video(PATH); const PATH = ROOT; const ROOT = "media/source.mp4"; timeline main(duration: 1s, fps: FPS) { scene one(duration: 1s) { Video(source: SOURCE); } } const FPS = 24; export out = render(main);';
  const ir = compileCutModule(parse(source)).ir;
  const video = Object.values(ir.nodes).find((node) => node.op === "cut.visual.video")!;
  assert.equal(ir.resources.source.locator, "media/source.mp4"); assert.deepEqual(video.inputs.source, { kind: "resource-ref", id: "source" }); assert.deepEqual(ir.compositions[0].fps, { numerator: "24", denominator: "1" });
});
test("forward type inference cannot hide an invalid timeline rate", () => {
  const source = 'cut 0.4; project "forward-types"; const FPS = LATER; const LATER = "twenty-four"; timeline main(duration: 1s, fps: FPS) { scene one(duration: 1s) {} } export out = render(main);';
  assert.ok(checkCutModule(parse(source)).diagnostics.some((item) => item.code === "CUT2049"));
});
test("top-level dependency cycles fail with a deterministic cycle path", () => {
  const source = 'cut 0.4; project "cycle"; const a = b; const b = a;';
  const cutModule = parse(source); assert.match(checkCutModule(cutModule).diagnostics.find((item) => item.code === "CUT2056")?.message ?? "", /a -> b -> a/);
  assert.throws(() => compileCutModule(cutModule), CutCompileError);
});
test("IR finalization rejects expressions that were not reduced", () => {
  const source = 'cut 0.4; project "symbolic"; const remainder = 5px % 2px;';
  assert.throws(() => compileCutModule(parse(source)), /constants\.remainder: binary expression was not reduced/);
});
test("radians lower through one deterministic rational degree boundary", () => {
  const program = (rotation: string) => `cut 0.4; project "angles"; import { Group, Rect } from "cut:visual"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Group(rotation: ${rotation}) { Rect(width: 2px, height: 2px); } } } export out = render(main);`;
  const radian = compileCutModule(parse(program("1rad"))).ir;
  const decimal = compileCutModule(parse(program("57.29577951308232deg"))).ir;
  const input = (ir: typeof radian) => Object.values(ir.nodes).find((node) => node.op === "cut.visual.group")!.inputs.rotation;
  assert.deepEqual(input(radian), input(decimal));
  assert.deepEqual(input(radian), { kind: "quantity", dimension: "angle", magnitude: rational("716197243913529", "12500000000000"), unit: "deg" });

  const arithmetic = compileCutModule(parse(program("1rad + 1deg"))).ir;
  assert.deepEqual(input(arithmetic), { kind: "quantity", dimension: "angle", magnitude: rational("728697243913529", "12500000000000"), unit: "deg" });
});
test("source and derived exact rationals share the CutAVIR digit budget", () => {
  const enormousDecimal = `0.${"0".repeat(399)}1`;
  const source = `cut 0.4; project "literal budget"; const tiny = ${enormousDecimal};`;
  const diagnostic = checkCutModule(parse(source)).diagnostics.find((item) => item.code === "CUT2064");
  const offset = source.indexOf(enormousDecimal);
  assert.equal(diagnostic?.message, "Exact numeric literal exceeds the 256-digit rational budget.");
  assert.deepEqual([diagnostic?.span.start.offset, diagnostic?.span.end.offset], [offset, offset + enormousDecimal.length]);
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);

  const reducible = `cut 0.4; project "reduced budget"; const exact = 1.${"0".repeat(300)};`;
  assert.equal(checkCutModule(parse(reducible)).diagnostics.filter((item) => item.code === "CUT2064").length, 0);
  assert.doesNotThrow(() => compileCutModule(parse(reducible)));

  const operand = "9".repeat(256);
  const derived = `cut 0.4; project "derived budget"; const tooLarge = ${operand} * ${operand};`;
  assert.equal(checkCutModule(parse(derived)).diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.throws(() => compileCutModule(parse(derived)), CutCompileRationalLimitError);
});
test("compile-time seconds conversion lowers to an exact time quantity", () => {
  const source = 'cut 0.4; project "seconds"; const length = seconds(2); timeline main(duration: length, fps: 24) { scene one(duration: length) {} } export out = render(main);';
  assert.deepEqual(compileCutModule(parse(source)).ir.compositions[0].duration, { numerator: "2", denominator: "1" });
});
test("nested node calls cannot masquerade as resolved runtime values", () => {
  const source = 'cut 0.4; project "nested"; import { AudioClip, Sidechain, Bus } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Bus() { Sidechain(source: AudioClip(source: voice), amount: -6db) { AudioClip(source: voice); } } } } export out = render(main);';
  assert.throws(() => compileCutModule(parse(source)), /cut\.audio\.clip.*not reduced to a runtime value kernel/);
});
test("built-in package integrity covers API and executable implementation bytes", () => {
  const package_ = builtinPackages.get("cut:visual")!;
  assert.match(package_.apiIntegrity, /^[a-f0-9]{64}$/); assert.match(package_.implementationIntegrity, /^[a-f0-9]{64}$/);
  assert.notEqual(package_.integrity, hash({ specifier: package_.specifier, version: package_.version, symbols: package_.symbols }));
  assert.equal(package_.integrity, hash({ apiIntegrity: package_.apiIntegrity, implementationIntegrity: package_.implementationIntegrity }));
});
test("language tour compiles into stable graph IR", async () => {
  const source = await readFile(resolve("examples/language-tour.cut"), "utf8"); const cutModule = parse(source);
  const first = compileCutModule(cutModule).ir, second = compileCutModule(cutModule).ir;
  assert.equal(first.buildId, second.buildId); assert.equal(first.format, "cut-av-ir"); assert.equal(first.version, 3);
  assert.equal(first.compositions.length, 1); assert.equal(Object.keys(first.scenes).length, 2); assert.ok(Object.keys(first.nodes).length >= 10); assert.ok(Object.keys(first.signals).length >= 4);
  assert.deepEqual(first.compositions[0].fps, { numerator: "24", denominator: "1" });
  const firstAnimation = Object.values(first.signals).find((item) => item.kind === "track" && item.events.some((event) => event.kind === "animate")); assert.ok(firstAnimation?.kind === "track");
  const animation = firstAnimation.events.find((event) => event.kind === "animate"); assert.ok(animation?.kind === "animate");
  assert.deepEqual(animation.start, { numerator: "0", denominator: "1" });
  assert.deepEqual(animation.end, { numerator: "5", denominator: "12" });
  assert.throws(() => compileCutModule(parse(source.replace("10s,", "10px,"))), CutCompileError);
});
test("lockfile hashes resources and detects later mutation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-lock-test-")); await mkdir(resolve(root, "media")); await writeFile(resolve(root, "media/source.bin"), "locked bytes");
  const source = 'cut 0.4; project "lock"; asset source: DataAsset = data("media/source.bin"); timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) {} } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  assert.equal(ir.determinism.semantic, "locked"); assert.match(ir.resources.source.sha256!, /^[a-f0-9]{64}$/);
  await writeFile(resolve(root, "media/source.bin"), "changed bytes"); await assert.rejects(() => applyCutLock(compileCutModule(parse(source)).ir, lock, root), /Locked resource bytes changed/);
});
test("lock application revalidates loaded IR before declaring it frozen", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-finalize-test-"));
  const source = 'cut 0.4; project "finalize"; import { Rect } from "cut:visual"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Rect(width: 8px, height: 8px); } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, lock = await createCutLock(ir, root); const rect = Object.values(ir.nodes).find((node) => node.op === "cut.visual.rect")!;
  rect.inputs.width = { kind: "symbol", name: "not-a-package-symbol" };
  await assert.rejects(() => applyCutLock(ir, lock, root), /IR is unresolved.*not-a-package-symbol/);
});
test("lockfile rejects lexical and symlink path escapes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-root-")), outside = await mkdtemp(resolve(tmpdir(), "cut-outside-")); await writeFile(resolve(outside, "secret"), "not allowed");
  await assert.rejects(
    () => resolveLockedProjectPath(root, "../secret"),
    (error: unknown) => error instanceof CutProjectError
      && error.code === "CUTP1004"
      && error.message === "resource locator cannot contain empty, dot, or parent segments.",
  );
  await symlink(resolve(outside, "secret"), resolve(root, "linked")); await assert.rejects(
    () => resolveLockedProjectPath(root, "linked"),
    (error: unknown) => error instanceof CutProjectError
      && error.code === "CUTP1014"
      && error.message === "Resource escapes the project root: linked",
  );
});
test("component invocations expand to disjoint child graphs", () => {
  const source = 'cut 0.4; project "components"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); component Label(value: String) -> Visual { Text(content: value, font: face); } timeline main(duration: 3s, fps: 24) { scene one(duration: 3s) { Label(value: "A"); Label(value: "B"); Label(value: "C"); } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir; const fragments = Object.values(ir.nodes).filter((node) => node.op === "cut.kernel.fragment"); const texts = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.text");
  assert.equal(fragments.length, 3); assert.equal(texts.length, 3); assert.equal(new Set(texts.map((node) => node.id)).size, 3);
  assert.deepEqual(texts.map((node) => node.inputs.content).map((value) => value.kind === "string" ? value.value : "?"), ["A", "B", "C"]);
});
test("user component invocation children follow the declared result domain", () => {
  const valid = `cut 0.4;
project "typed component children";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";
component PictureSlot() -> Visual {}
component SoundSlot() -> AudioNode {}
component EditSlot() -> AVNode {}
timeline main(duration: 1s, fps: 24) {
  scene one(duration: 1s) {
    PictureSlot() { Rect(width: 2px, height: 2px); }
    SoundSlot() { Tone(frequency: 440hz, duration: 1s); }
    EditSlot() { Rect(width: 2px, height: 2px); Tone(frequency: 220hz, duration: 1s); }
  }
}
export out = render(main);`;
  const checked = checkCutModule(parse(valid));
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const children = (name: string) => {
    const type = checked.symbols.get(name)?.type;
    assert.equal(type?.kind, "callable");
    return type?.kind === "callable" ? type.children : undefined;
  };
  assert.deepEqual([children("PictureSlot"), children("SoundSlot"), children("EditSlot")], ["visual", "audio", "any"]);
  assert.doesNotThrow(() => compileCutModule(parse(valid)));

  const invalid = [
    `cut 0.4; project "visual rejects audio"; import { Tone } from "@cut/audio"; component Slot() -> Visual {} timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Slot() { Tone(frequency: 440hz, duration: 1s); } } } export out = render(main);`,
    `cut 0.4; project "audio rejects visual"; import { Rect } from "cut:visual"; component Slot() -> AudioNode {} timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Slot() { Rect(width: 2px, height: 2px); } } } export out = render(main);`,
  ];
  for (const source of invalid) {
    const errors = checkCutModule(parse(source)).diagnostics.filter((item) => item.code === "CUT2033");
    assert.equal(errors.length, 1, source);
    assert.match(errors[0].message, /incompatible/);
    assert.throws(() => compileCutModule(parse(source)), CutCompileError);
  }
});
test("parser preserves implicit self as an ordinary component-body target", () => {
  const cutModule = parse('cut 0.4; project "self target"; component Card() -> Visual { set self.opacity = 50%; }');
  const component = cutModule.declarations.find((item) => item.kind === "component");
  assert.equal(component?.kind, "component");
  const statement = component?.kind === "component" ? component.body[0] : undefined;
  assert.equal(statement?.kind, "set");
  if (statement?.kind === "set") {
    assert.equal(statement.target.kind, "member");
    if (statement.target.kind === "member") assert.deepEqual({ object: statement.target.object.kind === "identifier" ? statement.target.object.name : undefined, property: statement.target.property }, { object: "self", property: "opacity" });
  }
});
test("self is closed to Visual component fragments and reserved against collisions", () => {
  const valid = 'cut 0.4; project "visual self"; import { Rect } from "cut:visual"; component Card() -> Visual { Rect(width: 10px, height: 10px); set self.opacity = 50%; animate self.x from 0px to 10px over 1s; }';
  assert.deepEqual(checkCutModule(parse(valid)).diagnostics.filter((item) => item.severity === "error"), []);

  const unavailable = [
    'cut 0.4; project "timeline self"; timeline main(duration: 1s, fps: 24) { set self.opacity = 50%; } export out = render(main);',
    'cut 0.4; project "audio self"; component Mix() -> AudioNode { set self.gain = 0db; }',
    'cut 0.4; project "av self"; component Edit() -> AVNode { set self.opacity = 50%; }',
    'cut 0.4; project "child self"; component Card() -> Visual {} timeline main(duration: 1s, fps: 24) { Card() { set self.opacity = 50%; } } export out = render(main);',
  ];
  for (const source of unavailable) {
    const diagnostics = checkCutModule(parse(source)).diagnostics;
    const unavailableSelf = diagnostics.filter((item) => item.code === "CUT2061");
    assert.equal(unavailableSelf.length, 1, source);
    const offset = source.indexOf("self.", source.indexOf("set "));
    assert.deepEqual([unavailableSelf[0].span.start.offset, unavailableSelf[0].span.end.offset], [offset, offset + "self".length]);
    assert.throws(() => compileCutModule(parse(source)), CutCompileError);
  }

  const unsupported = 'cut 0.4; project "closed self"; import { Rect } from "cut:visual"; component Card() -> Visual { Rect(width: 10px, height: 10px); set self.width = 20px; }';
  assert.ok(checkCutModule(parse(unsupported)).diagnostics.some((item) => item.code === "CUT2060" && /cut\.kernel\.fragment/.test(item.message)));
  const replacement = 'cut 0.4; project "replace self"; component Card() -> Visual { set self = self; }';
  assert.ok(checkCutModule(parse(replacement)).diagnostics.some((item) => item.code === "CUT2060" && /cannot be replaced/.test(item.message)));
  assert.throws(() => compileCutModule(parse(replacement)), CutCompileError);

  const collisions = [
    'cut 0.4; project "parameter collision"; component Card(self: Ratio) -> Visual {}',
    'cut 0.4; project "local collision"; component Card() -> Visual { let self = 1; }',
    'cut 0.4; project "node collision"; import { Rect } from "cut:visual"; component Card() -> Visual { Rect(width: 10px, height: 10px) as self; }',
    'cut 0.4; project "loop collision"; component Card() -> Visual { for self in [1] {} }',
    'cut 0.4; project "global collision"; const self = 1;',
  ];
  for (const source of collisions) {
    assert.ok(checkCutModule(parse(source)).diagnostics.some((item) => item.code === "CUT2062"), source);
    assert.throws(() => compileCutModule(parse(source)), CutCompileError);
  }
});
test("audio component fragments never expose visual transform properties", () => {
  const source = `cut 0.4;
project "audio fragment properties";
component Mix() -> AudioNode {}
timeline main(duration: 1s, fps: 24) {
  scene one(duration: 1s) {
    Mix() as mix;
    set mix.opacity = 50%;
    set mix.x = 1px;
    set mix.y = 1px;
    set mix.scale = 1;
    set mix.rotation = 1deg;
  }
}
export out = render(main);`;
  const errors = checkCutModule(parse(source)).diagnostics.filter((item) => item.code === "CUT2013");
  assert.equal(errors.length, 5);
  assert.deepEqual(errors.map((item) => item.message), ["opacity", "x", "y", "scale", "rotation"].map((property) => `Type AudioNode has no known member “${property}”.`));
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);
});
test("node properties are write-only and fail at the source read span", () => {
  const programs = [
    `cut 0.4; project "self read"; component Card() -> Visual { set self.opacity = self.opacity; }`,
    `cut 0.4; project "bound read"; import { Rect } from "cut:visual"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Rect(width: 2px, height: 2px) as tile; let copy = tile.opacity; } } export out = render(main);`,
    `cut 0.4; project "animation read"; import { Rect } from "cut:visual"; timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Rect(width: 2px, height: 2px) as tile; animate tile.opacity from tile.opacity to 100% over 1s; } } export out = render(main);`,
  ];
  for (const source of programs) {
    const read = source.includes("self.opacity") ? "self.opacity" : "tile.opacity";
    const offset = source.lastIndexOf(read);
    const errors = checkCutModule(parse(source)).diagnostics.filter((item) => item.code === "CUT2063");
    assert.equal(errors.length, 1, source);
    assert.equal(errors[0].message, `Node property “opacity” is write-only; property-read expressions are not implemented.`);
    assert.deepEqual([errors[0].span.start.offset, errors[0].span.end.offset], [offset, offset + read.length]);
    assert.throws(() => compileCutModule(parse(source)), CutCompileError);
  }

  const writes = `cut 0.4; project "writes stay valid"; import { Rect } from "cut:visual"; component Card() -> Visual { set self.opacity = 50%; } timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Card() as card; set card.x = 2px; at 250ms { animate card.opacity from 50% to 100% over 750ms; } } } export out = render(main);`;
  assert.deepEqual(checkCutModule(parse(writes)).diagnostics.filter((item) => item.severity === "error"), []);
  assert.doesNotThrow(() => compileCutModule(parse(writes)));
});
test("self tracks attach to each expanded fragment with exact temporal semantics", () => {
  const source = `cut 0.4;
project "fragment self";
import { Rect } from "cut:visual";
component Card(color: Color) -> Visual {
  Rect(width: 10px, height: 10px, fill: color);
  set self.opacity = 25%;
  at 1s { animate self.opacity from 25% to 100% over 1s; set self.x = 8px; }
}
timeline main(duration: 3s, fps: 24) {
  scene one(duration: 3s) {
    Card(color: #ff0000) { Rect(width: 2px, height: 2px, fill: #ffffff); }
    Card(color: #00ff00);
  }
}
export out = render(main);`;
  const ir = compileCutModule(parse(source)).ir;
  const fragments = Object.values(ir.nodes).filter((node) => node.op === "cut.kernel.fragment");
  assert.equal(fragments.length, 2);
  assert.equal(new Set(fragments.map((node) => node.id)).size, 2);
  assert.deepEqual(fragments.map((node) => node.children.length), [2, 1]);
  assert.ok(fragments.every((node) => node.children.every((id) => ir.nodes[id].ownership === "child")));
  const signalIds = fragments.flatMap((node) => Object.values(node.properties).flatMap((value) => "signal" in value ? [value.signal] : []));
  assert.equal(signalIds.length, 4);
  assert.equal(new Set(signalIds).size, 4);
  for (const fragment of fragments) {
    const before = propertyAt(ir, fragment, "opacity", rational(1, 2));
    const start = propertyAt(ir, fragment, "opacity", rational(1));
    const halfway = propertyAt(ir, fragment, "opacity", rational(3, 2));
    const after = propertyAt(ir, fragment, "opacity", rational(5, 2));
    const x = propertyAt(ir, fragment, "x", rational(1));
    assert.ok(before?.kind === "quantity" && start?.kind === "quantity" && halfway?.kind === "quantity" && after?.kind === "quantity" && x?.kind === "quantity");
    if (before?.kind === "quantity" && start?.kind === "quantity" && halfway?.kind === "quantity" && after?.kind === "quantity" && x?.kind === "quantity") {
      assert.deepEqual([before, start, halfway, after].map((value) => rationalToNumber(value.magnitude)), [.25, .25, .625, 1]);
      assert.deepEqual(x.magnitude, rational(8));
    }
  }
});
test("invocation children keep call-site self without receiving the callee fragment", () => {
  const source = `cut 0.4;
project "lexical self";
import { Rect } from "cut:visual";
component Slot() -> Visual {}
component Outer() -> Visual {
  Slot() {
    set self.x = 6px;
    Rect(width: 4px, height: 4px, fill: #ffffff);
  }
}
timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Outer(); } }
export out = render(main);`;
  const ir = compileCutModule(parse(source)).ir, fragments = Object.values(ir.nodes).filter((node) => node.op === "cut.kernel.fragment");
  assert.equal(fragments.length, 2);
  const outer = fragments.find((node) => node.children.some((child) => ir.nodes[child]?.op === "cut.kernel.fragment"))!;
  const slot = fragments.find((node) => node.id !== outer.id)!;
  assert.ok(outer.properties.x && "signal" in outer.properties.x);
  assert.equal(slot.properties.x, undefined);
  assert.deepEqual(slot.children.map((id) => ir.nodes[id].op), ["cut.visual.rect"]);
});
test("definition-side self and invocation-side fragment transforms are IR- and pixel-equivalent", async () => {
  const program = (inside: boolean) => `cut 0.4;
project "self equivalence";
import { Rect } from "cut:visual";
component Tile() -> Visual {
  Rect(width: 8px, height: 8px, fill: #ff5533);
  ${inside ? "set self.x = 3px; animate self.opacity from 25% to 100% over 1s;" : ""}
}
timeline main(duration: 2s, fps: 2, width: 32px, height: 32px, sampleRate: 8khz) {
  scene only(duration: 2s) {
    Tile()${inside ? ";" : " as tile; set tile.x = 3px; animate tile.opacity from 25% to 100% over 1s;"}
  }
}
export out = render(main, width: 32px, height: 32px, codec: "h264");`;
  const internal = compileCutModule(parse(program(true))).ir, external = compileCutModule(parse(program(false))).ir;
  const fragment = (ir: typeof internal) => Object.values(ir.nodes).find((node) => node.op === "cut.kernel.fragment")!;
  const track = (ir: typeof internal, property: string) => {
    const reference = fragment(ir).properties[property]; assert.ok(reference && "signal" in reference);
    const signal = reference && "signal" in reference ? ir.signals[reference.signal] : undefined;
    assert.equal(signal?.kind, "track");
    return signal?.kind === "track" ? { initial: signal.initial, events: signal.events } : undefined;
  };
  assert.deepEqual(fragment(internal).children.map((id) => internal.nodes[id].op), fragment(external).children.map((id) => external.nodes[id].op));
  assert.deepEqual(track(internal, "x"), track(external, "x"));
  assert.deepEqual(track(internal, "opacity"), track(external, "opacity"));

  const renderFrames = async (ir: typeof internal) => {
    const { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-self-equivalence-"));
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
    await renderer.prepare();
    try {
      const frames: number[][] = [];
      for (const frame of [0, 1, 2, 3]) frames.push([...(await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], frame)).data]);
      return frames;
    }
    finally { renderer.close(); }
  };
  assert.deepEqual(await renderFrames(internal), await renderFrames(external));
});
test("recursive components stop at the configured expansion budget", () => {
  const source = 'cut 0.4; project "recursive"; component Loop() -> Visual { Loop(); } timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Loop(); } } export out = render(main);';
  assert.throws(() => compileCutModule(parse(source), { maxExpansionDepth: 4 }), (error) => error instanceof CutCompileLimitError && error.limit === "maxExpansionDepth");
});
test("expanded loops stop at the configured graph budget", () => {
  const source = 'cut 0.4; project "bounded"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { for label in ["A", "B", "C"] { Text(content: label, font: face); } } } export out = render(main);';
  assert.throws(() => compileCutModule(parse(source), { maxNodes: 2 }), (error) => error instanceof CutCompileLimitError && error.limit === "maxNodes");
});
test("sequential writes compose into one signal and invalidate transitive cache keys", () => {
  const program = (last: string) => `cut 0.4; project "signals"; import { Text } from "cut:visual"; import { outCubic } from "@cut/motion"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 3s, fps: 24) { scene one(duration: 3s) { Text(content: "${last}", font: face) as title; animate title.opacity from 0% to 100% over 1s ease outCubic; at 1s { animate title.opacity from 100% to 50% over 1s ease outCubic; } } } export out = render(main);`;
  const first = compileCutModule(parse(program("A"))).ir, second = compileCutModule(parse(program("B"))).ir;
  assert.equal(Object.keys(first.signals).length, 1); const signal = Object.values(first.signals)[0]; assert.equal(signal.kind, "track"); if (signal.kind === "track") assert.deepEqual(signal.events.map((event) => event.kind), ["animate", "animate"]);
  const plan = createIncrementalRenderPlan(second, "main", createIncrementalRenderPlan(first, "main").manifest); assert.ok(plan.misses > 0);
});
test("let-bound node calls are references, not roots", () => {
  const source = 'cut 0.4; project "ownership"; import { AudioClip, Sidechain, Bus } from "@cut/audio"; asset voice: AudioAsset = audio("voice.wav"); timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { let key = AudioClip(source: voice); Bus() { Sidechain(source: key, amount: -6db) { AudioClip(source: voice); } } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, nodes = Object.values(ir.nodes); const key = nodes.find((node) => node.op === "cut.audio.clip" && node.ownership === "reference")!;
  assert.equal(key.ownership, "reference"); assert.ok(!Object.values(ir.scenes)[0].rootAudioIds.includes(key.id));
});
test("signals inside at blocks stay on the owning scene clock", () => {
  const source = 'cut 0.4; project "clock"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 2s, fps: 24) { scene one(duration: 2s) { at 1s { Text(content: "late", font: face) as label; animate label.opacity from 0% to 100% over 1s; } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.text")!;
  const halfway = propertyAt(ir, node, "opacity", rational(3, 2));
  assert.equal(halfway?.kind, "quantity"); if (halfway?.kind === "quantity") assert.ok(Math.abs(rationalToNumber(halfway.magnitude) - .5) < .00001);
});
test("multiple set statements are exact piecewise-constant writes and reject a superseded same-time write", () => {
  const source = 'cut 0.4; project "steps"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 3s, fps: 24) { scene one(duration: 3s) { Text(content: "no ghosts", font: face) as title; set title.opacity = 0%; at 1s { set title.opacity = 100%; } at 2s { set title.opacity = 0%; } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.text")!, signal = ir.signals[(node.properties.opacity as { signal: string }).signal];
  assert.equal(signal.kind, "track"); if (signal.kind === "track") {
    assert.deepEqual(signal.events.map((event) => event.kind), ["set", "set", "set"]);
    assert.deepEqual(signal.events.map((event) => event.kind === "set" ? event.time : event.start), [rational(0), rational(1), rational(2)]);
  }
  const opacity = (time: ReturnType<typeof rational>) => { const value = propertyAt(ir, node, "opacity", time); assert.equal(value?.kind, "quantity"); return value?.kind === "quantity" ? rationalToNumber(value.magnitude) : Number.NaN; };
  assert.equal(opacity(rational(1, 2)), 0);
  assert.equal(opacity(rational(1)), 1);
  assert.equal(opacity(rational(3, 2)), 1);
  assert.equal(opacity(rational(2)), 0);
  const redundant = source.replace(
    'at 2s { set title.opacity = 0%; }',
    'at 2s { set title.opacity = 50%; } at 2s { set title.opacity = 0%; }',
  );
  assert.throws(
    () => compileCutModule(parse(redundant)),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "CUT2085"
        && /events\[2\].*never changes an exact output-frame sample/u.test(diagnostic.message)),
  );
});
test("animate interpolates only inside its declared interval and holds outside it", () => {
  const source = 'cut 0.4; project "bounded-animation"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 3s, fps: 24) { scene one(duration: 3s) { Text(content: "bounded", font: face) as title; set title.opacity = 25%; at 1s { animate title.opacity from 0% to 100% over 1s; } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.text")!;
  const opacity = (time: ReturnType<typeof rational>) => { const value = propertyAt(ir, node, "opacity", time); assert.equal(value?.kind, "quantity"); return value?.kind === "quantity" ? rationalToNumber(value.magnitude) : Number.NaN; };
  assert.equal(opacity(rational(1, 2)), .25);
  assert.equal(opacity(rational(1)), 0);
  assert.equal(opacity(rational(3, 2)), .5);
  assert.equal(opacity(rational(2)), 1);
  assert.equal(opacity(rational(5, 2)), 1);
});
test("a future first write preserves the authored or runtime-default property before its event", () => {
  const source = 'cut 0.4; project "initial-track"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 2s, fps: 24) { scene one(duration: 2s) { Text(content: "default", font: face) as defaultTitle; Text(content: "authored", font: face, opacity: 40%) as authoredTitle; at 1s { set defaultTitle.opacity = 0%; set authoredTitle.opacity = 0%; } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, texts = Object.values(ir.nodes).filter((item) => item.op === "cut.visual.text");
  const defaultTitle = texts.find((item) => item.inputs.content.kind === "string" && item.inputs.content.value === "default")!;
  const authoredTitle = texts.find((item) => item.inputs.content.kind === "string" && item.inputs.content.value === "authored")!;
  const beforeDefault = propertyAt(ir, defaultTitle, "opacity", rational(1, 2));
  const beforeAuthored = propertyAt(ir, authoredTitle, "opacity", rational(1, 2));
  const afterDefault = propertyAt(ir, defaultTitle, "opacity", rational(1));
  assert.equal(beforeDefault?.kind, "quantity");
  assert.equal(beforeAuthored?.kind, "quantity");
  assert.equal(afterDefault?.kind, "quantity");
  if (beforeDefault?.kind === "quantity" && beforeAuthored?.kind === "quantity" && afterDefault?.kind === "quantity") {
    assert.deepEqual(
      [rationalToNumber(beforeDefault.magnitude), rationalToNumber(beforeAuthored.magnitude), rationalToNumber(afterDefault.magnitude)],
      [1, .4, 0],
    );
  }
});
test("mixed set and animate writes preserve holds and exact discontinuities", () => {
  const source = 'cut 0.4; project "mixed-track"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 4s, fps: 24) { scene one(duration: 4s) { Text(content: "cuts", font: face) as title; animate title.opacity from 0% to 100% over 1s; at 1s { set title.opacity = 0%; } at 2s { animate title.opacity from 25% to 75% over 1s; } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.text")!;
  const opacity = (time: ReturnType<typeof rational>) => { const value = propertyAt(ir, node, "opacity", time); assert.equal(value?.kind, "quantity"); return value?.kind === "quantity" ? rationalToNumber(value.magnitude) : Number.NaN; };
  assert.ok(opacity(rational(999, 1000)) > .998);
  assert.equal(opacity(rational(1)), 0);
  assert.equal(opacity(rational(3, 2)), 0);
  assert.equal(opacity(rational(2)), .25);
  assert.equal(opacity(rational(5, 2)), .5);
  assert.equal(opacity(rational(7, 2)), .75);
});
test("a later temporal write deterministically truncates an active animation", () => {
  const source = 'cut 0.4; project "override"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); timeline main(duration: 3s, fps: 24) { scene one(duration: 3s) { Text(content: "override", font: face) as title; animate title.opacity from 0% to 100% over 2s; at 1s { set title.opacity = 25%; } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.text")!;
  const before = propertyAt(ir, node, "opacity", rational(1, 2)), at = propertyAt(ir, node, "opacity", rational(1)), after = propertyAt(ir, node, "opacity", rational(3, 2));
  assert.equal(before?.kind, "quantity"); assert.equal(at?.kind, "quantity"); assert.equal(after?.kind, "quantity");
  if (before?.kind === "quantity" && at?.kind === "quantity" && after?.kind === "quantity") assert.deepEqual([rationalToNumber(before.magnitude), rationalToNumber(at.magnitude), rationalToNumber(after.magnitude)], [.25, .25, .25]);
});
test("component fragment opacity uses the same exact scene-clock signal semantics", () => {
  const source = 'cut 0.4; project "fragment-track"; import { Text } from "cut:visual"; asset face: FontAsset = font("face.ttf"); component Card(label: String) -> Visual { Text(content: label, font: face); } timeline main(duration: 3s, fps: 24) { scene one(duration: 3s) { Card(label: "fragment") as card; set card.opacity = 0%; at 1s { animate card.opacity from 0% to 100% over 1s; } at 5f { set card.x = 12px; } } } export out = render(main);';
  const ir = compileCutModule(parse(source)).ir, fragment = Object.values(ir.nodes).find((item) => item.op === "cut.kernel.fragment")!;
  const before = propertyAt(ir, fragment, "opacity", rational(1, 2)), halfway = propertyAt(ir, fragment, "opacity", rational(3, 2)), after = propertyAt(ir, fragment, "opacity", rational(5, 2)), x = propertyAt(ir, fragment, "x", rational(5, 24));
  assert.equal(before?.kind, "quantity"); assert.equal(halfway?.kind, "quantity"); assert.equal(after?.kind, "quantity"); assert.equal(x?.kind, "quantity");
  if (before?.kind === "quantity" && halfway?.kind === "quantity" && after?.kind === "quantity" && x?.kind === "quantity") {
    assert.deepEqual([rationalToNumber(before.magnitude), rationalToNumber(halfway.magnitude), rationalToNumber(after.magnitude)], [0, .5, 1]);
    assert.deepEqual(x.magnitude, rational(12));
  }
});
