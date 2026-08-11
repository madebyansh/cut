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

## Optional semantic-footage backend

`cut footage setup --backend local` is an explicit network and native-code
installation step. It installs the lockfile-pinned Transformers.js, ONNX
Runtime, Sharp/libvips, and model closure below the selected CUT footage home.
Normal indexing and search are offline and revalidate those exact bytes, but
the backend still decodes media and executes native dependencies with the
invoking user's permissions. It is not an isolation boundary for hostile
media; use a container or disposable account for untrusted files. Keep the
backend lock current, review `npm audit --prefix adapters/footage-local
--omit=dev`, and run both `cut doctor` and `cut footage doctor` before use.

## Optional local audio-intelligence backends

Local transcription, semantic analysis, and optional Kokoro MLX narration
execute caller-selected native or Python model runtimes with the invoking
user's permissions. CUT setup commands
do not download them: they authenticate explicit local executables, model
files, and runtime trees, then write machine-local setup records. Those records
contain absolute paths and should not be committed when they disclose private
filesystem layout.

The YAMNet adapter uses direct LiteRT, accepts bounded normalized PCM only on
stdin, and ships only its adapter, notices, and exact AudioSet label map. CUT
does not bundle Python, NumPy, LiteRT, a virtual environment, or model bytes.
The adapter's socket and subprocess guards are defense in depth, not an
operating-system sandbox. Use an isolated account or container for an
untrusted native runtime or model. License and provenance strings in setup and
analysis receipts are caller declarations; hashes prove byte identity, not
rights or legal clearance.

Whisper, YAMNet, and Kokoro inference remain authoring-time operations. `cut
lock`, preview, and render consume only materialized project artifacts and
never start these models or contact a model service.

Kokoro narration has no setup or download command. Its machine-local recipe
selects a complete Python/native component closure, model, voice and eSpeak;
CUT injects its bundled adapter, privately stages authenticated bytes, and
publishes only the generated WAV and path-free receipt. Offline flags and the
adapter's socket/subprocess denial are defense in depth, not an OS sandbox.
The recipe contains absolute paths, the receipt contains the supplied script,
and neither should be published when that information is sensitive.

## Secrets and publication

- Never commit `.env` files, tokens, private keys, credentials, or signed URLs.
- Keep private footage, transcripts, client data, raw profiles, and generated
  render evidence outside this repository.
- Asset hashes prove byte identity, not ownership or permission. Review rights
  and attribution separately.
- Run `npm run audit:public` and inspect `npm pack --dry-run` before a release.
- Scan the complete Git history before publishing a rewritten or imported branch.

## Supported boundary

The current alpha supports local macOS arm64 and experimental Linux x64/arm64
execution with the Node.js and FFmpeg versions documented in the README. Linux
uses the JavaScript compositor fallback; cross-platform pixel or encoded-byte
parity is not claimed. Windows media lifecycle behavior is not yet supported.
A hosted render service would additionally require isolated workers,
authentication, rate/concurrency limits, storage boundaries, and retention
controls; this repository does not provide such a service.
