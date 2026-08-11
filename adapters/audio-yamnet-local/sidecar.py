#!/usr/bin/env python3
"""Bounded direct-LiteRT YAMNet adapter for CUT.

All executable, environment, model, and class-map bytes are authenticated and
privately staged by the CUT parent. Audio is accepted only as mono f32le 16 kHz
PCM on stdin. This adapter has no download or setup mode.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
import platform
import socket
import subprocess
import sys
from pathlib import Path
from typing import NoReturn


FORMAT = "cut-yamnet-local-adapter-result"
VERSION = 1
SAMPLE_RATE = 16_000
MAXIMUM_SAMPLES = 160_000
PATCH_SAMPLES = 15_600
PATCH_HOP_SAMPLES = 7_680
CLASS_COUNT = 521
INTERPRETER_THREADS = 1


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, expected_bytes: int, expected_sha256: str) -> None:
    if not path.is_file() or path.is_symlink():
        fail("staged authority is not one regular file")
    if path.stat().st_size != expected_bytes or sha256(path) != expected_sha256:
        fail("staged authority differs from its command identity")


def require_class_map(path: Path) -> None:
    try:
        source = path.read_text(encoding="utf-8", errors="strict")
    except (OSError, UnicodeError) as error:
        fail(f"class map is not readable fatal UTF-8: {type(error).__name__}")
    if not source.endswith("\n") or "\r" in source or "\x00" in source:
        fail("class map must use LF-terminated fatal UTF-8 rows")
    labels = source[:-1].split("\n")
    if len(labels) != CLASS_COUNT or any(not label for label in labels):
        fail("class map must contain exactly 521 ordered nonempty label rows")


def deny_network(*_args: object, **_kwargs: object) -> NoReturn:
    fail("network access is forbidden in the direct LiteRT adapter")


class OfflineSocket(socket.socket):
    def connect(self, *_args: object, **_kwargs: object) -> NoReturn:
        deny_network()

    def connect_ex(self, *_args: object, **_kwargs: object) -> int:
        deny_network()


def deny_subprocess(*_args: object, **_kwargs: object) -> NoReturn:
    fail("child processes are forbidden in the direct LiteRT adapter")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--mode", choices=("doctor", "analyze"), required=True)
    parser.add_argument("--environment-root", type=Path, required=True)
    parser.add_argument("--litert-version", required=True)
    parser.add_argument("--interpreter-threads", type=int, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--model-bytes", type=int, required=True)
    parser.add_argument("--model-sha256", required=True)
    parser.add_argument("--class-map", type=Path, required=True)
    parser.add_argument("--class-map-bytes", type=int, required=True)
    parser.add_argument("--class-map-sha256", required=True)
    return parser.parse_args()


def load_runtime(environment_root: Path, expected_version: str):
    root = environment_root.resolve(strict=True)
    sys.path.insert(0, str(root))
    importlib.invalidate_caches()

    # These guards are defense in depth around a runtime that has no network or
    # setup API in this adapter. They are not represented as an OS sandbox.
    socket.socket = OfflineSocket
    socket.create_connection = deny_network
    subprocess.Popen = deny_subprocess
    subprocess.run = deny_subprocess
    subprocess.call = deny_subprocess
    subprocess.check_call = deny_subprocess
    subprocess.check_output = deny_subprocess

    try:
        import ai_edge_litert
        import numpy
        from ai_edge_litert.interpreter import Interpreter
    except Exception as error:
        fail(f"staged LiteRT environment could not be imported: {type(error).__name__}")
    for module in (ai_edge_litert, numpy):
        origin_value = getattr(module, "__file__", None)
        if not origin_value:
            fail("staged runtime module has no file origin")
        origin = Path(origin_value).resolve(strict=True)
        if root not in origin.parents:
            fail("runtime module imported outside the authenticated environment")
    observed_version = importlib.metadata.version("ai-edge-litert")
    if observed_version != expected_version:
        fail("LiteRT version differs from the authenticated setup")
    return numpy, Interpreter, observed_version


def make_interpreter(numpy, interpreter_type, model_path: Path, threads: int):
    if threads != INTERPRETER_THREADS:
        fail("interpreter thread policy differs from the CUT contract")
    interpreter = interpreter_type(model_path=str(model_path), num_threads=threads)
    interpreter.allocate_tensors()
    inputs = interpreter.get_input_details()
    outputs = interpreter.get_output_details()
    if len(inputs) != 1 or len(outputs) != 1:
        fail("YAMNet model must have exactly one input and one output")
    input_detail, output_detail = inputs[0], outputs[0]
    if numpy.dtype(input_detail["dtype"]) != numpy.dtype(numpy.float32):
        fail("YAMNet input tensor must be float32")
    if numpy.dtype(output_detail["dtype"]) != numpy.dtype(numpy.float32):
        fail("YAMNet output tensor must be float32")
    input_shape = tuple(int(value) for value in input_detail["shape"])
    output_shape = tuple(int(value) for value in output_detail["shape"])
    if input_shape not in ((PATCH_SAMPLES,), (1, PATCH_SAMPLES)):
        fail("YAMNet input must be one exact 15600-sample float32 patch")
    if output_shape not in ((CLASS_COUNT,), (1, CLASS_COUNT)):
        fail("YAMNet output must be one exact 521-score float32 vector")
    return interpreter, input_detail, output_detail, input_shape


def patch_count(samples: int) -> int:
    if samples <= PATCH_SAMPLES:
        return 1
    return 1 + (samples - PATCH_SAMPLES + PATCH_HOP_SAMPLES - 1) // PATCH_HOP_SAMPLES


def doctor(args: argparse.Namespace, observed_version: str) -> int:
    result = {
        "format": FORMAT,
        "version": VERSION,
        "runtime": {
            "implementation": platform.python_implementation(),
            "pythonVersion": platform.python_version(),
            "platform": sys.platform,
            "machine": platform.machine(),
            "liteRtVersion": observed_version,
        },
        "model": {"bytes": args.model_bytes, "sha256": args.model_sha256},
        "classMap": {
            "bytes": args.class_map_bytes,
            "sha256": args.class_map_sha256,
            "classCount": CLASS_COUNT,
        },
        "policy": {
            "sampleRate": SAMPLE_RATE,
            "patchSamples": PATCH_SAMPLES,
            "patchHopSamples": PATCH_HOP_SAMPLES,
            "rightPadFinalPatch": True,
            "classCount": CLASS_COUNT,
            "interpreterThreads": INTERPRETER_THREADS,
        },
    }
    sys.stdout.buffer.write(
        (json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    )
    return 0


def analyze(args: argparse.Namespace, numpy, interpreter, input_detail, output_detail, input_shape) -> int:
    raw = sys.stdin.buffer.read(MAXIMUM_SAMPLES * 4 + 1)
    if len(raw) < 4 or len(raw) % 4 != 0 or len(raw) > MAXIMUM_SAMPLES * 4:
        fail("stdin must contain 1 through 160000 mono f32le samples")
    waveform = numpy.frombuffer(raw, dtype="<f4")
    if not bool(numpy.all(numpy.isfinite(waveform))) or bool(numpy.any(waveform < -1.0)) or bool(numpy.any(waveform > 1.0)):
        fail("stdin PCM contains non-finite or non-normalized samples")
    result = bytearray()
    for patch_index in range(patch_count(int(waveform.size))):
        start = patch_index * PATCH_HOP_SAMPLES
        valid = min(PATCH_SAMPLES, max(0, int(waveform.size) - start))
        patch = numpy.zeros(PATCH_SAMPLES, dtype=numpy.float32)
        if valid:
            patch[:valid] = waveform[start : start + valid]
        tensor = patch if input_shape == (PATCH_SAMPLES,) else patch.reshape((1, PATCH_SAMPLES))
        interpreter.set_tensor(input_detail["index"], tensor)
        interpreter.invoke()
        scores = numpy.asarray(interpreter.get_tensor(output_detail["index"]), dtype=numpy.float32).reshape(-1)
        if scores.size != CLASS_COUNT or not bool(numpy.all(numpy.isfinite(scores))):
            fail("LiteRT returned an invalid YAMNet score vector")
        if bool(numpy.any(scores < 0.0)) or bool(numpy.any(scores > 1.0)):
            fail("LiteRT returned a YAMNet score outside [0,1]")
        result.extend(scores.astype("<f4", copy=False).tobytes(order="C"))
    sys.stdout.buffer.write(result)
    return 0


def main() -> int:
    args = parse_args()
    if not args.environment_root.is_dir() or args.environment_root.is_symlink():
        fail("environment root must be one physical directory")
    require_file(args.model, args.model_bytes, args.model_sha256)
    require_file(args.class_map, args.class_map_bytes, args.class_map_sha256)
    require_class_map(args.class_map)
    numpy, interpreter_type, observed_version = load_runtime(args.environment_root, args.litert_version)
    interpreter, input_detail, output_detail, input_shape = make_interpreter(
        numpy, interpreter_type, args.model, args.interpreter_threads
    )
    if args.mode == "doctor":
        if sys.stdin.buffer.read(1):
            fail("doctor mode forbids stdin bytes")
        return doctor(args, observed_version)
    return analyze(args, numpy, interpreter, input_detail, output_detail, input_shape)


if __name__ == "__main__":
    raise SystemExit(main())
