/**
 * Closed professional audio-role vocabulary shared by the public package,
 * typed kernel contract, reference runtime, and stem-delivery manifest.
 *
 * A role is authored routing metadata. It intentionally does not imply gain,
 * processing, ducking, mastering, or any other sonic operation.
 */
export const cutAudioRoles = ["dialogue", "music", "ambience", "sfx"] as const;

export type CutAudioRole = typeof cutAudioRoles[number];

export function isCutAudioRole(value: string): value is CutAudioRole {
  return (cutAudioRoles as readonly string[]).includes(value);
}

/**
 * Closed delivery/routing behavior for a top-level audio Bus. Program buses own
 * ordinary dry material. Aux buses own only processor chains fed by explicit
 * Return references to Sends in program buses, so their delivered stems remain
 * additive and independently controllable.
 */
export const cutAudioBusKinds = ["program", "aux"] as const;

export type CutAudioBusKind = typeof cutAudioBusKinds[number];

export function isCutAudioBusKind(value: string): value is CutAudioBusKind {
  return (cutAudioBusKinds as readonly string[]).includes(value);
}
