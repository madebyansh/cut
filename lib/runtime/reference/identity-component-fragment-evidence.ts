import { hash } from "../../core/stable";
import type { Rational } from "../../language/rational";
import type { ReferenceCalloutRenderedFrameEvidence } from "./callout";
import {
  referenceIdentityComponentFragmentChildBinding,
  validateReferenceIdentityComponentFragmentFrameEnvelope,
  type ReferenceIdentityComponentFragmentConfig,
  type ReferenceIdentityComponentFragmentFrameEvidence,
} from "./identity-component-fragment";
import type { ReferenceMediaCamera2DExecutionEvidence } from "./media-camera2d";
import type { ReferenceResponsiveStackFrameEvidence } from "./responsive-layout";
import {
  validateReferenceResponsiveSlotMediaAnchorFrameEvidence,
  type ReferenceResponsiveSlotMediaAnchorLinkEvidence,
} from "./responsive-slot-media-anchor";
import type { ReferenceAnchoredPathFrameEvidence } from "./visual";

export type ReferenceIdentityComponentFragmentFrameLedgers = Readonly<{
  anchoredPaths: readonly ReferenceAnchoredPathFrameEvidence[];
  calloutLayers: readonly ReferenceCalloutRenderedFrameEvidence[];
  cameras: readonly ReferenceMediaCamera2DExecutionEvidence[];
  responsiveStacks: readonly ReferenceResponsiveStackFrameEvidence[];
  slotMediaAnchorLinks: readonly ReferenceResponsiveSlotMediaAnchorLinkEvidence[];
}>;

function sameTime(left: Rational, right: Rational) {
  return left.numerator === right.numerator
    && left.denominator === right.denominator;
}

function fail(fragmentNodeId: string, detail: string): never {
  throw new Error(
    `CUT_IDENTITY_FRAGMENT_EVIDENCE: fragment ${fragmentNodeId} ${detail}`,
  );
}

const digestPattern = /^[a-f0-9]{64}$/u;

function exactBinding(
  config: ReferenceIdentityComponentFragmentConfig,
  childNodeId: string,
  binding: ReferenceAnchoredPathFrameEvidence["identityComponentFragment"],
) {
  return binding !== undefined
    && hash(binding) === hash(
      referenceIdentityComponentFragmentChildBinding(config, childNodeId),
    );
}

/**
 * Authenticate one serialized fragment receipt against every independently
 * completed same-frame source ledger. This is the persisted/public validator;
 * the envelope-only helper intentionally cannot establish these relations.
 */
