"""A single private PCM window on stdin. Output native Whisper token timings."""
import hashlib
import json
import math
import os
import sys
from pathlib import Path

os.environ["OPENBLAS_NUM_THREADS"] = "1"

BYTES_PER_MS = 32
TICK_MS = 10
MAX_BYTES = BYTES_PER_MS * 1000 * 30

# Fixed exit codes consumed by the private bridge. No exception detail crosses it.
INVALID_INPUT = 64
MODEL_CHANGED = 65
NATIVE_BOOT = 66
NATIVE_DECODE = 67
TOKEN_TEXT = 68
TOKEN_TIMING = 69
NATIVE_OUTPUT = 70
NATIVE_INTERNAL = 71


class NativeFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def recognize(pcm, model_path):
    try:
        import _pywhispercpp as whisper
        import numpy as np
        from pywhispercpp.model import Model

        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        if not np.any(audio):
            return []
        model = Model(str(model_path), context_params={"use_gpu": False}, language="en",
                      n_threads=2, no_context=True, token_timestamps=True,
                      print_special=False, print_progress=False, print_realtime=False,
                      print_timestamps=False, redirect_whispercpp_logs_to=None)
        ctx = model._ctx
    except Exception:
        raise NativeFailure(NATIVE_BOOT) from None
    try:
        status = whisper.whisper_full(ctx, model._params, audio, audio.size)
    except Exception:
        raise NativeFailure(NATIVE_DECODE) from None
    if status != 0:
        raise NativeFailure(NATIVE_DECODE)

    words = []
    for segment in range(whisper.whisper_full_n_segments(ctx)):
        pieces = []
        for index in range(whisper.whisper_full_n_tokens(ctx, segment)):
            token = whisper.whisper_full_get_token_data(ctx, segment, index)
            if token.id >= whisper.whisper_token_eot(ctx):
                continue
            try:
                raw = whisper.whisper_full_get_token_text(ctx, segment, index)
                if isinstance(raw, str):
                    raw = raw.encode("utf-8")
            except UnicodeError:
                raise NativeFailure(TOKEN_TEXT) from None
            if not raw.strip():
                continue
            if raw[:1].isspace() and pieces:
                append_word(words, pieces, len(pcm))
                pieces = []
            pieces.append((raw.strip(), token.t0 * TICK_MS, token.t1 * TICK_MS, float(token.p)))
        if pieces:
            append_word(words, pieces, len(pcm))
    if len(words) > 1000:
        raise NativeFailure(NATIVE_OUTPUT)
    return words


def append_word(words, pieces, size):
    try:
        text = b"".join(piece[0] for piece in pieces).decode("utf-8")
    except UnicodeError:
        raise NativeFailure(TOKEN_TEXT) from None
    if not any(c.isalnum() for c in text):
        return
    if len(text) > 120 or any(c.isspace() for c in text):
        raise NativeFailure(TOKEN_TEXT)
    starts = [piece[1] for piece in pieces]
    ends = [piece[2] for piece in pieces]
    probabilities = [piece[3] for piece in pieces]
    if any(start < 0 or start * BYTES_PER_MS >= size or end < start or
           end * BYTES_PER_MS > size + TICK_MS * BYTES_PER_MS
           for start, end in zip(starts, ends)):
        raise NativeFailure(TOKEN_TIMING)
    # Native timestamps use 10 ms ticks. Keep the measured overlap at the PCM edge.
    start = min(starts)
    end = min(max(ends), size // BYTES_PER_MS)
    if end <= start or (words and start < words[-1]["startMs"]):
        raise NativeFailure(TOKEN_TIMING)
    if any(not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities):
        raise NativeFailure(NATIVE_OUTPUT)
    words.append({"text": text, "startMs": start, "endMs": end,
                  "confidence": min(probabilities)})


def main():
    if len(sys.argv) != 3:
        raise NativeFailure(INVALID_INPUT)
    pcm = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not pcm or len(pcm) > MAX_BYTES or len(pcm) % 2:
        raise NativeFailure(INVALID_INPUT)
    try:
        weights = Path(sys.argv[1]).resolve(strict=True)
        with weights.open("rb") as model_file:
            sha = "0x" + hashlib.file_digest(model_file, "sha256").hexdigest()
    except OSError:
        raise NativeFailure(NATIVE_BOOT) from None
    if sha != sys.argv[2]:
        raise NativeFailure(MODEL_CHANGED)
    value = {
        "schema": "pirate.local-karaoke-recognition/1",
        "timing": "whisper-token-timestamps",
        "modelSha256": sha,
        "pcmSha256": "0x" + hashlib.sha256(pcm).hexdigest(),
        "sampleCount": len(pcm) // 2,
        "words": recognize(pcm, weights),
    }
    try:
        result = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError):
        raise NativeFailure(NATIVE_OUTPUT) from None
    if len(result) > 65536:
        raise NativeFailure(NATIVE_OUTPUT)
    sys.stdout.buffer.write(result)


if __name__ == "__main__":
    try:
        main()
    except NativeFailure as error:
        sys.exit(error.code)
    except Exception:
        # Mic data, recognized text, absolute paths and native errors stay private.
        sys.exit(NATIVE_INTERNAL)
