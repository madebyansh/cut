# Preview performance

CUT prioritizes deterministic pixels, bounded work, and exact media authority.
Those guarantees currently make some retained-media compositions slower than a
traditional interactive editor.

Use the normal iteration ladder:

1. `cut frame` for one decisive frame;
2. `cut contact` for composition and continuity;
3. `cut audition` for a bounded audio interval;
4. `cut preview --range ... --width 640` for motion;
5. `cut render` only after bounded proofs pass.

Picture and audio caches are identity-bound. A warm render may reuse verified
artifacts, but cache reuse never changes source, lock, graph, or output meaning.
Do not infer correctness from elapsed time alone.

The alpha does not promise real-time playback or a fixed render-time ratio.
Performance improvements must preserve pixels, samples, ordering, resource
authority, memory bounds, failure cleanup, and atomic publication.
