# Security policy

Please report vulnerabilities through GitHub's private vulnerability-reporting
flow for this repository. Do not open a public issue containing an exploit,
credential, private media, or sensitive project file. Include the affected
version, impact, and the smallest safe reproduction.

## Local trust model

CUT is a local compiler and renderer. Formal `.cut` source is parsed, checked,
compiled, and bound to explicit resource bytes. A valid `cut.lock` records the
source, media, font, package, probe, implementation, and backend identities needed
by the runtime. Generated CutAVIR alone is not render authority.

Media processing uses FFmpeg, ffprobe, Sharp, and the native retained compositor
with the permissions of the invoking user. This is not a sandbox for hostile
media. Use a dedicated account, container, or disposable machine when processing
untrusted files.

CUT revalidates locked bytes before rendering, uses argument arrays rather than
shell command strings, bounds graph and allocation work, isolates verified input
copies, and publishes output atomically. These controls reduce accidental drift
and common path races; they do not protect against a malicious process running as
the same OS user.

## Optional model-assisted authoring

`cut agent author`, `cut agent repair`, and legacy research/planning commands are
explicit data-export actions. They may send the supplied brief, CUT source, and
compiler diagnostics to the selected provider. Obtain permission before sending
private material. CUT does not persist `OPENAI_API_KEY`; ChatGPT mode invokes the
user's separately installed and authenticated Codex CLI.

Formal checking, locking, building, inspection, testing, framing, auditioning,
previewing, and rendering do not require a model.

## Secrets and publication

- Never commit `.env` files, tokens, private keys, credentials, or signed URLs.
- Keep private footage, transcripts, client data, raw profiles, and generated
  render evidence outside this repository.
- Asset hashes prove byte identity, not ownership or permission. Review rights
  and attribution separately.
- Run `npm run audit:public` and inspect `npm pack --dry-run` before a release.
- Scan the complete Git history before publishing a rewritten or imported branch.

## Supported boundary

The current alpha supports local macOS arm64 execution with Node.js 20 and
FFmpeg 7. Linux and Windows media lifecycle behavior is not yet a supported or
security-reviewed claim. A hosted render service would additionally require
isolated workers, authentication, rate/concurrency limits, storage boundaries,
and retention controls; this repository does not provide such a service.
