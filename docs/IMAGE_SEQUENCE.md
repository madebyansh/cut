# Image sequences

CUT's bounded image-sequence profile uses explicit ordered assets. It never
globs a directory, infers filename order, or trusts host filesystem discovery.

```cut
import { ImageSequence } from "cut:visual";

asset manifest: DataAsset = data("plates/sequence.json");
asset f000: ImageAsset = image("plates/f000.png");
asset f001: ImageAsset = image("plates/f001.png");

timeline main(duration: 2f, fps: 24, width: 1920px, height: 1080px) {
  scene only(duration: 2f) {
    ImageSequence(source: imageSequence(
      manifest: manifest,
      frames: [f000, f001],
      width: 1920px,
      height: 1080px,
      frameRate: 24,
      frameCount: 2
    ));
  }
}
```

The strict `cut-image-sequence-manifest` v1 repeats the exact width, height,
rational frame rate, frame count, and for each ordered member its CUT resource
ID, project-local locator, and lowercase SHA-256. `cut lock` independently
probes every image and rejects missing, duplicate, reordered, dimensionally
inconsistent, or mutated members before pixels execute. The selected member
bytes and ordinal are part of the renderer cache identity.

The v1 limits are 1–4096 distinct members, axes no larger than 32768 pixels,
at most 100 million pixels per member, an exact cadence no greater than 240fps,
and at most 24 hours. Direct visual execution supports half-open source ranges,
`loop`, `endBehavior: "hold"`, fit/crop, and ordinary visual transforms.
ImageSequence inside PictureTrack, OTIO, or LocalSpace is not admitted by this
profile and must not be inferred from this direct surface.
