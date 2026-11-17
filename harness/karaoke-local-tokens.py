"""A single private PCM window on stdin. Output native Whisper token timings."""
import hashlib
import json
import math
import os
import sys
from pathlib import Path

os.environ["OPENBLAS_NUM_THREADS"] = "1"

import _pywhispercpp as whisper
import numpy as np
from pywhispercpp.model import Model

MAX_BYTES = 32_000 * 30


def recognize(pcm, model_path):
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
    if not np.any(audio):
        return []
    model = Model(str(model_path), context_params={"use_gpu": False}, language="en",
                  n_threads=2, no_context=True, token_timestamps=True,
                  print_special=False, print_progress=False, print_realtime=False,
                  print_timestamps=False, redirect_whispercpp_logs_to=None)
    ctx = model._ctx
    if whisper.whisper_full(ctx, model._params, audio, audio.size) != 0:
        raise ValueError("decode failed")
    words = []
    for segment in range(whisper.whisper_full_n_segments(ctx)):
        pieces = []
        for index in range(whisper.whisper_full_n_tokens(ctx, segment)):
            token = whisper.whisper_full_get_token_data(ctx, segment, index)
            if token.id >= whisper.whisper_token_eot(ctx):
                continue
            raw = whisper.whisper_full_get_token_text(ctx, segment, index)
            if isinstance(raw, str):
                raw = raw.encode("utf-8")
            if not raw.strip():
                continue
            if raw[:1].isspace() and pieces:
                append_word(words, pieces, len(pcm))
                pieces = []
            pieces.append((raw.strip(), token.t0 * 10, token.t1 * 10, float(token.p)))
        if pieces:
            append_word(words, pieces, len(pcm))
    if len(words) > 1000:
        raise ValueError("too many recognized words")
    return words


def append_word(words, pieces, size):
    text = b"".join(piece[0] for piece in pieces).decode("utf-8")
    if not any(c.isalnum() for c in text):
        return
    if not text or len(text) > 120 or any(c.isspace() for c in text):
        raise ValueError("ambiguous token group")
    starts = [piece[1] for piece in pieces]
    ends = [piece[2] for piece in pieces]
    probabilities = [piece[3] for piece in pieces]
    if any(start < 0 or end < start or end * 32 > size
           for start, end in zip(starts, ends)):
        raise ValueError("token timing missing or outside PCM")
    start, end = min(starts), max(ends)
    if end <= start or (words and start < words[-1]["startMs"]):
        raise ValueError("word timing unavailable")
    if any(not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities):
        raise ValueError("token probability invalid")
    words.append({"text": text, "startMs": start, "endMs": end,
                  "confidence": min(probabilities)})


def main():
    if len(sys.argv) != 3:
        raise ValueError("model pin required")
    weights = Path(sys.argv[1]).resolve(strict=True)
    with weights.open("rb") as model_file:
        sha = "0x" + hashlib.file_digest(model_file, "sha256").hexdigest()
    if sha != sys.argv[2]:
        raise ValueError("model pin mismatch")
    pcm = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not pcm or len(pcm) > MAX_BYTES or len(pcm) % 2:
        raise ValueError("PCM length invalid")
    value = {
        "schema": "pirate.local-karaoke-recognition/1",
        "timing": "whisper-token-timestamps",
        "modelSha256": sha,
        "pcmSha256": "0x" + hashlib.sha256(pcm).hexdigest(),
        "sampleCount": len(pcm) // 2,
        "words": recognize(pcm, weights),
    }
    result = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(result) > 65536:
        raise ValueError("result length invalid")
    sys.stdout.buffer.write(result)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Mic data, recognized text, absolute paths and native errors stay private.
        sys.exit("local_karaoke_recognition_failed")