export function validateReferenceIdentityComponentFragmentFrameEvidence(
  evidence: ReferenceIdentityComponentFragmentFrameEvidence,
  config: ReferenceIdentityComponentFragmentConfig,
  ledgers: ReferenceIdentityComponentFragmentFrameLedgers,
  trustedSceneOutputRgbaSha256: string,
) {
  validateReferenceIdentityComponentFragmentFrameEnvelope(evidence, config);
  if (!digestPattern.test(trustedSceneOutputRgbaSha256)
    || evidence.sceneOutputRgbaSha256 !== trustedSceneOutputRgbaSha256) {
    fail(
      config.fragmentNodeId,
      "scene output does not match the trusted completed renderer surface.",
    );
  }

  // Rebuild and authenticate the complete slot-anchor ledger first. Besides
  // comparing links, this validates camera/stack receipt hashes, full Callout
  // semantics, anchored geometry identities and camera-stack media bindings.
  validateReferenceResponsiveSlotMediaAnchorFrameEvidence(
    ledgers.slotMediaAnchorLinks,
    config.compositionId,
    ledgers.anchoredPaths,
    ledgers.calloutLayers,
    ledgers.cameras,
    ledgers.responsiveStacks,
  );

  const cameras = ledgers.cameras.filter((receipt) =>
    receipt.cameraNodeId === config.cameraNodeId
    && receipt.outputFrame === evidence.outputFrame
    && sameTime(receipt.exactTime, evidence.exactTime));
  const stacks = ledgers.responsiveStacks.filter((receipt) =>
    receipt.nodeId === config.stackNodeId
    && receipt.outputFrame === evidence.outputFrame
    && sameTime(receipt.exactTime, evidence.exactTime));
  if (cameras.length !== 1 || stacks.length !== 1) {
    fail(config.fragmentNodeId, "does not have exactly one same-frame camera and ResponsiveStack ledger receipt.");
  }

  const paths = ledgers.anchoredPaths.filter((receipt) =>
    receipt.identityComponentFragment?.fragmentNodeId === config.fragmentNodeId);
  if (paths.length !== (config.pathNodeId ? 1 : 0)
    || (config.pathNodeId !== undefined
      && (paths[0]?.consumerNodeId !== config.pathNodeId
        || paths[0].outputFrame !== evidence.outputFrame
        || !sameTime(paths[0].exactTime, evidence.exactTime)
        || !exactBinding(
          config,
          config.pathNodeId,
          paths[0].identityComponentFragment,
        )))) {
    fail(config.fragmentNodeId, "anchored Path ledger is incomplete, stale, or cross-bound.");
  }

  const callouts = ledgers.calloutLayers.filter((receipt) =>
    receipt.identityComponentFragment?.fragmentNodeId === config.fragmentNodeId);
  if (callouts.length !== (config.calloutLayerNodeId ? 1 : 0)
    || (config.calloutLayerNodeId !== undefined
      && (callouts[0]?.layerNodeId !== config.calloutLayerNodeId
        || callouts[0].outputFrame !== evidence.outputFrame
        || !sameTime(callouts[0].exactTime, evidence.exactTime)
        || !exactBinding(
          config,
          config.calloutLayerNodeId,
          callouts[0].identityComponentFragment,
        )))) {
    fail(config.fragmentNodeId, "CalloutLayer ledger is incomplete, stale, or cross-bound.");
  }

  const links = ledgers.slotMediaAnchorLinks.filter((receipt) =>
    receipt.identityComponentFragment?.fragmentNodeId === config.fragmentNodeId);
  for (const link of links) {
    const bindingChild = link.consumerNodeId === config.pathNodeId
      ? config.pathNodeId
      : config.calloutNodeIds.includes(link.consumerNodeId)
        ? config.calloutLayerNodeId
        : undefined;
    if (!bindingChild
      || link.outputFrame !== evidence.outputFrame
      || !sameTime(link.exactTime, evidence.exactTime)
      || !exactBinding(config, bindingChild, link.identityComponentFragment)) {
      fail(config.fragmentNodeId, "slot-camera anchor link ledger contains a foreign, stale, or cross-bound receipt.");
    }
  }

  const expected = Object.freeze({
    cameraExecutions: Object.freeze(cameras.map((receipt) => Object.freeze({
      nodeId: receipt.cameraNodeId,
      executionIdentity: receipt.executionIdentity,
    }))),
    responsiveStackExecutions: Object.freeze(stacks.map((receipt) => Object.freeze({
      nodeId: receipt.nodeId,
      executionIdentity: receipt.executionIdentity,
    }))),
    anchoredPathExecutions: Object.freeze(paths.map((receipt) => Object.freeze({
      nodeId: receipt.consumerNodeId,
      executionIdentity: receipt.executionIdentity,
      evidenceIdentity: receipt.evidenceIdentity,
    }))),
    calloutLayerExecutions: Object.freeze(callouts.map((receipt) => Object.freeze({
      nodeId: receipt.layerNodeId,
      executionIdentity: receipt.executionIdentity,
    }))),
    slotMediaAnchorLinks: Object.freeze(links.map((receipt) => Object.freeze({
      consumerNodeId: receipt.consumerNodeId,
      linkIdentity: receipt.linkIdentity,
    })).sort((left, right) =>
      left.consumerNodeId.localeCompare(right.consumerNodeId)
      || left.linkIdentity.localeCompare(right.linkIdentity))),
  });
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (hash(evidence[key]) !== hash(expected[key])) {
      fail(
        config.fragmentNodeId,
        `${key} does not equal the authenticated same-frame source ledger.`,
      );
    }
  }

  const stackChild = evidence.children.find((child) =>
    child.nodeId === config.stackNodeId);
  if (!stackChild || stackChild.outputRgbaSha256 !== stacks[0]!.outputRgbaSha256) {
    fail(config.fragmentNodeId, "ResponsiveStack child pixels do not match the stack ledger.");
  }
  if (config.pathNodeId) {
    const pathChild = evidence.children.find((child) =>
      child.nodeId === config.pathNodeId);
    if (!pathChild
      || !digestPattern.test(paths[0]!.outputRgbaSha256 ?? "")
      || pathChild.outputRgbaSha256 !== paths[0]!.outputRgbaSha256) {
      fail(config.fragmentNodeId, "anchored Path child pixels do not match its authenticated rendered-output ledger.");
    }
  }
  if (config.calloutLayerNodeId) {
    const calloutChild = evidence.children.find((child) =>
      child.nodeId === config.calloutLayerNodeId);
    if (!calloutChild
      || calloutChild.outputRgbaSha256 !== callouts[0]!.outputRgbaSha256) {
      fail(config.fragmentNodeId, "CalloutLayer child pixels do not match the Callout ledger.");
    }
  }
  return evidence;
}
