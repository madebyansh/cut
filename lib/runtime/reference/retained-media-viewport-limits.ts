/**
 * Acyclic resource constants shared by retained-media and MediaCamera2D.
 *
 * Keep this leaf free of runtime imports: both renderers participate in the
 * retained-path/anchor graph and must not initialize each other merely to read
 * numeric admission limits.
 */
export const referenceRetainedMediaViewportLimits = Object.freeze({
  maximumGroupDepth: 8,
  maximumNativeAxisPx: 16_384,
  maximumNativePixels: 67_108_864,
  maximumFitPixels: 67_108_864,
  maximumPixelWorkPerFrame: 268_435_456,
  maximumBranchesPerLocalSpace: 16,
  maximumBranchesPerExecutionDomain: 64,
  maximumAggregateNativePixels: 134_217_728,
  maximumAggregateCroppedPixels: 134_217_728,
  maximumAggregateFitPixels: 134_217_728,
  maximumAggregateViewportRgbaBytes: 268_435_456,
  maximumAggregatePixelWorkPerFrame: 536_870_912,
  maximumLocalCompositorTreeNodes: 4_096,
  maximumLocalCompositorSourceOverSteps: 8_192,
  maximumLocalCompositorPeakRgbaBytes: 536_870_912,
});
