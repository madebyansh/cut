/**
 * Executable reference-kernel contract.
 *
 * This registry is deliberately closed. A name appearing in a package
 * manifest is not evidence that the reference backend implements it: a kernel
 * is renderable only when this table says so, and only the listed inputs,
 * properties, and child shape are accepted. Both the checker and reference
 * runtime consume this table so their capability claims cannot drift apart.
 */

import { cutAudioBusKinds, cutAudioRoles } from "./audio-role";
import { cutDiagramDirections } from "./diagram-contract";
import {
  cutMediaCamera2DEdges,
  cutMediaCamera2DInputs,
  cutMediaCamera2DOp,
  cutMediaCamera2DProperties,
  cutMediaCamera2DResponsiveSlotContextInput,
} from "./media-camera2d-contract";
import {
  cutTimelineAudioEvaluationPolicies,
  cutTimelineAudioFadeAnchorPolicies,
  cutTimelineAudioOriginInputs,
  cutTimelineAudioOriginKinds,
  cutTimelineAudioOriginOp,
  cutTimelineAudioStatePolicies,
  cutTimelineAudioViewInputs,
  cutTimelineAudioViewOp,
} from "./timeline-edit-audio-origin-contract";
import { cutVideoInputColorProfiles } from "./video-input-color";

export type KernelDomain = "visual" | "audio" | "av";
export type KernelChildren = "none" | "visual" | "audio" | "av" | "any";
export type KernelPropertyValueType = "Angle" | "Frequency" | "Gain" | "Length" | "Number" | "Ratio" | "Time" | "TruePeak";

export type SupportedKernelSchema = {
  support: "supported";
  domain: KernelDomain | "any";
  inputs: readonly string[];
  properties: readonly string[];
  /** Declared semantic type carried by every signal attached to a property. */
  propertyTypes: Readonly<Record<string, KernelPropertyValueType>>;
  children: KernelChildren;
  /** Closed literal contracts shared by source checks and runtime validation. */
  stringInputs: Readonly<Record<string, readonly string[]>>;
  /** Public authoring operands consumed entirely by compiler lowering and
   * therefore forbidden in persisted CutAVIR/runtime inputs. */
  authoringInputs?: readonly string[];
  /** Compiler-derived typed inputs accepted by strict loading and execution,
   * but intentionally unavailable as public constructor parameters. */
  compilerInputs?: readonly string[];
  /** Same-named constructor inputs consumed by primitive geometry, not by a property's transform baseline. */
  intrinsicPropertyInputs: readonly string[];
  /** Closed direct-child cardinality. Zero is permitted only when the kernel
   * has a meaningful empty identity or a stricter conditional contract. */
  minimumChildren: number;
  maximumChildren?: number;
};

export type RefusedKernelSchema = {
  support: "refused";
  domain: KernelDomain;
  reason: string;
};

export type KernelSchema = SupportedKernelSchema | RefusedKernelSchema;

const visualTransformInputs = ["opacity", "scale", "rotation"] as const;
const visualTransformProperties = ["opacity", "x", "y", "scale", "rotation"] as const;
const groupTransformProperties = [...visualTransformProperties, "anchorX", "anchorY", "skewX", "skewY"] as const;
const motionPathProperties = [...groupTransformProperties, "progress"] as const;

/**
 * One canonical property-type vocabulary is shared by checker-facing kernels,
 * compiler signal lowering, the strict IR loader, and the runtime. Property
 * names are intentionally closed: adding an executable property without a
 * declared signal type is a module-load error rather than an `inferred` IR
 * escape hatch.
 */
