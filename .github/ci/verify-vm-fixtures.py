#!/usr/bin/env python3
"""Verify a downloaded fixture manifest against a digest supplied out-of-band."""
import hashlib
from pathlib import Path
import re
import sys


DIGEST = re.compile(r"[0-9a-f]{64}")


def verify_manifest(path, expected):
    expected = expected.strip().lower()
    if not DIGEST.fullmatch(expected):
        raise ValueError("expected SHA-256 must be exactly 64 lowercase hexadecimal characters")
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"fixture manifest is missing or not a regular file: {path}")
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise ValueError(f"fixture manifest digest mismatch: expected {expected}, got {actual}")
    return actual


def main():
    if len(sys.argv) != 3:
        print("usage: verify-vm-fixtures.py ASSET-SHA256SUMS EXPECTED_SHA256", file=sys.stderr)
        return 2
    try:
        actual = verify_manifest(sys.argv[1], sys.argv[2])
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"fixture manifest verified: {actual}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
