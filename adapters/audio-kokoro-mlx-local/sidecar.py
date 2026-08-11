#!/usr/bin/env python3
"""CUT's offline, path-explicit Kokoro MLX narration adapter.

The CUT parent authenticates and privately stages every caller-selected byte
named by the request. This adapter has no install, setup, model conversion, or
download mode.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import platform
import re
import socket
import subprocess
import sys
import sysconfig
import wave
from pathlib import Path
from typing import NoReturn


FORMAT = "cut-kokoro-mlx-local-adapter-result"
VERSION = 2
PACKAGE_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
REQUIRED_PACKAGES = frozenset(
    ("kokoro-mlx", "misaki", "mlx", "mlx-metal", "numpy", "safetensors")
)


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_sha256(files: list[dict[str, object]]) -> str:
    digest = hashlib.sha256()
    for item in files:
        digest.update(
            f"{item['relativePath']}\0{item['bytes']}\0{item['sha256']}\n".encode("utf-8")
        )
    return digest.hexdigest()


def component_set_sha256(components: list[dict[str, object]]) -> str:
    digest = hashlib.sha256()
    for component in components:
        digest.update(f"{component['id']}\0{component['treeSha256']}\n".encode("utf-8"))
        for package in component["packages"]:
            digest.update(
                f"{package['name']}\0{package['packageVersion']}\0{package['license']}\n".encode("utf-8")
            )
        digest.update(b"\n")
    return digest.hexdigest()


def require_file(path: Path, expected_bytes: int, expected_sha256: str) -> None:
    if not path.is_file() or path.is_symlink():
        fail("staged authority is not one regular file")
    observed_bytes = path.stat().st_size
    if observed_bytes != expected_bytes or sha256(path) != expected_sha256:
        fail("staged authority differs from its request identity")


def safe_relative_path(value: object) -> str:
    relative = str(value)
    if relative.startswith("/") or "\\" in relative or any(
        part in ("", ".", "..") for part in relative.split("/")
    ):
        fail("staged tree contains an unsafe relative path")
    return relative


def observed_tree_files(root: Path) -> set[str]:
    if not root.is_dir() or root.is_symlink():
        fail("staged tree root is not one physical directory")
    observed: set[str] = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            fail("staged tree contains a symbolic link")
        if path.is_file():
            observed.add(path.relative_to(root).as_posix())
        elif not path.is_dir():
            fail("staged tree contains an unsupported filesystem entry")
    return observed


def require_tree(root: Path, files: list[dict[str, object]], expected_sha256: str) -> None:
    if tree_sha256(files) != expected_sha256:
        fail("staged tree manifest digest is inconsistent")
    expected: set[str] = set()
    previous = b""
    for item in files:
        relative = safe_relative_path(item["relativePath"])
        relative_bytes = relative.encode("utf-8")
        if relative_bytes <= previous or relative in expected:
            fail("staged tree manifest is not uniquely sorted")
        previous = relative_bytes
        expected.add(relative)
        require_file(root / relative, int(item["bytes"]), str(item["sha256"]))
    if observed_tree_files(root) != expected:
        fail("staged tree contains missing or unbound files")


def require_runtime(root: Path, runtime: dict[str, object]) -> dict[str, str]:
    components = runtime["components"]
    if component_set_sha256(components) != runtime["componentSetSha256"]:
        fail("runtime component-set digest is inconsistent")
    expected_files: set[str] = set()
    package_versions: dict[str, str] = {}
    previous_component = ""
    for component in components:
        component_id = str(component["id"])
        if component_id <= previous_component:
            fail("runtime components are not uniquely sorted")
        previous_component = component_id
        files = component["files"]
        if tree_sha256(files) != component["treeSha256"]:
            fail("runtime component tree digest is inconsistent")
        previous_file = b""
        for item in files:
            relative = safe_relative_path(item["relativePath"])
            relative_bytes = relative.encode("utf-8")
            if relative_bytes <= previous_file or relative in expected_files:
                fail("runtime component files overlap or are not uniquely sorted")
            previous_file = relative_bytes
            expected_files.add(relative)
            require_file(root / relative, int(item["bytes"]), str(item["sha256"]))
        previous_package = ""
        for package in component["packages"]:
            name = str(package["name"])
            version = str(package["packageVersion"])
            if not PACKAGE_NAME.fullmatch(name) or name <= previous_package or name in package_versions:
                fail("runtime packages are not normalized, globally unique, and sorted")
            previous_package = name
            package_versions[name] = version
    if not REQUIRED_PACKAGES.issubset(package_versions):
        fail("runtime omits a package required by CUT's Kokoro MLX profile")
    if observed_tree_files(root) != expected_files:
        fail("runtime contains missing or unbound files")
    return package_versions


def deny_network(*_args: object, **_kwargs: object) -> NoReturn:
    fail("network access is forbidden during local Kokoro inference")


class OfflineSocket(socket.socket):
    def connect(self, *_args: object, **_kwargs: object) -> NoReturn:
        deny_network()

    def connect_ex(self, *_args: object, **_kwargs: object) -> int:
        deny_network()


def deny_subprocess(*_args: object, **_kwargs: object) -> NoReturn:
    fail("child processes are forbidden during local Kokoro inference")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--espeak-library", type=Path, required=True)
    parser.add_argument("--espeak-data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    return parser.parse_args()


def restrict_import_path(runtime_root: Path) -> tuple[Path, ...]:
    stdlib_roots = tuple(
        dict.fromkeys(
            Path(value).resolve()
            for key in ("stdlib", "platstdlib")
            if (value := sysconfig.get_path(key))
        )
    )
    # Retain only the interpreter's paths that live within the exact stdlib
    # roots. This includes lib-dynload (for _ctypes and other CPython native
    # modules) without admitting global or user site-packages.
    stdlib_paths = tuple(
        dict.fromkeys(
            Path(value).resolve()
            for value in sys.path
            if value and any(is_within(Path(value).resolve(), root) for root in stdlib_roots)
        )
    )
    sys.path[:] = [str(runtime_root), *(str(path) for path in stdlib_paths)]
    importlib.invalidate_caches()
    return stdlib_roots


def require_package_metadata(runtime_root: Path, packages: dict[str, str]) -> None:
    for name, expected_version in packages.items():
        distribution = importlib.metadata.distribution(name)
        observed_version = distribution.version
        origin = Path(distribution.locate_file("")).resolve()
        if observed_version != expected_version or not is_within(origin, runtime_root):
            fail("runtime package metadata differs from the authenticated component set")


def require_import_origins(runtime_root: Path, adapter_path: Path, stdlib_roots: tuple[Path, ...]) -> None:
    for module in tuple(sys.modules.values()):
        value = getattr(module, "__file__", None)
        if not isinstance(value, str) or not value or value.startswith("<"):
            continue
        origin = Path(value).resolve()
        if origin == adapter_path or is_within(origin, runtime_root):
            continue
        if any(is_within(origin, root) for root in stdlib_roots):
            continue
        fail("an imported Python module escaped the authenticated runtime or CPython standard library")


def write_pcm16_wav(path: Path, audio: object, sample_rate: int) -> int:
    import numpy as np

    values = np.asarray(audio, dtype=np.float32)
    if values.ndim != 1 or values.size < 1 or not np.isfinite(values).all():
        fail("Kokoro generated invalid or empty audio samples")
    clipped = np.clip(values, -1.0, 1.0)
    pcm = np.where(
        clipped < 0,
        np.rint(clipped * 32768.0),
        np.rint(clipped * 32767.0),
    ).clip(-32768, 32767).astype("<i2")
    with path.open("xb") as raw:
        with wave.open(raw, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(pcm.tobytes(order="C"))
    return int(pcm.size)


def main() -> int:
    args = parse_args()
    request = json.loads(args.request.read_text(encoding="utf-8"))
    if request.get("format") != "cut-kokoro-mlx-local-adapter-request" or request.get("version") != 2:
        fail("unsupported CUT Kokoro adapter request")

    runtime = request["runtime"]
    model = request["model"]
    voice = request["voice"]
    phonemizer = request["phonemizer"]
    synthesis = request["synthesis"]

    packages = require_runtime(args.runtime_root, runtime)
    require_file(args.model_root / "config.json", model["config"]["bytes"], model["config"]["sha256"])
    require_file(
        args.model_root / "kokoro-v1_0.safetensors",
        model["weights"]["bytes"],
        model["weights"]["sha256"],
    )
    require_file(
        args.model_root / "voices" / f"{voice['name']}.safetensors",
        voice["weights"]["bytes"],
        voice["weights"]["sha256"],
    )
    require_file(args.espeak_library, phonemizer["library"]["bytes"], phonemizer["library"]["sha256"])
    require_tree(args.espeak_data, phonemizer["dataFiles"], phonemizer["dataTreeSha256"])

    # No setup path exists. Only the authenticated private runtime is added,
    # while ordinary socket connections and child-process creation are denied.
    socket.socket = OfflineSocket
    socket.create_connection = deny_network
    subprocess.Popen = deny_subprocess
    subprocess.run = deny_subprocess
    stdlib_roots = restrict_import_path(args.runtime_root.resolve())

    import espeakng_loader

    espeakng_loader.get_library_path = lambda: str(args.espeak_library)
    espeakng_loader.get_data_path = lambda: str(args.espeak_data)

    import kokoro_mlx

    require_package_metadata(args.runtime_root.resolve(), packages)
    if kokoro_mlx.__version__ != packages["kokoro-mlx"]:
        fail("kokoro_mlx version differs from the authenticated component set")

    import mlx.core as mx
    from kokoro_mlx import KokoroTTS

    if args.output.exists() or args.result.exists():
        fail("owned adapter outputs must not exist before inference")
    seed = int(synthesis["seed"])
    speed = int(synthesis["speedMicros"]) / 1_000_000
    sample_rate = int(synthesis["sampleRate"])
    mx.random.seed(seed)
    with KokoroTTS.from_pretrained(args.model_root) as tts:
        mx.random.seed(seed)
        generated = tts.generate(
            synthesis["text"],
            voice=voice["name"],
            speed=speed,
            sample_rate=sample_rate,
            language=synthesis["language"],
        )
    if generated.voice != voice["name"] or int(generated.sample_rate) != sample_rate:
        fail("Kokoro result metadata differs from the request")
    duration_samples = write_pcm16_wav(args.output, generated.audio, sample_rate)

    # Detect both private-stage and independently retained source mutations
    # before returning authority. The parent performs the independent source
    # snapshot checks; this pass reauthenticates every staged provider byte.
    require_runtime(args.runtime_root, runtime)
    require_file(args.model_root / "config.json", model["config"]["bytes"], model["config"]["sha256"])
    require_file(
        args.model_root / "kokoro-v1_0.safetensors",
        model["weights"]["bytes"],
        model["weights"]["sha256"],
    )
    require_file(
        args.model_root / "voices" / f"{voice['name']}.safetensors",
        voice["weights"]["bytes"],
        voice["weights"]["sha256"],
    )
    require_file(args.espeak_library, phonemizer["library"]["bytes"], phonemizer["library"]["sha256"])
    require_tree(args.espeak_data, phonemizer["dataFiles"], phonemizer["dataTreeSha256"])
    require_import_origins(args.runtime_root.resolve(), Path(__file__).resolve(), stdlib_roots)

    output_bytes = args.output.stat().st_size
    result = {
        "format": FORMAT,
        "version": VERSION,
        "runtime": {
            "implementation": platform.python_implementation(),
            "pythonVersion": platform.python_version(),
            "platform": sys.platform,
            "machine": platform.machine(),
            "componentSetSha256": runtime["componentSetSha256"],
        },
        "model": {
            "configSha256": model["config"]["sha256"],
            "weightsSha256": model["weights"]["sha256"],
        },
        "voice": {"name": generated.voice, "weightsSha256": voice["weights"]["sha256"]},
        "phonemizer": {
            "librarySha256": phonemizer["library"]["sha256"],
            "dataTreeSha256": phonemizer["dataTreeSha256"],
        },
        "synthesis": {
            "textSha256": hashlib.sha256(synthesis["text"].encode("utf-8")).hexdigest(),
            "language": synthesis["language"],
            "speedMicros": int(synthesis["speedMicros"]),
            "seed": seed,
            "sampleRate": sample_rate,
        },
        "output": {
            "bytes": output_bytes,
            "sha256": sha256(args.output),
            "durationSamples": duration_samples,
        },
    }
    with args.result.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
