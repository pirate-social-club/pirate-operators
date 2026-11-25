#!/usr/bin/env python3
"""Check fixture trust anchors and per-run identity records through their CLIs."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFY = load("verify-vm-fixtures")
RECORD = load("record-run-identity")


class FixtureTrustTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_expected_manifest_digest_passes(self):
        path = self.root / "ASSET-SHA256SUMS"
        path.write_bytes(b"fixture bytes\n")
        expected = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(VERIFY.verify_manifest(path, expected), expected)

    def test_manifest_digest_mismatch_names_both_digests(self):
        path = self.root / "ASSET-SHA256SUMS"
        path.write_bytes(b"fixture bytes\n")
        expected = "0" * 64
        with self.assertRaisesRegex(ValueError, "manifest digest mismatch"):
            VERIFY.verify_manifest(path, expected)

    def test_invalid_expected_digest_is_rejected(self):
        path = self.root / "ASSET-SHA256SUMS"
        path.write_bytes(b"fixture bytes\n")
        with self.assertRaisesRegex(ValueError, "expected SHA-256"):
            VERIFY.verify_manifest(path, "not-a-digest")

    def test_cli_mismatch_exits_nonzero_without_verifying_assets(self):
        path = self.root / "ASSET-SHA256SUMS"
        path.write_bytes(b"fixture bytes\n")
        result = subprocess.run(
            [sys.executable, str(ROOT / "verify-vm-fixtures.py"), str(path), "0" * 64],
            text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest digest mismatch", result.stderr)


class RunIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "test")
        self.git("config", "user.email", "test@example.invalid")
        (self.repo / ".github/ci").mkdir(parents=True)
        (self.repo / ".github/ci/adapter.py").write_text("adapter\n")
        (self.repo / ".github/workflows").mkdir(parents=True)
        (self.repo / ".github/workflows/pirate-vm-final-acceptance.yml").write_text("final\n")
        (self.repo / ".github/workflows/pirate-vm-install-only.yml").write_text("install\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.repo / ".github/ci/adapter.py").write_text("adapter head\n")
        self.git("commit", "-qam", "head")
        self.head = self.git("rev-parse", "HEAD").strip()
        self.merge = self.git("commit-tree", self.head + "^{tree}", "-p", self.base, "-p", self.head,
                              "-m", "merge").strip()
        self.git("checkout", "-q", self.merge)
        self.pin = self.root / "pin.json"
        self.pin.write_text(json.dumps({
            "release": "fixtures-r15",
            "unchangedAssetRelease": "fixtures-r13",
            "manifestSha256": "a" * 64,
            "productSourceHead": "b" * 40,
            "productSourceTree": "c" * 40,
            "fixtureImageId": "sha256:" + "d" * 64,
        }))
        self.event = self.root / "event.json"
        self.output = self.root / "identity.json"

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def run_record(self, event_name, event, sha):
        self.event.write_text(json.dumps(event))
        env = dict(os.environ, GITHUB_SHA=sha, GITHUB_EVENT_NAME=event_name,
                   GITHUB_EVENT_PATH=str(self.event), GITHUB_WORKFLOW="VM test",
                   GITHUB_RUN_ID="123", GITHUB_REPOSITORY="example/repo")
        subprocess.run([sys.executable, str(ROOT / "record-run-identity.py"),
                        "--repo", str(self.repo), "--pin", str(self.pin),
                        "--output", str(self.output)], env=env, check=True)
        return json.loads(self.output.read_text())

    def test_pull_request_records_head_merge_base_and_checkout_objects(self):
        row = self.run_record("pull_request", {
            "pull_request": {"head": {"sha": self.head}, "base": {"sha": self.base},
                             "merge_commit_sha": self.merge},
        }, self.merge)
        self.assertEqual(row["headSha"], self.head)
        self.assertEqual(row["executedMergeSha"], self.merge)
        self.assertEqual(row["baseSha"], self.base)
        self.assertEqual(row["checkoutSha"], self.merge)
        self.assertEqual(row["fixtureRelease"], "fixtures-r15")
        self.assertEqual(row["unchangedAssetRelease"], "fixtures-r13")
        self.assertEqual(row["fixtureManifestSha256"], "a" * 64)
        self.assertEqual(row["productSourceHead"], "b" * 40)
        self.assertEqual(row["productSourceTree"], "c" * 40)
        self.assertEqual(row["fixtureImageId"], "sha256:" + "d" * 64)
        self.assertEqual(len(row["checkoutCiTreeSha"]), 40)
        self.assertEqual(len(row["checkoutFinalWorkflowBlobSha"]), 40)
        self.assertEqual(len(row["checkoutInstallWorkflowBlobSha"]), 40)

    def test_workflow_dispatch_has_no_executed_merge(self):
        self.git("checkout", "-q", self.head)
        row = self.run_record("workflow_dispatch", {}, self.head)
        self.assertEqual(row["headSha"], self.head)
        self.assertIsNone(row["executedMergeSha"])
        self.assertIsNone(row["baseSha"])
        self.assertEqual(row["checkoutSha"], self.head)

    def test_checkout_head_mismatch_stops_the_run(self):
        self.event.write_text("{}")
        env = dict(os.environ, GITHUB_SHA=self.head, GITHUB_EVENT_NAME="workflow_dispatch",
                   GITHUB_EVENT_PATH=str(self.event), GITHUB_WORKFLOW="VM test",
                   GITHUB_RUN_ID="123", GITHUB_REPOSITORY="example/repo")
        result = subprocess.run(
            [sys.executable, str(ROOT / "record-run-identity.py"), "--repo", str(self.repo),
             "--pin", str(self.pin), "--output", str(self.output)],
            env=env, text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checkout", result.stderr.lower())
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