const declaredKernelPropertyTypes: Readonly<Record<string, KernelPropertyValueType>> = Object.freeze({
  opacity: "Ratio",
  x: "Length",
  y: "Length",
  z: "Length",
  focalLength: "Length",
  targetX: "Length",
  targetY: "Length",
  targetZ: "Length",
  roll: "Angle",
  rotationX: "Angle",
  rotationY: "Angle",
  rotationZ: "Angle",
  focusDepth: "Length",
  focusX: "Ratio",
  focusY: "Ratio",
  zoom: "Number",
  anchorX: "Length",
  anchorY: "Length",
  scale: "Number",
  rotation: "Angle",
  skewX: "Angle",
  skewY: "Angle",
  progress: "Ratio",
  morph: "Ratio",
  trimStart: "Ratio",
  trimEnd: "Ratio",
  dashOffset: "Length",
  reveal: "Ratio",
  strength: "Ratio",
  exposure: "Number",
  temperature: "Number",
  tint: "Number",
  brightness: "Number",
  saturation: "Number",
  hue: "Angle",
  contrast: "Number",
  intensity: "Number",
  amount: "Gain",
  latitude: "Number",
  longitude: "Number",
  bearing: "Angle",
  pitch: "Angle",
  position: "Ratio",
  wet: "Ratio",
  frequency: "Frequency",
  gain: "Gain",
  q: "Number",
  threshold: "Gain",
  ceiling: "TruePeak",
  ratio: "Number",
  attack: "Time",
  release: "Time",
  makeup: "Gain",
});

const supported = (
  domain: KernelDomain | "any",
  inputs: readonly string[],
  children: KernelChildren = "none",
  properties: readonly string[] = [],
  stringInputs: Readonly<Record<string, readonly string[]>> = {},
  intrinsicPropertyInputs: readonly string[] = [],
  childCardinality: Readonly<{ minimum: number; maximum?: number }> = { minimum: 0 },
  propertyTypeOverrides: Readonly<Record<string, KernelPropertyValueType>> = {},
): SupportedKernelSchema => {
  const propertyTypes = Object.fromEntries(properties.map((property) => {
    const valueType = propertyTypeOverrides[property] ?? declaredKernelPropertyTypes[property];
    if (!valueType) throw new Error(`Executable kernel property ${property} has no declared semantic signal type.`);
    return [property, valueType];
  }));
  return {
    support: "supported",
    domain,
    inputs,
    properties,
    propertyTypes,
    children,
    stringInputs,
    intrinsicPropertyInputs,
    minimumChildren: childCardinality.minimum,
    ...(childCardinality.maximum === undefined ? {} : { maximumChildren: childCardinality.maximum }),
  };
};

const refused = (domain: KernelDomain, reason: string): RefusedKernelSchema => ({ support: "refused", domain, reason });

