# CUT alpha feedback

`cut-lang@0.4.0-alpha.4` is a controlled early-access build, not CUT 1.0.
It is useful for evaluating typed authoring, deterministic compilation, locked
assets, picture/audio execution, interchange, packages, and compact workflows.

## Feedback profile

- macOS on Apple silicon is the officially supported target;
- Linux source and package execution is experimental;
- stable Node.js 24.x is maintained, with Node.js 20.19 or newer retained as a
  compatibility lane within the Node.js 20 release line;
- the FFmpeg and ffprobe identities accepted by `cut doctor` and `cut lock`;
- installation from the exact SHA-256-bound tarball supplied with its verifier
  report; and
- trusted local projects and media.

Windows descriptor-bound media execution, package signing, hostile multi-tenant
rendering, and arbitrary third-party extensions are not release claims. Linux
results are portability feedback, not a parity or performance claim. Do not
expose the alpha as a public render service or run untrusted projects outside an
isolated OS account/container.

## What to try

Follow [FIRST_USE.md](FIRST_USE.md) from a new directory outside the CUT
repository. Useful feedback includes:

- whether `cut init`, format, check, lint, lock, build, inspect, test, frame,
  contact, audition, preview, and render form a clear authoring loop;
- whether source-located diagnostics make a broken program easy to repair;
- whether the documentary, product, podcast/social, education/data, and
  travel/social constructs in [PRACTICAL_WORKFLOWS.md](PRACTICAL_WORKFLOWS.md)
  are understandable and reusable; and
- whether the exact supported semantics produce deterministic pixels, samples,
  and media on an unchanged replay.

## Known practical limitation

Long or composition-heavy previews are CPU-bound and do not yet meet CUT's
frozen performance target. Small projects, isolated frames, contacts, and short
review ranges are the productive alpha workflow. Expect some longer renders to
take minutes rather than seconds. This is a failed iteration-speed gate, not a
known permission to change pixels, samples, timing, or lock semantics; report
any such correctness drift separately. See [PREVIEW_PERFORMANCE.md](PREVIEW_PERFORMANCE.md).

## A useful report

Include:

1. the CUT package version and tarball SHA-256;
2. `node --version`, `cut --version`, and the non-private portions of
   `cut doctor --json`;
3. the smallest redistributable `.cut` source and synthetic/public test assets
   that reproduce the problem;
4. the exact command, exit code, and stable CUT diagnostic code;
5. whether the problem is correctness, usability, performance, or an
   unsupported-semantics refusal; and
6. for deterministic-output problems, both artifact hashes and the adjacent
   CUT manifests.

Do not attach API keys, `.env` files, private footage/audio, proprietary fonts,
user-home paths, raw process dumps, or a lock whose source/media bytes cannot be
shared. Open a repository issue as described in [CONTRIBUTING.md](../CONTRIBUTING.md).
