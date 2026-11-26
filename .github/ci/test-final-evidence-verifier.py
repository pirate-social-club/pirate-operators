#!/usr/bin/env python3
"""Exercise the packaged final-acceptance receipt boundary before CI runs it."""
import hashlib
import importlib.util
import io
import json
import os
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
COLLECTOR_PATH = VERIFIER.parent / "collect-notes-evidence.py"
COLLECTOR_SPEC = importlib.util.spec_from_file_location("packaged_final_collector", COLLECTOR_PATH)
COLLECTOR = importlib.util.module_from_spec(COLLECTOR_SPEC)
COLLECTOR_SPEC.loader.exec_module(COLLECTOR)


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

    def test_worker_diagnostic_is_admitted_and_validated(self):
        path = self.root / "worker-diagnostic.tar"
        archive(path, {
            "worker-diagnostic.json": receipt("diagnostic", {
                "schema": "pirate.native-notes-worker-diagnostic/1",
                "unit": "pirate-native-notes-worker.service",
                "observedUtc": "2026-11-25T06:33:27.005202541Z",
                "workerRc": 1,
                "systemd": {"result": "oom-kill", "execMainCode": "exited", "execMainStatus": "1"},
                "cgroup": {"memoryPeak": "1614960", "memoryCurrent": "0", "events": {"oom": "1", "oom_kill": "1"}},
                "oomEvents": [{"pid": 3442, "comm": "MainThread", "uid": 1000,
                              "totalVmKb": 63732780, "anonRssKb": 1614960}],
                "journalEvents": [{"pid": 3442, "executable": "node", "message": "worker started"}],
                "processes": [{"pid": 3442, "ppid": 1, "comm": "MainThread", "uid": 1000,
                              "rssKb": 1614960, "executable": "node"}],
            }),
        })
        records, _pins, _manifest = MODULE.receipt_set(path, MODULE.HOLD, set())
        MODULE.verify_worker_hold(records)

    def test_worker_diagnostic_collection_error_is_admitted(self):
        path = self.root / "worker-diagnostic-error.tar"
        archive(path, {
            "worker-diagnostic.json": receipt("diagnostic", {
                "schema": "pirate.native-notes-worker-diagnostic/1",
                "unit": "pirate-native-notes-worker.service",
                "observedUtc": "2026-11-25T07:02:59.531872901Z",
                "workerRc": 1,
                "systemd": {}, "cgroup": {}, "oomEvents": [], "journalEvents": [], "processes": [],
                "collectionError": "UnicodeDecodeError",
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

    def test_install_server_refusal_extended_shape_accepted(self):
        for module in (MODULE, COLLECTOR):
            base = {
                "boundary": "install-apply", "errorClass": "AssertionError",
                "message": "original_start_effect_uncertain", "responseStatus": 502,
                "throwSite": "apply-start-effect",
            }
            module.validate_install_server_refusal(dict(base))
            with_container = dict(base, container={
                "present": True, "running": False, "exitCode": 1, "oomKilled": False,
            })
            module.validate_install_server_refusal(with_container)
            module.validate_install_server_refusal(dict(base, container={"present": False}))
            module.validate_install_server_refusal(dict(
                base, boundary="install-before-apply", errorClass="NotFound",
                message="unclassified-private-error", throwSite="unknown"))
            module.validate_install_server_refusal(dict(base, boundary="install-after-apply"))

    def test_install_server_refusal_rejects_malformed_shape(self):
        base = {
            "boundary": "install-apply", "errorClass": "AssertionError",
            "message": "original_start_effect_uncertain", "responseStatus": 502,
            "throwSite": "apply-start-effect",
        }
        for module in (MODULE, COLLECTOR):
            for broken in (
                dict(base, message="Some Private Detail"),
                dict(base, container={"present": True, "running": False, "exitCode": 256, "oomKilled": False}),
                dict(base, container={"present": True, "running": False, "oomKilled": False}),
                dict(base, boundary="install-during-apply"),
                dict(base, throwSite="apply-start-effect", errorClass="TypeError"),
                {k: v for k, v in base.items() if k != "message"},
            ):
                with self.assertRaises(AssertionError):
                    module.validate_install_server_refusal(broken)

    def test_service_child_exit_shape_accepted(self):
        base = {
            "phase": "restart", "spawnedUtc": "2026-11-26T10:32:11.819Z",
            "exitUtc": "2026-11-26T10:34:15.767Z", "elapsedMs": 123948,
            "exitCode": 1, "signalCode": None, "pairCodeObserved": False,
        }
        for module in (MODULE, COLLECTOR):
            module.validate_service_child_exit(dict(base))
            module.validate_service_child_exit(dict(
                base, phase="initial", exitCode=None, signalCode="SIGTERM", pairCodeObserved=True))
            module.validate_service_child_exit(dict(base, exitCode=0, elapsedMs=0))

    def test_service_child_exit_rejects_malformed_shape(self):
        base = {
            "phase": "restart", "spawnedUtc": "2026-11-26T10:32:11.819Z",
            "exitUtc": "2026-11-26T10:34:15.767Z", "elapsedMs": 123948,
            "exitCode": 1, "signalCode": None, "pairCodeObserved": False,
        }
        for module in (MODULE, COLLECTOR):
            for broken in (
                dict(base, exitCode=None, signalCode=None),
                dict(base, exitCode=1, signalCode="SIGTERM"),
                dict(base, exitCode=256),
                dict(base, exitCode=-1),
                dict(base, signalCode="SIGTERM with detail"),
                dict(base, phase="relaunch"),
                dict(base, elapsedMs=-1),
                dict(base, exitUtc="2026-11-26T10:32:11.000Z"),
                dict(base, spawnedUtc="not a stamp"),
                dict(base, pairCodeObserved="yes"),
                {k: v for k, v in base.items() if k != "elapsedMs"},
                dict(base, extra="field"),
            ):
                with self.assertRaises(AssertionError):
                    module.validate_service_child_exit(broken)

    def test_launcher_interruption_shape_accepted(self):
        for module in (MODULE, COLLECTOR):
            module.validate_launcher_interruption({
                "at": "2026-11-26T10:34:15.767Z",
                "reason": "owned installed service exited before pairing",
            })
            module.validate_launcher_interruption({
                "at": "2026-11-26T10:34:15.767Z", "reason": "unclassified-private-error",
            })
            module.validate_launcher_interruption({
                "at": "2026-11-26T10:34:15.767Z", "reason": "bounded_native25_wait_expired",
            })

    def test_launcher_interruption_rejects_malformed_shape(self):
        base = {
            "at": "2026-11-26T10:34:15.767Z",
            "reason": "owned installed service exited before pairing",
        }
        for module in (MODULE, COLLECTOR):
            for broken in (
                dict(base, reason="AssertionError [ERR_ASSERTION]: detail"),
                dict(base, reason=""),
                dict(base, reason="x" * 121),
                dict(base, reason="MixedCase Detail"),
                dict(base, at="not a stamp"),
                {k: v for k, v in base.items() if k != "reason"},
                dict(base, extra="field"),
            ):
                with self.assertRaises(AssertionError):
                    module.validate_launcher_interruption(broken)

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

    def test_close_progress_entered_is_admitted_and_validated(self):
        path = self.root / "close-progress.tar"
        archive(path, {
            "close-progress.json": receipt("close-progress", {
                "schema": "pirate.native-launcher-close-progress/1",
                "logPresent": True, "closeEntered": True, "closeCompleted": False,
                "lastMarker": "chain-dump-before", "lastMarkerUtc": "2026-11-25T08:06:11.420Z",
                "markerCount": 14, "parseError": None,
            }),
        })
        records, _pins, _manifest = MODULE.receipt_set(path, MODULE.HOLD, set())
        MODULE.verify_worker_hold(records)
        self.assertEqual(records["close-progress.json"]["lastMarker"], "chain-dump-before")

    def test_close_progress_never_entered_is_explicit_and_validated(self):
        path = self.root / "close-never-entered.tar"
        archive(path, {
            "close-progress.json": receipt("close-progress", {
                "schema": "pirate.native-launcher-close-progress/1",
                "logPresent": False, "closeEntered": False, "closeCompleted": False,
                "lastMarker": None, "lastMarkerUtc": None, "markerCount": 0, "parseError": None,
            }),
        })
        records, _pins, _manifest = MODULE.receipt_set(path, MODULE.HOLD, set())
        MODULE.verify_worker_hold(records)

    def test_close_progress_completed_close_is_validated(self):
        path = self.root / "close-completed.tar"
        archive(path, {
            "close-progress.json": receipt("close-progress", {
                "schema": "pirate.native-launcher-close-progress/1",
                "logPresent": True, "closeEntered": True, "closeCompleted": True,
                "lastMarker": "terminal-after", "lastMarkerUtc": "2026-11-25T08:06:59.999Z",
                "markerCount": 21, "parseError": None,
            }),
        })
        records, _pins, _manifest = MODULE.receipt_set(path, MODULE.HOLD, set())
        MODULE.verify_worker_hold(records)

    def test_close_progress_inconsistent_fields_are_rejected(self):
        row = {
            "schema": "pirate.native-launcher-close-progress/1",
            "logPresent": False, "closeEntered": False, "closeCompleted": False,
            "lastMarker": "enter", "lastMarkerUtc": None, "markerCount": 0, "parseError": None,
        }
        with self.assertRaises(AssertionError):
            MODULE.verify_worker_hold({"close-progress.json": row})

    def test_close_progress_unknown_marker_is_rejected(self):
        row = {
            "schema": "pirate.native-launcher-close-progress/1",
            "logPresent": True, "closeEntered": True, "closeCompleted": False,
            "lastMarker": "private-detail-leak", "lastMarkerUtc": "2026-11-25T08:06:11.420Z",
            "markerCount": 1, "parseError": None,
        }
        with self.assertRaises(AssertionError):
            MODULE.verify_worker_hold({"close-progress.json": row})

    def test_controller_close_error_classes_are_admitted(self):
        for error in ("TimeoutExpired", "exact_native_runner_terminal_failure", "outer_guest_termination"):
            path = self.root / ("controller-" + error + ".tar")
            archive(path, {
                "controller-terminal.json": receipt("controller", {
                    "phase": "close", "status": "FAIL", "endedUtc": "2026-11-25T08:07:06.534+00:00",
                    "childExit": 143, "error": error,
                }),
            })
            records, _pins, _manifest = MODULE.receipt_set(path, MODULE.HOLD, set())
            MODULE.verify_worker_hold(records)
            self.assertEqual(records["controller-terminal.json"]["error"], error)

    def close_log(self, lines):
        path = self.root / "close.stderr.log"
        path.write_bytes("".join(lines).encode())
        path.chmod(0o600)
        return path

    def test_collector_parses_canonical_prefix_and_verifier_admits_it(self):
        log = self.close_log([
            "2026-11-25T08:05:01.001Z enter\n",
            "2026-11-25T08:05:01.120Z browser-before\n",
            "2026-11-25T08:05:02.420Z browser-after\n",
            "2026-11-25T08:05:02.430Z service-before\n",
        ])
        row = COLLECTOR.read_close_progress(log, owner=os.getuid())
        self.assertEqual(row["lastMarker"], "service-before")
        self.assertEqual(row["lastMarkerUtc"], "2026-11-25T08:05:02.430Z")
        self.assertEqual(row["markerCount"], 4)
        self.assertTrue(row["closeEntered"])
        self.assertFalse(row["closeCompleted"])
        self.assertIsNone(row["parseError"])
        MODULE.verify_worker_hold({"close-progress.json": json.loads(json.dumps(row))})

    def test_collector_completed_close_round_trips_through_verifier(self):
        lines = []
        for index, marker in enumerate(COLLECTOR.CLOSE_MARKERS):
            lines.append(f"2026-11-25T08:05:{index:02d}.000Z {marker}\n")
        row = COLLECTOR.read_close_progress(self.close_log(lines), owner=os.getuid())
        self.assertTrue(row["closeCompleted"])
        self.assertEqual(row["markerCount"], len(COLLECTOR.CLOSE_MARKERS))
        MODULE.verify_worker_hold({"close-progress.json": json.loads(json.dumps(row))})

    def test_collector_missing_log_is_explicit_not_entered(self):
        row = COLLECTOR.read_close_progress(self.root / "absent.stderr.log", owner=os.getuid())
        self.assertFalse(row["logPresent"])
        self.assertFalse(row["closeEntered"])
        self.assertIsNone(row["lastMarker"])
        self.assertIsNone(row["parseError"])
        MODULE.verify_worker_hold({"close-progress.json": row})

    def test_collector_malformed_line_preserves_valid_prefix(self):
        log = self.close_log([
            "2026-11-25T08:05:01.001Z enter\n",
            "2026-11-25T08:05:01.120Z browser-before\n",
            "garbage line with private detail\n",
            "2026-11-25T08:05:02.430Z service-before\n",
        ])
        row = COLLECTOR.read_close_progress(log, owner=os.getuid())
        self.assertEqual(row["parseError"], "malformed-line")
        self.assertEqual(row["lastMarker"], "browser-before")
        self.assertEqual(row["markerCount"], 2)
        MODULE.verify_worker_hold({"close-progress.json": row})

    def test_collector_regressing_order_is_malformed(self):
        log = self.close_log([
            "2026-11-25T08:05:01.001Z enter\n",
            "2026-11-25T08:05:01.120Z browser-after\n",
            "2026-11-25T08:05:02.430Z browser-before\n",
        ])
        row = COLLECTOR.read_close_progress(log, owner=os.getuid())
        self.assertEqual(row["parseError"], "malformed-line")
        self.assertEqual(row["lastMarker"], "browser-after")

    def test_collector_oversized_log_is_bounded(self):
        path = self.close_log(["2026-11-25T08:05:01.001Z enter\n"])
        with path.open("ab") as stream:
            stream.write(b"x" * (64 * 1024))
        row = COLLECTOR.read_close_progress(path, owner=os.getuid())
        self.assertEqual(row["parseError"], "oversized")
        self.assertFalse(row["closeEntered"])

    def test_collector_wrong_owner_is_unreadable(self):
        log = self.close_log(["2026-11-25T08:05:01.001Z enter\n"])
        row = COLLECTOR.read_close_progress(log, owner=os.getuid() + 1)
        self.assertEqual(row["parseError"], "unreadable")
        self.assertFalse(row["closeEntered"])

    def artifact_root(self, run_id="manual-abcdef123456"):
        root = self.root / "pw2"
        directory = root / "artifacts" / run_id
        directory.mkdir(parents=True)
        return root, directory

    def test_collector_artifact_progress_round_trips_through_verifier(self):
        root, directory = self.artifact_root()
        (directory / "rehearsal-reopened-original.json").write_text("{}")
        (directory / "rehearsal-reopened-original.json").chmod(0o600)
        after = directory / "reopened" / "application-after"
        after.mkdir(parents=True)
        (after / "application-browser-control.json").write_text("{}")
        (after / "application-browser-control.json").chmod(0o600)
        row = COLLECTOR.read_artifact_progress(root, owner=os.getuid())
        self.assertEqual(row["runId"], "manual-abcdef123456")
        self.assertIsNone(row["parseError"])
        reopened = row["entries"]["rehearsal-reopened-original.json"]
        self.assertTrue(reopened["present"])
        self.assertEqual(reopened["size"], 2)
        self.assertTrue(reopened["mtimeUtc"].endswith("Z"))
        self.assertFalse(row["entries"]["rehearsal-notes-replay.json"]["present"])
        self.assertEqual(set(row["entries"]["rehearsal-notes-replay.json"]), {"present"})
        milestones = row["milestones"]["reopened/application-after"]
        self.assertTrue(milestones["application-browser-control.json"]["present"])
        self.assertFalse(milestones["manual-application-http-observations.json"]["present"])
        self.assertFalse(milestones["w6-native-notes-after.json"]["present"])
        before = row["milestones"]["application-before"]
        self.assertTrue(all(not entry["present"] for entry in before.values()))
        MODULE.verify_worker_hold({"artifact-progress.json": json.loads(json.dumps(row))})

    def test_collector_artifact_progress_missing_root_is_explicit(self):
        row = COLLECTOR.read_artifact_progress(self.root / "absent", owner=os.getuid())
        self.assertIsNone(row["runId"])
        self.assertIsNone(row["parseError"])
        self.assertTrue(all(not entry["present"] for entry in row["entries"].values()))
        MODULE.verify_worker_hold({"artifact-progress.json": row})

    def test_collector_artifact_progress_ambiguous_run_dirs(self):
        root, _directory = self.artifact_root()
        other = root / "artifacts" / "manual-000000aaaaaa"
        other.mkdir()
        row = COLLECTOR.read_artifact_progress(root, owner=os.getuid())
        self.assertEqual(row["parseError"], "ambiguous-run-dir")
        self.assertIsNone(row["runId"])
        MODULE.verify_worker_hold({"artifact-progress.json": row})

    def test_collector_artifact_progress_skips_symlink_entries(self):
        root, directory = self.artifact_root()
        target = self.root / "elsewhere.json"
        target.write_text("{}")
        (directory / "manual-demo-ended.json").symlink_to(target)
        row = COLLECTOR.read_artifact_progress(root, owner=os.getuid())
        self.assertFalse(row["entries"]["manual-demo-ended.json"]["present"])

    def test_artifact_progress_inconsistent_entries_are_rejected(self):
        row = {
            "schema": "pirate.native-launcher-artifact-progress/1",
            "runId": None,
            "entries": {name: {"present": True, "size": 2, "mtimeUtc": "2026-11-25T08:05:01.000Z"}
                        for name in COLLECTOR.ARTIFACT_NAMES},
            "parseError": None,
        }
        with self.assertRaises(AssertionError):
            MODULE.verify_worker_hold({"artifact-progress.json": row})

    def test_artifact_progress_unknown_entry_shape_is_rejected(self):
        entries = {name: {"present": False} for name in COLLECTOR.ARTIFACT_NAMES}
        entries["terminal.json"] = {"present": True}
        row = {
            "schema": "pirate.native-launcher-artifact-progress/1",
            "runId": "manual-abcdef123456",
            "entries": entries,
            "parseError": None,
        }
        with self.assertRaises(AssertionError):
            MODULE.verify_worker_hold({"artifact-progress.json": row})

    def memory_files(self, meminfo, vmstat):
        mem = self.root / "meminfo"
        mem.write_text(meminfo)
        stat = self.root / "vmstat"
        stat.write_text(vmstat)
        return mem, stat

    def test_collector_guest_memory_round_trips_through_verifier(self):
        mem, stat = self.memory_files(
            "MemTotal:        4045712 kB\nMemFree:          120000 kB\nMemAvailable:     300000 kB\n"
            "Buffers:           10000 kB\nCached:           400000 kB\nSwapTotal:       1000000 kB\n"
            "SwapFree:         900000 kB\nCommitted_AS:    3000000 kB\n",
            "pswpin 12\npswpout 34\noom_kill 0\notherkey 99\n",
        )
        row = COLLECTOR.read_guest_memory(mem, stat)
        self.assertIsNone(row["parseError"])
        self.assertEqual(row["meminfoKb"]["MemTotal"], 4045712)
        self.assertEqual(row["meminfoKb"]["Committed_AS"], 3000000)
        self.assertEqual(row["vmstat"]["pswpin"], 12)
        self.assertEqual(row["vmstat"]["pswpout"], 34)
        self.assertEqual(row["vmstat"]["oom_kill"], 0)
        MODULE.verify_worker_hold({"guest-memory.json": json.loads(json.dumps(row))})

    def test_collector_guest_memory_missing_files_is_explicit(self):
        row = COLLECTOR.read_guest_memory(self.root / "absent-meminfo", self.root / "absent-vmstat")
        self.assertEqual(row["parseError"], "unreadable")
        MODULE.verify_worker_hold({"guest-memory.json": row})

    def test_guest_memory_out_of_range_total_is_rejected(self):
        row = {
            "schema": "pirate.guest-memory-hold/1",
            "meminfoKb": {key: None for key in COLLECTOR.MEMINFO_KEYS},
            "vmstat": {key: None for key in COLLECTOR.VMSTAT_KEYS},
            "parseError": None,
        }
        row["meminfoKb"]["MemTotal"] = 1024
        with self.assertRaises(AssertionError):
            MODULE.verify_worker_hold({"guest-memory.json": row})

    def ndjson_log(self, name, lines):
        path = self.root / name
        path.write_text("".join(lines))
        path.chmod(0o600)
        return path

    def test_collector_native_progress_round_trips_through_verifier(self):
        lines = [
            json.dumps({"at": "2026-11-25T08:05:01.001Z", "kind": "role", "role": "launcher",
                        "pid": 3400, "ppid": 3399, "startTicks": "102030", "comm": "MainThread"}) + "\n",
            json.dumps({"at": "2026-11-25T08:05:02.001Z", "kind": "op", "op": "application-before", "event": "enter"}) + "\n",
            json.dumps({"at": "2026-11-25T08:06:02.001Z", "kind": "op", "op": "capture-save", "event": "enter"}) + "\n",
            json.dumps({"at": "2026-11-25T08:06:02.101Z", "kind": "op", "op": "capture-save", "event": "return"}) + "\n",
            json.dumps({"at": "2026-11-25T08:06:03.001Z", "kind": "op", "op": "browser-close", "event": "enter"}) + "\n",
        ]
        row = COLLECTOR.read_native_progress(self.ndjson_log("native-progress.ndjson", lines), owner=os.getuid())
        self.assertIsNone(row["parseError"])
        self.assertEqual(row["rowCount"], 5)
        self.assertEqual(row["finalRow"]["op"], "browser-close")
        self.assertEqual(sorted(row["openOps"]), ["application-before", "browser-close"])
        MODULE.verify_worker_hold({"native-progress.json": json.loads(json.dumps(row))})

    def test_collector_native_progress_missing_log_is_explicit(self):
        row = COLLECTOR.read_native_progress(self.root / "absent.ndjson", owner=os.getuid())
        self.assertFalse(row["logPresent"])
        self.assertEqual(row["rows"], [])
        self.assertIsNone(row["parseError"])
        MODULE.verify_worker_hold({"native-progress.json": row})

    def test_collector_native_progress_malformed_line_preserves_valid_prefix(self):
        lines = [
            json.dumps({"at": "2026-11-25T08:05:01.001Z", "kind": "op", "op": "capture-save", "event": "enter"}) + "\n",
            json.dumps({"at": "2026-11-25T08:05:01.001Z", "kind": "op", "op": "not-a-real-op", "event": "enter"}) + "\n",
        ]
        row = COLLECTOR.read_native_progress(self.ndjson_log("native-progress.ndjson", lines), owner=os.getuid())
        self.assertEqual(row["parseError"], "malformed-line")
        self.assertEqual(row["rowCount"], 1)
        MODULE.verify_worker_hold({"native-progress.json": row})

    def test_verifier_rejects_unknown_progress_op(self):
        row = {
            "schema": "pirate.native-launcher-progress/1",
            "logPresent": True,
            "rows": [{"at": "2026-11-25T08:05:01.001Z", "kind": "op", "op": "invented-op", "event": "enter"}],
            "rowCount": 1,
            "finalRow": {"at": "2026-11-25T08:05:01.001Z", "kind": "op", "op": "invented-op", "event": "enter"},
            "openOps": ["invented-op"],
            "parseError": None,
        }
        with self.assertRaises(AssertionError):
            MODULE.verify_worker_hold({"native-progress.json": row})

    def test_collector_native_memory_round_trips_through_verifier(self):
        samples = [
            {"at": "2026-11-25T08:05:01.001Z", "kind": "sample", "launcherRssKb": 200000,
             "servicePid": 3500, "serviceRssKb": 100000, "memAvailableKb": 3500000, "uidRssKb": 600000},
            {"at": "2026-11-25T08:05:03.001Z", "kind": "sample", "launcherRssKb": 220000,
             "servicePid": 3500, "serviceRssKb": 140000, "memAvailableKb": 3400000, "uidRssKb": 700000},
            {"at": "2026-11-25T08:05:05.001Z", "kind": "sample", "launcherRssKb": 260000,
             "servicePid": None, "serviceRssKb": None, "memAvailableKb": 3300000, "uidRssKb": 650000},
        ]
        lines = [json.dumps(sample) + "\n" for sample in samples]
        row = COLLECTOR.read_native_memory(self.ndjson_log("native-memory.ndjson", lines), owner=os.getuid())
        self.assertIsNone(row["parseError"])
        self.assertEqual(row["sampleCount"], 3)
        self.assertEqual(row["finalSample"], samples[-1])
        self.assertEqual(row["peakLauncherRssKb"], 260000)
        self.assertEqual(row["peakServiceRssKb"], 140000)
        self.assertEqual(row["peakUidRssKb"], 700000)
        self.assertEqual(row["minMemAvailableKb"], 3300000)
        MODULE.verify_worker_hold({"native-memory.json": json.loads(json.dumps(row))})

    def test_collector_native_memory_missing_log_is_explicit(self):
        row = COLLECTOR.read_native_memory(self.root / "absent.ndjson", owner=os.getuid())
        self.assertFalse(row["logPresent"])
        self.assertEqual(row["samples"], [])
        self.assertIsNone(row["parseError"])
        self.assertIsNone(row["peakLauncherRssKb"])
        MODULE.verify_worker_hold({"native-memory.json": row})

    def test_collector_native_memory_malformed_line_preserves_valid_prefix(self):
        lines = [
            json.dumps({"at": "2026-11-25T08:05:01.001Z", "kind": "sample", "launcherRssKb": 200000,
                        "servicePid": None, "serviceRssKb": None, "memAvailableKb": 3500000, "uidRssKb": 600000}) + "\n",
            json.dumps({"at": "2026-11-25T08:05:03.001Z", "kind": "sample", "launcherRssKb": -5,
                        "servicePid": None, "serviceRssKb": None, "memAvailableKb": 3500000, "uidRssKb": 600000}) + "\n",
        ]
        row = COLLECTOR.read_native_memory(self.ndjson_log("native-memory.ndjson", lines), owner=os.getuid())
        self.assertEqual(row["parseError"], "malformed-line")
        self.assertEqual(row["sampleCount"], 1)
        MODULE.verify_worker_hold({"native-memory.json": row})

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