export const referenceKernelRegistry: Readonly<Record<string, KernelSchema>> = Object.freeze({
  "cut.kernel.fragment": supported("any", [], "any", visualTransformProperties),

  "cut.visual.video": supported("visual", ["source", "range", "fit", "crop", "loop", "endBehavior", "inputColor", "inputColorInterpretation", "x", "y", ...visualTransformInputs], "none", visualTransformProperties, { fit: ["cover", "contain", "fill"], endBehavior: ["error", "hold"], inputColor: cutVideoInputColorProfiles }),
  "cut.visual.image": supported("visual", ["source", "fit", "crop", "x", "y", ...visualTransformInputs], "none", visualTransformProperties, { fit: ["cover", "contain", "fill"] }),
  "cut.visual.image_sequence": supported("visual", ["source", "range", "fit", "crop", "loop", "endBehavior", "x", "y", ...visualTransformInputs], "none", visualTransformProperties, { fit: ["cover", "contain", "fill"], endBehavior: ["error", "hold"] }),
  "cut.visual.precomp": {
    ...supported(
      "visual",
      ["source", "range", "x", "y", "scale", "rotation", "opacity"],
      "none",
      visualTransformProperties,
    ),
    // These fields establish canonical PictureTrack editorial identity during
    // compiler lowering. They never become renderer inputs.
    authoringInputs: ["editId", "role", "metadata"],
  },
  "cut.visual.text": supported("visual", [
    "content", "font", "size", "color", "align", "x", "y", "maxWidth", "lineHeight", "maxLines",
    "tracking", "letterSpacing", "shadowColor", "shadowOpacity", "shadowBlur", ...visualTransformInputs,
  ], "none", visualTransformProperties, { align: ["start", "middle", "end"] }, ["x", "y"]),
  "cut.visual.flow_text": supported("visual", [
    "spans", "font", "size", "color", "tracking", "baselineShift", "shaping", "motions", "layoutX", "baselineY", "maxWidth", "lineHeight", "maxLines", "align", "x", "y",
    ...visualTransformInputs,
  ], "none", visualTransformProperties, { align: ["start", "middle", "end"] }),
  "cut.visual.captions": supported("visual", [
    "source", "font", "format", "size", "color", "background", "position", "align", "safeX", "safeY",
    "maxWidth", "padding", "radius", "lineHeight",
  ], "none", [], { format: ["webvtt", "srt"], position: ["cue", "top", "bottom"], align: ["cue", "left", "center", "right"] }),
  "cut.visual.transcript_captions": {
    ...supported("visual", [
      "font", "maxWords", "size", "color", "background", "position", "align", "safeX", "safeY",
      "maxWidth", "padding", "radius", "lineHeight",
    ], "none", [], { position: ["cue", "top", "bottom"], align: ["cue", "left", "center", "right"] }),
    authoringInputs: ["edit"],
    compilerInputs: ["transcriptBindingId", "transcriptCaptionIdentity"],
  },
  "cut.visual.rect": supported("visual", ["width", "height", "fill", "radius", "gradientFrom", "gradientTo", "x", "y", ...visualTransformInputs], "none", visualTransformProperties, {}, ["x", "y"]),
  "cut.visual.circle": supported("visual", ["radius", "fill", "x", "y", ...visualTransformInputs], "none", visualTransformProperties, {}, ["x", "y"]),
  "cut.visual.path": supported(
    "visual",
    [
      "points", "stroke", "width", ...visualTransformInputs,
      "geometry", "morphTo", "morph", "trimStart", "trimEnd", "dash", "dashOffset",
      "fill", "fillRule", "lineCap", "lineJoin", "x", "y",
    ],
    "none",
    ["opacity", "x", "y", "scale", "rotation", "morph", "trimStart", "trimEnd", "dashOffset"],
    { fillRule: ["nonzero", "evenodd"], lineCap: ["butt", "round", "square"], lineJoin: ["miter", "round", "bevel"] },
  ),
  "cut.visual.trace": supported("visual", [
    "points", "stroke", "width", "duration", "delay", "headRadius", "headColor", "headFade", "easing", ...visualTransformInputs, "start", "curves", "arrow",
  ], "none", visualTransformProperties, { easing: ["linear", "inCubic", "outCubic", "inOutCubic"] }),
  "cut.visual.group": supported("visual", ["x", "y", "anchorX", "anchorY", "scale", "skewX", "skewY", "rotation", "opacity"], "visual", groupTransformProperties),
  "cut.visual.local_space": supported("visual", ["width", "height", "origin"], "visual", [], {}, [], { minimum: 1, maximum: 256 }),
  "cut.visual.callout_layer": supported("visual", [], "visual", [], {}, [], { minimum: 1, maximum: 64 }),
  "cut.visual.callout": supported(
    "visual",
    ["anchor", "placements", "offset", "safeArea", "priority", "leader", "leaderColor", "leaderWidth", "opacity"],
    "visual",
    ["opacity"],
    { leader: ["none", "straight", "elbow"] },
    [],
    { minimum: 1, maximum: 1 },
  ),
  "cut.visual.responsive_stack": supported("visual", ["plan"], "visual", [], {}, [], { minimum: 1, maximum: 64 }),
  "cut.visual.responsive_slot": supported("visual", [], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.diagram.layout": supported(
    "visual",
    ["state", "fromState", "progress", "direction", "width", "height", "x", "y", "safeX", "safeY", "nodeGap", "rankGap", "edgeGap", "edgeClearance"],
    "visual",
    ["progress"],
    { direction: cutDiagramDirections },
    [],
    { minimum: 1, maximum: 64 },
  ),
  "cut.diagram.node": supported(
    "visual",
    ["id", "width", "height", "rank"],
    "visual",
    [],
    {},
    [],
    { minimum: 1, maximum: 256 },
  ),
  "cut.visual.motion_path": supported(
    "visual",
    ["points", "geometry", "progress", "closed", "orientToPath", "x", "y", "anchorX", "anchorY", "scale", "skewX", "skewY", "rotation", "opacity"],
    "visual",
    motionPathProperties,
    {},
    [],
    { minimum: 1, maximum: 1 },
  ),
  "cut.visual.track_2d": supported(
    "visual",
    ["source", "minConfidence", "lowConfidence", "occluded", "outOfFrame", "interpolation", "bindScale", "bindRotation", "x", "y", "scale", "rotation", "opacity"],
    "visual",
    visualTransformProperties,
    {
      lowConfidence: ["fail", "hold", "hide"],
      occluded: ["fail", "hold", "hide"],
      outOfFrame: ["fail", "hold", "hide"],
      interpolation: ["linear", "hold"],
    },
    [],
    { minimum: 1, maximum: 1 },
  ),
  "cut.visual.planar_track": supported(
    "visual",
    ["source", "minConfidence", "lowConfidence", "occluded", "outOfFrame", "interpolation", "opacity"],
    "visual",
    ["opacity"],
    {
      lowConfidence: ["fail", "hold", "hide"],
      occluded: ["fail", "hold", "hide"],
      outOfFrame: ["fail", "hold", "hide"],
      interpolation: ["linear", "hold"],
    },
    [],
    { minimum: 1, maximum: 1 },
  ),
  "cut.visual.stack": supported(
    "visual",
    ["direction", "gap", "align", "distribution", "padding", "safeArea", "width", "height", "x", "y", "opacity", "scale", "rotation"],
    "visual",
    visualTransformProperties,
    {
      direction: ["horizontal", "vertical"],
      align: ["start", "center", "end"],
      distribution: ["start", "center", "end", "space-between", "space-around", "space-evenly"],
    },
  ),
  "cut.visual.composite": supported("visual", ["blend", "x", "y", "scale", "rotation", "opacity"], "visual", visualTransformProperties, { blend: ["normal", "source-over", "multiply", "screen", "overlay", "darken", "lighten", "add", "plus", "difference"] }),
  "cut.visual.mask": supported("visual", ["mode", "invert", "feather", "expand", "x", "y", "scale", "rotation", "opacity"], "visual", visualTransformProperties, { mode: ["alpha", "luminance", "red", "green", "blue"] }, [], { minimum: 2, maximum: 2 }),
  "cut.visual.clip_path": supported("visual", ["points", "fillRule", "invert"], "visual", [], { fillRule: ["nonzero", "evenodd"] }, [], { minimum: 1, maximum: 1 }),
  "cut.visual.chroma_key": supported("visual", ["key", "tolerance", "softness", "spill"], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.motion_blur": supported(
    "visual",
    ["shutterAngle", "samples", "startEdge"],
    "visual",
    [],
    { startEdge: ["hold", "transparent"] },
    [],
    { minimum: 1, maximum: 1 },
  ),
  "cut.visual.blur": supported("visual", ["radius"], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.shadow": supported("visual", ["x", "y", "radius", "color", "opacity"], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.glow": supported("visual", ["radius", "color", "opacity"], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.vignette": supported("visual", ["amount", "radius", "softness", "color"], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.sharpen": supported("visual", ["radius", "amount"], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.grain": supported("visual", ["amount", "size", "seed", "mode", "monochrome"], "visual", [], { mode: ["static", "temporal"] }, [], { minimum: 1, maximum: 1 }),
  "cut.visual.duotone": supported("visual", ["shadows", "highlights", "amount"], "visual", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.camera2d": supported("visual", ["x", "y", "scale", "rotation", "opacity"], "visual", visualTransformProperties),
  [cutMediaCamera2DOp]: {
    ...supported(
      "visual",
      cutMediaCamera2DInputs,
      "visual",
      cutMediaCamera2DProperties,
      { edge: cutMediaCamera2DEdges },
      [],
      { minimum: 1, maximum: 1 },
    ),
    compilerInputs: [cutMediaCamera2DResponsiveSlotContextInput],
  },
  "cut.visual.parallax_camera": supported(
    "visual",
    ["focalLength", "ordering", "focus", "focusDepth", "focusRange", "maxBlur", "x", "y", "z"],
    "visual",
    ["x", "y", "z", "focusDepth"],
    { ordering: ["depth", "source"], focus: ["off", "linear"] },
    [],
    { minimum: 2, maximum: 64 },
  ),
  "cut.visual.depth_layer": supported(
    "visual",
    ["depth", "edge"],
    "visual",
    [],
    { edge: ["transparent", "clamp"] },
    [],
    { minimum: 1, maximum: 16 },
  ),
  "cut.visual.camera3d": supported(
    "visual",
    ["focalLength", "x", "y", "z", "targetX", "targetY", "targetZ", "roll"],
    "visual",
    ["focalLength", "x", "y", "z", "targetX", "targetY", "targetZ", "roll"],
    {},
    [],
    { minimum: 2, maximum: 16 },
  ),
  "cut.visual.plane3d": supported(
    "visual",
    ["x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale", "opacity", "edge"],
    "visual",
    ["x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale", "opacity"],
    { edge: ["transparent"] },
    [],
    { minimum: 1, maximum: 1 },
  ),
  "cut.visual.lut": supported("visual", ["source", "strength"], "visual", ["strength"], {}, [], { minimum: 1, maximum: 1 }),
  "cut.visual.tonal_curve": supported("visual", ["points", "space", "channel", "alpha"], "visual", [], { space: ["srgb", "linear-srgb"], channel: ["rgb", "red", "green", "blue"], alpha: ["straight"] }, [], { minimum: 1, maximum: 1 }),
  "cut.visual.color_convert": supported("visual", ["from", "to", "alpha"], "visual", [], { from: ["srgb", "linear-srgb", "rec709-full", "rec709-limited"], to: ["srgb", "linear-srgb", "rec709-full", "rec709-limited"], alpha: ["straight"] }, [], { minimum: 1, maximum: 1 }),
  "cut.visual.color_grade": supported("visual", ["exposure", "temperature", "tint", "brightness", "saturation", "hue", "contrast", "x", "y", "scale", "rotation", "opacity"], "visual", [...visualTransformProperties, "exposure", "temperature", "tint", "brightness", "saturation", "hue", "contrast"], {}, [], { minimum: 1, maximum: 1 }),

  "cut.geo.annotation": supported(
    "visual",
    ["anchor", "width", "height", "placements", "offset", "safeArea", "priority", "leader", "leaderColor", "leaderWidth", "opacity"],
    "visual",
    ["opacity"],
    { leader: ["none", "straight", "elbow"] },
    [],
    { minimum: 1, maximum: 1 },
  ),
  "cut.geo.map_camera": supported(
    "visual",
    ["latitude", "longitude", "scale", "bearing", "pitch"],
    "visual",
    ["latitude", "longitude", "scale", "bearing", "pitch"],
    {},
    [],
    { minimum: 1, maximum: 64 },
  ),
  "cut.geo.globe": supported("visual", ["points", "stations", "rotation", "tilt", "radius", "x", "y", "markerRadius", "ocean", "land", "line", "signal", "reveal", "scale", "opacity"], "none", [...visualTransformProperties, "reveal"], {}, ["x", "y", "rotation"]),
  "cut.geo.map": supported("visual", ["points", "font", "signal", "reveal", ...visualTransformInputs, "detail", "background", "land", "border", "borderWidth", "graticule", "graticuleWidth"], "none", [...visualTransformProperties, "reveal"], { detail: ["110m", "50m", "10m"] }),
  "cut.geo.route": supported("visual", ["points", "color", "stroke", "width", "reveal", ...visualTransformInputs], "none", [...visualTransformProperties, "reveal"]),
  "cut.geo.route_subject": supported("visual", ["points", "progress", "color", "radius", "opacity"], "none", ["progress", "opacity"]),
  "cut.geo.marker": supported("visual", ["point", "font", "projection", "color", "radius", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius", "label", ...visualTransformInputs], "none", visualTransformProperties, { projection: ["map", "globe"] }),
  "cut.geo.wavefront": supported("visual", ["origin", "projection", "x", "y", "globeRotation", "globeTilt", "globeX", "globeY", "globeRadius", "radius", "color", "count", "reveal", ...visualTransformInputs], "none", [...visualTransformProperties, "reveal"], { projection: ["canvas", "map", "globe"] }, ["x", "y"]),
  "cut.geo.connections": supported("visual", ["points", "stations", "target", "font", "count", "color", "width", "reveal", ...visualTransformInputs], "none", [...visualTransformProperties, "reveal"]),

  "cut.data.waveform": supported("visual", ["source", "range", "reveal", ...visualTransformInputs], "none", [...visualTransformProperties, "reveal"]),
  "cut.data.spectrogram": supported("visual", ["source", "range", "reveal", ...visualTransformInputs], "none", [...visualTransformProperties, "reveal"]),
  "cut.data.chart": supported(
    "visual",
    ["values", "kind", "width", "height", "x", "y", "min", "max", "primary", "secondary", "background", "showAxes", "axisColor", "gap", "strokeWidth", "reveal", ...visualTransformInputs],
    "none",
    [...visualTransformProperties, "reveal"],
    { kind: ["bar", "line", "area"] },
    ["x", "y"],
  ),
  "cut.data.series_chart": supported(
    "visual",
    [
      "query", "font", "frame", "xScale", "yScale", "series", "kind", "labelSize",
      "axisColor", "gridColor", "background", "strokeWidth", "pointRadius", "showLegend",
      "reveal", ...visualTransformInputs,
    ],
    "none",
    [...visualTransformProperties, "reveal"],
    { kind: ["bar", "line", "area"] },
  ),
  "cut.documentary.evidence": supported("visual", ["research", "claimId", "font", "x", "y", "size", "color", "accent", "maxWidth", "mode", ...visualTransformInputs], "none", visualTransformProperties, { mode: ["claim-card", "source-chip"] }, ["x", "y"]),

  "cut.audio.clip": {
    ...supported("audio", ["source", "range", "fadeIn", "fadeOut", "destination", "link", "headHandle", "tailHandle"]),
    authoringInputs: ["editId", "role", "metadata"],
    compilerInputs: ["transcriptBindingId"],
  },
  "cut.documentary.narration": supported("audio", ["source", "range", "fadeIn", "fadeOut"]),
  "cut.audio.synth": supported("audio", ["events", "waveform", "attack", "decay", "sustain", "release", "polyphony"], "none", [], { waveform: ["sine", "triangle", "saw", "square"] }),
  "cut.audio.tone": supported("audio", ["frequency", "duration", "amplitude", "fadeIn", "fadeOut"]),
  "cut.audio.noise": supported("audio", ["duration", "color", "amplitude", "seed", "fadeIn", "fadeOut"], "none", [], { color: ["white", "pink", "brown", "blue", "violet", "velvet"] }),
  "cut.audio.bus": supported("audio", ["name", "role", "kind"], "audio", [], { role: cutAudioRoles, kind: cutAudioBusKinds }, [], { minimum: 1 }),
  "cut.audio.submix": supported("audio", ["name"], "audio", [], {}, [], { minimum: 1 }),
  "cut.audio.send": supported("audio", ["amount", "source", "tap"], "audio", ["amount"], { tap: ["post", "pre-fader"] }, [], { minimum: 0 }),
  "cut.audio.return": supported("audio", ["sends"]),
  "cut.audio.gain": supported("audio", ["amount"], "audio", ["amount"], {}, [], { minimum: 1 }),
  "cut.audio.pan": supported("audio", ["position"], "audio", ["position"], {}, [], { minimum: 1 }),
  "cut.audio.channel_matrix": supported("audio", ["leftToLeft", "leftToRight", "rightToLeft", "rightToRight"], "audio", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.audio.eq": supported("audio", ["frequency", "gain", "q"], "audio", ["frequency", "gain", "q"], {}, [], { minimum: 1 }),
  "cut.audio.highpass": supported("audio", ["frequency", "q"], "audio", ["frequency", "q"], {}, [], { minimum: 1 }),
  "cut.audio.lowpass": supported("audio", ["frequency", "q"], "audio", ["frequency", "q"], {}, [], { minimum: 1 }),
  "cut.audio.compressor": supported("audio", ["threshold", "ratio", "attack", "release", "makeup"], "audio", ["threshold", "ratio", "attack", "release", "makeup"], {}, [], { minimum: 1 }),
  "cut.audio.time_stretch": supported("audio", ["sourceDuration", "duration", "pitch", "quality"], "audio", [], { quality: ["draft", "balanced"] }, [], { minimum: 1, maximum: 1 }),
  "cut.audio.deesser": supported(
    "audio",
    ["intensity", "amount"],
    "audio",
    ["intensity", "amount"],
    {},
    [],
    { minimum: 1 },
    { intensity: "Number", amount: "Number" },
  ),
  "cut.audio.limiter": supported("audio", ["ceiling", "release", "lookahead"], "audio", ["ceiling", "release"], {}, [], { minimum: 1 }),
  "cut.audio.reverb": supported("audio", ["wet"], "audio", ["wet"], {}, [], { minimum: 1 }),
  "cut.audio.delay": supported("audio", ["time", "repeats", "decay", "wet"], "audio", ["wet"], {}, [], { minimum: 1 }),
  "cut.audio.tempo_delay": supported("audio", ["tempo", "delay", "feedback", "mix"], "audio", [], {}, [], { minimum: 1, maximum: 1 }),
  "cut.audio.sidechain": supported("audio", ["source", "amount", "threshold", "attack", "release"], "audio", ["amount", "threshold", "attack", "release"], {}, [], { minimum: 1 }),
  "cut.audio.meter": supported("audio", ["target", "truePeak", "samplePeak", "range"], "audio", [], {}, [], { minimum: 1 }),

  "cut.edit.clip": supported("av", ["source", "range", "duration", "fadeIn", "fadeOut", "inputColor", "inputColorInterpretation", ...visualTransformInputs], "none", visualTransformProperties, { inputColor: cutVideoInputColorProfiles }),
  "cut.edit.nested_sequence": supported("av", ["source", "range"], "none"),
  "cut.edit.sequence": supported("visual", ["duration"], "visual", [], {}, [], { minimum: 1 }),
  "cut.edit.picture_track": {
    ...supported("visual", ["sourceDuration", "edits"], "visual", [], {}, [], { minimum: 1 }),
    authoringInputs: ["trackId", "role", "metadata"],
  },
  "cut.edit.picture_clip": {
    ...supported(
      "visual",
      ["source", "range", "duration", "headHandle", "tailHandle", "playback", "rate", "freezeAt", "speedRamp", "fit", "inputColor", "inputColorInterpretation", ...visualTransformInputs, "link", "frameSelection"],
      "none",
      visualTransformProperties,
      {
        fit: ["cover", "contain", "fill"],
        playback: ["normal", "reverse", "freeze"],
        inputColor: cutVideoInputColorProfiles,
        frameSelection: ["floor", "nearest", "frame-blend", "optical-flow"],
      },
    ),
    authoringInputs: ["editId", "role", "metadata"],
    compilerInputs: [
      "transcriptBindingId",
      "transcriptPictureIdentity",
      "transcriptMediaAuthorityId",
      "transcriptPictureOriginIdentity",
      "transcriptPictureSegmentIdentity",
    ],
  },
  "cut.edit.transcript_picture": supported("visual", ["edit", "source", "fit", "opacity", "scale", "rotation", "inputColor", "inputColorInterpretation", "duration", "rate"], "none", [], { fit: ["cover", "contain", "fill"], inputColor: cutVideoInputColorProfiles }),
  "cut.edit.gap": supported("visual", ["duration"]),
  "cut.edit.audio_track": {
    ...supported("audio", ["sourceDuration", "edits"], "audio", [], {}, [], { minimum: 1 }),
    authoringInputs: ["trackId", "role", "metadata"],
  },
  "cut.edit.transcript_audio": supported("audio", ["edit", "fadeIn", "fadeOut"]),
  "cut.edit.audio_region": {
    ...supported("audio", ["destination", "link", "headHandle", "tailHandle"], "audio", [], {}, [], { minimum: 1, maximum: 1 }),
    authoringInputs: ["editId", "role", "metadata"],
  },
  [cutTimelineAudioOriginOp]: {
    ...supported(
      "audio",
      [],
      "audio",
      [],
      {
        originKind: cutTimelineAudioOriginKinds,
        statePolicy: cutTimelineAudioStatePolicies,
        fadeAnchorPolicy: cutTimelineAudioFadeAnchorPolicies,
        evaluationPolicy: cutTimelineAudioEvaluationPolicies,
      },
      [],
      { minimum: 1, maximum: 1 },
    ),
    compilerInputs: cutTimelineAudioOriginInputs,
  },
  [cutTimelineAudioViewOp]: {
    ...supported(
      "audio",
      [],
      "none",
      [],
      {
        originKind: cutTimelineAudioOriginKinds,
        statePolicy: cutTimelineAudioStatePolicies,
        fadeAnchorPolicy: cutTimelineAudioFadeAnchorPolicies,
        evaluationPolicy: cutTimelineAudioEvaluationPolicies,
      },
    ),
    compilerInputs: cutTimelineAudioViewInputs,
  },
  "cut.edit.audio_gap": supported("audio", ["destination"]),
  "cut.edit.transition": supported(
    "av",
    ["kind", "duration", "direction", "softness", "color"],
    "av",
    [],
    {
      kind: ["cross-dissolve", "dip", "wipe", "push", "slide"],
      direction: ["left", "right", "up", "down"],
    },
    [],
    { minimum: 2, maximum: 2 },
  ),
  "cut.edit.jcut": supported("av", ["overlap"], "av", [], {}, [], { minimum: 2, maximum: 2 }),
  "cut.edit.lcut": supported("av", ["overlap"], "av", [], {}, [], { minimum: 2, maximum: 2 }),

  "cut.visual.shader": refused("visual", "The native/WASM/shader extension boundary is not implemented."),
  "cut.visual.light": refused("visual", "3D light semantics are not implemented."),
  "cut.documentary.captions": refused("visual", "Legacy CaptionTrack has no executable timed-cue semantics; import the strict locked Captions source from cut:visual."),
  "cut.edit.time_remap": refused("av", "Time-remapping semantics are not implemented."),
});

export function referenceKernelSchema(op: string): KernelSchema | undefined {
  return referenceKernelRegistry[op];
}

export function kernelAcceptsInput(schema: SupportedKernelSchema, input: string) {
  return schema.inputs.includes(input) || schema.compilerInputs?.includes(input) === true;
}

export function kernelAcceptsAuthoringInput(schema: SupportedKernelSchema, input: string) {
  return schema.inputs.includes(input) || schema.authoringInputs?.includes(input) === true;
}

export function kernelAcceptsProperty(schema: SupportedKernelSchema, property: string) {
  return schema.properties.includes(property);
}

export function kernelPropertyValueType(schema: SupportedKernelSchema, property: string) {
  return schema.propertyTypes[property];
}

export function kernelStringInputValues(schema: SupportedKernelSchema, input: string) {
  return schema.stringInputs[input];
}

export function kernelPropertyInputIsIntrinsic(schema: SupportedKernelSchema, property: string) {
  return schema.intrinsicPropertyInputs.includes(property);
}
