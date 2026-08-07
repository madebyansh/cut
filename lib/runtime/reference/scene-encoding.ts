/**
 * Closed identity for cached picture segments that are joined by stream copy.
 *
 * Independently encoded H.264 segments cannot safely carry reordered B-frames:
 * their negative decode timestamps are rebased by the concat demuxer and can
 * make the joined MP4 declare a shorter duration than its presentation span.
 * Keeping this contract in the cache key prevents an older reordered segment
 * from being reused after the concat-safe encoder policy changes.
 */
export const referenceSceneEncodingContract = Object.freeze({
  format: "cut-reference-scene-encoding",
  version: 2,
  container: "mp4",
  inputFormat: "rawvideo",
  inputPixelFormat: "rgba",
  codec: "h264-libx264",
  encoder: "libx264",
  bFrames: 0,
  preset: "medium",
  crf: 16,
  outputPixelFormat: "yuv420p",
  colorPolicy: "cut-sdr-bt709-x264-v1",
  movFlags: "+faststart",
  join: "concat-demuxer-stream-copy",
});
