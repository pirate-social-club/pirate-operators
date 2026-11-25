#!/usr/bin/env python3
"""Exercise the packaged final-acceptance receipt boundary before CI runs it."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest


sys.dont_write_bytecode = True
VERIFIER = Path(sys.argv[1]).resolve(strict=True)
SPEC = importlib.util.spec_from_file_location("packaged_final_verifier", VERIFIER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def receipt(name, value):
    return json.dumps(value, sort_keys=True).encode() + b"\n"


def add_file(archive, name, data):
    member = tarfile.TarInfo(name)
    member.size = len(data)
    member.mode = 0o600
    archive.addfile(member, io.BytesIO(data))


def archive(path, files, *, pins=None, duplicate=None):
    pins = pins or {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    manifest = "".join(f"{pins[name]}  {name}\n" for name in files).encode()
    with tarfile.open(path, "w") as output:
        add_file(output, "RUN-SHA256SUMS", manifest)
        for name, data in files.items():
            add_file(output, name, data)
        if duplicate is not None:
            add_file(output, duplicate, b"")


class FinalEvidenceVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_hold_json_receipts_are_hash_checked_and_parsed(self):
        path = self.root / "hold.tar"
        browser = receipt("browser", {
            "browserClosed": True, "observedUtc": "2026-11-25T03:54:27.620+00:00",
        })
        archive(path, {
            "controller-terminal.json": receipt("controller", {
                "phase": "close", "status": "FAIL", "endedUtc": "2026-11-25T03:54:27.621+00:00",
                "childExit": 143, "error": "unclassified-private-error",
            }),
            "browser-egress.json": browser,
        })
        records, pins, manifest = MODULE.receipt_set(path, MODULE.HOLD, set())
        self.assertEqual(records["controller-terminal.json"]["childExit"], 143)
        self.assertEqual(pins["browser-egress.json"], hashlib.sha256(browser).hexdigest())
        self.assertEqual(len(manifest), 64)

    def test_hold_terminal_receipt_is_admitted_and_validated(self):
        path = self.root / "hold-terminal.tar"
        archive(path, {
            "hold-terminal.json": receipt("terminal", {
                "phase": "private-worker", "rc": 1, "cleanup": 1,
                "cutoffMs": 1795583066000, "utc": "2026-11-25T04:15:04.636261879Z",
            }),
        })
        records, _pins, _manifest = MODULE.receipt_set(path, MODULE.HOLD, set())
        MODULE.verify_worker_hold(records)

    def test_unexpected_members_name_the_export_defect_and_controller_phase(self):
        path = self.root / "legacy-hold.tar"
        archive(path, {
            "controller-terminal.json": receipt("controller", {
                "phase": "close", "status": "FAIL", "endedUtc": "2026-11-25T03:54:27.621+00:00",
                "childExit": 143, "error": "unclassified-private-error",
            }),
            "logs/empty.log": b"",
            "notes-controller-terminal.json": receipt("private-controller", {"phase": "close"}),
            "worker-private.txt": b"private diagnostic\n",
        })
        with self.assertRaises(AssertionError) as caught:
            MODULE.receipt_set(path, MODULE.HOLD, set())
        message = str(caught.exception)
        self.assertIn("logs/empty.log", message)
        self.assertIn("notes-controller-terminal.json", message)
        self.assertIn("worker-private.txt", message)
        self.assertIn("phase=close", message)
        self.assertIn("childExit=143", message)

    def test_empty_allowlisted_receipt_is_rejected_by_name(self):
        path = self.root / "empty.tar"
        archive(path, {"controller-terminal.json": b""})
        with self.assertRaises(AssertionError) as caught:
            MODULE.receipt_set(path, MODULE.HOLD, set())
        self.assertIn("controller-terminal.json", str(caught.exception))
        self.assertIn("empty", str(caught.exception).lower())

    def test_hash_mismatch_is_rejected_by_name(self):
        path = self.root / "bad-hash.tar"
        archive(path, {"controller-terminal.json": receipt("controller", {"phase": "close"})},
                pins={"controller-terminal.json": "0" * 64})
        with self.assertRaises(AssertionError) as caught:
            MODULE.receipt_set(path, MODULE.HOLD, set())
        self.assertIn("controller-terminal.json", str(caught.exception))
        self.assertIn("hash mismatch", str(caught.exception).lower())

    def test_missing_manifest_member_is_rejected_by_name(self):
        path = self.root / "missing.tar"
        with tarfile.open(path, "w") as output:
            add_file(output, "RUN-SHA256SUMS", f"{'0' * 64}  missing.json\n".encode())
        with self.assertRaisesRegex(AssertionError, "missing.json"):
            MODULE.receipt_set(path, MODULE.HOLD, set())

    def test_malformed_json_is_rejected_by_receipt_name(self):
        path = self.root / "bad-json.tar"
        archive(path, {"controller-terminal.json": b"not json\n"})
        with self.assertRaisesRegex(ValueError, "controller-terminal.json"):
            MODULE.receipt_set(path, MODULE.HOLD, set())

    def test_duplicate_members_are_rejected_readably(self):
        path = self.root / "duplicate.tar"
        archive(path, {"controller-terminal.json": receipt("controller", {"phase": "close"})},
                duplicate="controller-terminal.json")
        with self.assertRaisesRegex(AssertionError, "duplicate"):
            MODULE.receipt_set(path, MODULE.HOLD, set())

    def test_success_receipts_remain_nonempty_and_hash_checked(self):
        path = self.root / "success.tar"
        archive(path, {name: receipt(name, {}) for name in MODULE.SUCCESS})
        records, pins, _manifest = MODULE.receipt_set(path, MODULE.SUCCESS, MODULE.SUCCESS)
        self.assertEqual(set(records), MODULE.SUCCESS)
        self.assertEqual(set(pins), MODULE.SUCCESS)

    def test_empty_success_receipt_is_rejected(self):
        path = self.root / "empty-success.tar"
        files = {name: receipt(name, {}) for name in MODULE.SUCCESS}
        files["resources.json"] = b""
        archive(path, files)
        with self.assertRaisesRegex(AssertionError, "empty.*resources.json"):
            MODULE.receipt_set(path, MODULE.SUCCESS, MODULE.SUCCESS)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
