import type { CutAVIR, IRResource } from "../../language/ir";
import type { LockedResourceProbe } from "../../language/lock";
import { finalizeGraphHashes } from "../graph";
import { registerReferenceMediaProfileExecution } from "./media-profile-state";
import { assertAppliedCutLockIr } from "../../language/locked-ir-state";
import type { CutAudioProxyAlignment } from "../../language/audio-proxy-alignment";
import type { CutVideoProxyAlignment } from "../../language/video-proxy-alignment";

export type ReferenceMediaProfile = "master" | "proxy";

type LockedMediaVariant = {
  locator: string;
  sha256: string;
  bytes: number;
  probe: LockedResourceProbe;
  audioAlignment?: CutAudioProxyAlignment;
  videoAlignment?: CutVideoProxyAlignment;
};

type ProxyResourceMetadata = {
  lockVersion: 2;
  bytes: number;
  probe: LockedResourceProbe;
  proxy?: LockedMediaVariant;
  /** Selected-execution trust evidence; identical for master and proxy. */
  authoredProxy?: boolean;
  audioProxyAlignment?: CutAudioProxyAlignment;
  videoProxyAlignment?: CutVideoProxyAlignment;
};

export type ReferenceMediaSelection = {
  resourceId: string;
  kind: "video" | "audio";
  requested: ReferenceMediaProfile;
  selected: ReferenceMediaProfile;
  fallback: boolean;
  locator: string;
  sha256: string;
};

export type ReferenceMediaProfileEvidence = {
  requested: ReferenceMediaProfile;
  selectedProxyResources: number;
  fallbackResources: number;
  resources: ReferenceMediaSelection[];
};

export class ReferenceMediaProfileError extends Error {
  readonly source: { module: string; line: number; column: number; resourceId: string };

  constructor(readonly code: "CUT_PROXY_LOCK_STATE", resource: IRResource, message: string) {
    const span = resource.provenance.span;
    super(`${code}: ${message} at ${resource.provenance.module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceMediaProfileError";
    this.source = {
      module: resource.provenance.module,
      line: span.start.line,
      column: span.start.column,
      resourceId: resource.id,
    };
  }
}

export class ReferenceMediaProfileRequestError extends Error {
  constructor(readonly code: "CUT_PROXY_PROFILE", readonly requested: unknown) {
    super(`${code}: media profile must be exactly "master" or "proxy"; received ${JSON.stringify(requested)}.`);
    this.name = "ReferenceMediaProfileRequestError";
  }
}

function mediaMetadata(resource: IRResource): ProxyResourceMetadata {
  const metadata = resource.metadata as Partial<ProxyResourceMetadata> | undefined;
  if (resource.state !== "locked" || !resource.sha256 || metadata?.lockVersion !== 2 || !metadata.probe || typeof metadata.bytes !== "number") {
    throw new ReferenceMediaProfileError("CUT_PROXY_LOCK_STATE", resource, `media resource ${JSON.stringify(resource.id)} is not backed by validated cut.lock v2 metadata`);
  }
  return metadata as ProxyResourceMetadata;
}

/**
 * Select the locked execution variant without mutating the canonical locked IR.
 * The selected locator/hash/probe become ordinary resource identity before any
 * cache plan is built, so a proxy preview can never reuse master-decoded media
 * (or vice versa) merely because the authored timeline is unchanged.
 */
export function selectReferenceMediaProfile(ir: CutAVIR, requested: ReferenceMediaProfile) {
  if (requested !== "master" && requested !== "proxy") {
    throw new ReferenceMediaProfileRequestError("CUT_PROXY_PROFILE", requested);
  }
  assertAppliedCutLockIr(ir);
  const execution = structuredClone(ir) as CutAVIR;
  const resources: ReferenceMediaSelection[] = [];

  for (const resource of Object.values(execution.resources).sort((left, right) => left.id.localeCompare(right.id))) {
    if (resource.kind !== "video" && resource.kind !== "audio") continue;
    const metadata = mediaMetadata(resource);
    const proxy = requested === "proxy" ? metadata.proxy : undefined;
    const selected: ReferenceMediaProfile = proxy ? "proxy" : "master";

    // The canonical locked IR retains both variants for audit/replay. An
    // execution profile retains only the chosen variant so proxy-only changes
    // cannot invalidate final/master caches and master-only changes cannot
    // invalidate a proxy preview.
    const authoredProxySelection = resource.proxy?.streamSelection;
    delete resource.proxy;
    if (proxy) {
      resource.locator = proxy.locator;
      resource.sha256 = proxy.sha256;
      if (authoredProxySelection) resource.streamSelection = authoredProxySelection;
      else delete resource.streamSelection;
      resource.metadata = {
        lockVersion: 2,
        bytes: proxy.bytes,
        probe: proxy.probe,
        activeMediaVariant: "proxy",
        authoredProxy: true,
        ...(proxy.audioAlignment ? { audioProxyAlignment: proxy.audioAlignment } : {}),
        ...(proxy.videoAlignment ? { videoProxyAlignment: proxy.videoAlignment } : {}),
      };
    } else {
      resource.metadata = {
        lockVersion: 2,
        bytes: metadata.bytes,
        probe: metadata.probe,
        activeMediaVariant: "master",
        ...(metadata.proxy ? { authoredProxy: true } : {}),
      };
    }

    resources.push({
      resourceId: resource.id,
      kind: resource.kind,
      requested,
      selected,
      fallback: requested === "proxy" && selected === "master",
      locator: resource.locator,
      sha256: resource.sha256!,
    });
  }

  // A graph with no video/audio resources has no profile-dependent execution
  // identity. Keep it canonical rather than changing every parent node hash
  // merely because a caller requested “master” or “proxy”.
  if (resources.length > 0) registerReferenceMediaProfileExecution(execution);
  finalizeGraphHashes(execution);
  const evidence: ReferenceMediaProfileEvidence = {
    requested,
    selectedProxyResources: resources.filter((resource) => resource.selected === "proxy").length,
    fallbackResources: resources.filter((resource) => resource.fallback).length,
    resources,
  };
  return { ir: execution, evidence };
}
