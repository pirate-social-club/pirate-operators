"""Verify only the offline Notes guest's allowlisted return and terminal facts."""
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import tarfile


def _load_collector():
    spec = importlib.util.spec_from_file_location(
        "collect_notes_evidence", Path(__file__).resolve().parent / "collect-notes-evidence.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validate_native_memory_sample = _load_collector().validate_native_memory_sample


def validate_native_progress_receipt(row):
    assert set(row) == {"schema", "logPresent", "rows", "rowCount", "finalRow", "openOps", "parseError"}
    assert row["schema"] == "pirate.native-launcher-progress/1"
    assert type(row["logPresent"]) is bool
    assert type(row["rows"]) is list and type(row["rowCount"]) is int
    assert row["rowCount"] == len(row["rows"]) and 0 <= row["rowCount"] <= 4096
    for entry in row["rows"]:
        assert type(entry) is dict and isinstance(entry.get("at"), str) and UTC_STAMP.fullmatch(entry["at"])
        if entry.get("kind") == "op":
            assert set(entry) == {"at", "kind", "op", "event"}
            assert entry["op"] in PROGRESS_OPS and entry["event"] in {"enter", "return"}
        else:
            assert entry.get("kind") == "role"
            assert set(entry) == {"at", "kind", "role", "pid", "ppid", "startTicks", "comm"}
            assert entry["role"] in PROGRESS_ROLES
            assert type(entry["pid"]) is int and entry["pid"] > 0
            assert type(entry["ppid"]) is int and entry["ppid"] > 0
            assert isinstance(entry["startTicks"], str) and entry["startTicks"].isdigit()
            assert isinstance(entry["comm"], str) and 0 < len(entry["comm"]) <= 64
    assert row["finalRow"] is None or row["rowCount"] >= 1
    if row["rowCount"]:
        assert row["finalRow"] == row["rows"][-1]
    else:
        assert row["finalRow"] is None
    assert type(row["openOps"]) is list and all(op in PROGRESS_OPS for op in row["openOps"])
    assert row["parseError"] is None or row["parseError"] in NDJSON_PARSE_ERRORS


def validate_native_memory_receipt(row):
    assert set(row) == {"schema", "logPresent", "samples", "sampleCount", "finalSample",
                        "peakLauncherRssKb", "peakServiceRssKb", "peakUidRssKb", "minMemAvailableKb", "parseError"}
    assert row["schema"] == "pirate.native-memory-samples/1"
    assert type(row["logPresent"]) is bool
    assert type(row["samples"]) is list and type(row["sampleCount"]) is int
    assert row["sampleCount"] == len(row["samples"]) and 0 <= row["sampleCount"] <= 2048
    for sample in row["samples"]:
        assert type(sample) is dict and validate_native_memory_sample(sample)
    assert row["finalSample"] is None or row["sampleCount"] >= 1
    if row["sampleCount"]:
        assert row["finalSample"] == row["samples"][-1]
    else:
        assert row["finalSample"] is None
    for key in ("peakLauncherRssKb", "peakServiceRssKb", "peakUidRssKb", "minMemAvailableKb"):
        assert row[key] is None or (type(row[key]) is int and 0 <= row[key] < 2 ** 40)
    assert row["parseError"] is None or row["parseError"] in NDJSON_PARSE_ERRORS



IMAGE = "sha256:eadd63a378767e660337c2f3b2b594ad0c869ebeebada873a7a06bc9b6194a23"
SUCCESS = {
    "isolation.json", "socket.json", "socket-image.json", "socket-terminal.json", "resources.json",
    "controller-terminal.json", "browser-egress.json",
    "release-image.json", "restart-before.json", "restart-terminal.json", "restart-after.json", "reopened-original.json",
    "initial-unpaired.json", "wizard-held.json", "wizard-funded.json", "wizard-installed.json", "wizard-reopened.json",
    "replay.json", "launcher-terminal.json", "notes-before.json", "binding-before.json",
    "notes-after.json", "binding-after.json",
}
SUCCESS_OPTIONAL = {"native-progress.json", "native-memory.json"}

HOLD = {
    "hold-terminal.json", "worker-diagnostic.json", "controller-terminal.json", "browser-egress.json",
    "startup-progress.json", "chain-init-refusal.json", "wizard-install-refusal.json", "install-server-refusal.json",
    "close-progress.json", "artifact-progress.json", "guest-memory.json",
    "native-progress.json", "native-memory.json",
}
STARTUP_PHASES = (
    "fixture-refresh-enter",
    "fixture-refresh-done",
    "bridge-check-enter",
    "bridge-check-done",
    "service-spawn-enter",
    "service-pid-observed",
    "pair-code-wait-enter",
    "pair-code-observed",
    "service-identity-verified",
    "unpaired-http-enter",
    "unpaired-http-verified",
    "unpaired-effects-clear",
    "initial-wizard-browser-enter",
)
UTC_STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:Z|\+00:00)")
HOLD_PHASES = {
    "preflight", "start", "local_startup", "initial_wizard", "hold-registration", "fund-original",
    "install-original", "notes-publish", "ordinary_native_restart", "retained-repair",
    "notes-replay", "close",
}
HOLD_ERRORS = {
    "guest_prompt_timeout_startup_ready", "guest_prompt_timeout_handoff",
    "unexpected_guest_prompt_order_handoff", "native_runner_exit", "guest_private_pty_read",
    "guest_pty_event_queue_full", "unclassified-private-error",
    "TimeoutExpired", "exact_native_runner_terminal_failure", "outer_guest_termination",
}
CLOSE_MARKERS = (
    "enter",
    "browser-before", "browser-after",
    "service-before", "service-after",
    "containers-before", "containers-after",
    "servers-before", "servers-after",
    "tick-after", "mining-after",
    "external-after", "hosted-after",
    "chain-dump-before", "chain-dump-after",
    "chain-close-after", "role-agent-after",
    "lease-before", "lease-after",
    "terminal-before", "terminal-after",
)
CLOSE_PARSE_ERRORS = {"malformed-line", "unreadable", "oversized"}
ARTIFACT_NAMES = (
    "rehearsal-release-image.json",
    "inputs.json",
    "notes-initial-unpaired.json",
    "disposable-registration-approval.json",
    "hosted-keys-retired-originals.json",
    "managed-services-prestarted.json",
    "manual-wizard-observed-running.json",
    "registrar-permission-succession.json",
    "rehearsal-restart-original.json",
    "rehearsal-restart-terminal.json",
    "rehearsal-restart-new-boot.json",
    "rehearsal-reopened-original.json",
    "rehearsal-notes-replay.json",
    "manual-demo-ended.json",
    "manual-interruption.json",
    "owned-local-chain-state.json",
    "terminal.json",
)
RUN_ID = re.compile(r"manual-[a-f0-9]{12}\Z")
ARTIFACT_PARSE_ERRORS = {"artifacts-unreadable", "ambiguous-run-dir"}
MILESTONE_FILES = {
    "application-before": (
        "application-browser-control.json",
        "manual-application-http-observations.json",
        "w6-native-notes-before.json",
        "w6-native-notes-binding.json",
    ),
    "reopened": (
        "w6-wizard-retained-repair.json",
    ),
    "reopened/application-after": (
        "application-browser-control.json",
        "manual-application-http-observations.json",
        "w6-native-notes-after.json",
        "w6-native-notes-binding.json",
    ),
}
MEMINFO_KEYS = ("MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SwapTotal", "SwapFree", "Committed_AS")
VMSTAT_KEYS = ("pswpin", "pswpout", "oom_kill")
MEMORY_PARSE_ERRORS = {"unreadable"}
PROGRESS_OPS = {
    "service-pair-wait",
    "terminal-question-before", "terminal-question-after",
    "application-before", "application-after",
    "notes-receipt-before", "notes-receipt-after",
    "restart-service-stop", "restart-container-stop", "restart-service-launch",
    "restart-snapshot-after", "restart-authority-after", "restart-boot-verify",
    "replay-final-checks", "replay-record",
    "capture-save", "browser-close",
}
PROGRESS_ROLES = {"launcher", "service"}
NDJSON_PARSE_ERRORS = {"unreadable", "oversized", "malformed-line"}
CHAIN_INIT_CLASSES = {
    "WaitForTransactionReceiptTimeoutError", "TransactionReceiptNotFoundError", "TransactionNotFoundError",
    "HttpRequestError", "TimeoutError", "AssertionError", "AbortError", "Other",
}
INSTALL_REFUSAL_STAGES = {
    "install-planned-journal",
    "install-planned-original",
    "install-plan-draft",
    "install-review-checkbox",
    "install-budget",
    "install-request",
    "install-response",
    "install-status-decision-journal",
    "installation-status-budget",
    "installation-status-request",
    "installation-status-response",
    "install-final-journal",
    "install-final-original",
    "install-running-observation",
    "install-running-indicator",
    "install-signing-read",
    "install-signing-attachment",
    "install-receipt-fields",
    "install-final-budget",
    "installation-prepare-attached-indicator", "installation-prepare-budget",
    "installation-prepare-request", "installation-prepare-response",
    "select-wizard-page", "held-receipt-path", "held-receipt-file", "funded-journal-path",
    "funded-journal-file", "check-original-origin-controller", "check-original-prepared",
    "check-original-continuity", "check-funded-phase", "review-publishing-checkbox",
    "publishing-prepare-budget", "publishing-prepare-request", "publishing-prepare-response",
}
INSTALL_REFUSAL_CLASSES = {"AssertionError", "TimeoutError", "Error", "SyntaxError", "TypeError", "Other"}
PUBLISHING_PREPARE_SKIPS = {
    "observer-unavailable", "observer-deadline", "response-mismatch", "unexpected-content-type",
    "stream-unavailable", "body-too-large", "no-allowlisted-code",
}
PUBLISHING_PREPARE_CODES = {
    "configuration_event_mismatch", "configuration_history_conflict", "configuration_history_missing",
    "configuration_not_canonical", "directory_binding_changed", "directory_chain_reorganized",
    "directory_code_changed", "directory_not_confirmed", "directory_query_clock_regressed",
    "directory_state_event_mismatch", "directory_verification_snapshot_mismatch", "install_directory_unavailable",
    "invalid_directory_configuration", "managed_admission_unavailable", "managed_configuration_changed",
    "managed_credential_unavailable", "managed_custody_unavailable", "managed_installed_inputs_unavailable",
    "managed_issuer_unavailable", "managed_original_conflict", "managed_original_unavailable",
    "managed_profile_unavailable", "managed_scope_changed", "managed_service_configuration_unavailable",
    "managed_service_refused", "managed_service_response_invalid", "managed_service_transport_unknown",
    "managed_service_unavailable", "origin_configuration_event_missing", "origin_event_provenance_changed",
    "original_install_registration_not_safe", "original_install_transaction_mismatch", "original_install_transaction_unavailable",
    "publisher_custody_binding_unavailable", "unadmitted_install_deployment", "web2_managed_grant_admission_unavailable",
    "web2_publishing_authority_unavailable", "web2_setup_unavailable", "wrong_application_chain",
}
INSTALLATION_PREPARE_CODES = {
  "install_authority_expired_during_read", "install_chain_reorganized", "install_current_authority_changed",
  "install_posts_source_changed", "public_ipfs_unavailable", "safe_registration_required",
  "web2_installation_context_changed", "web2_installation_unavailable", "web2_original_practice_selection_changed",
  "web2_pairing_only", "web2_private_practice_selection_invalid", "web2_private_study_unavailable",
  "web2_publishing_attachment_required", "web2_revision_changed", "web2_signing_original_unreadable",
}
EARLY_HOLD = {"pre-docker-terminal.json"}
EARLY_HOLD_STAGES = {"guest-preflight", "guest-docker-package"}
PACKAGE_PHASES = {"docker-package-policy", "docker-package-install", "docker-package-audit", "docker-package-identity"}
PACKAGE_FIELDS = {
    "installWrapperExit", "auditWrapperExit", "auditHasOutput", "installStderrBytes", "installStderrSha256",
}
PRE_DOCKER_PHASES = {
    "bootstrap-identity", "serial-redirect", "bootstrap-arguments", "guest-preflight", "evidence-port",
    "mount-prereqs", "mount-smoke", "mount-entry", "mount-display", "prereqs-checksum", "media-checksum",
    "docker-signature",
} | PACKAGE_PHASES
TERMINAL = re.compile(r"^PIRATE_SMOKE_TERMINAL stage=([a-z-]+) rc=(\d+) cleanup=(\d+) cutoff=(\d+) utc=(\S+)$", re.MULTILINE)
EXPORT = re.compile(r"^PIRATE_NOTES_EXPORT (\d+) ([0-9a-f]{64})$", re.MULTILINE)


INSTALL_SERVER_BOUNDARIES = {
    "http-before-setup", "wizard-before-install-port", "installed-prepare-before-release-sign",
    "installed-prepare-release-sign", "installed-prepare-application-release-sign",
    "installed-prepare-admission-sign", "installed-prepare-after-admission-sign",
    "installed-prepare-profile-sign", "installed-prepare-after-profile-sign",
    "wizard-after-install-port",
}
INSTALL_SERVER_CLASSES = {
    "AssertionError", "NotFound", "AccessDenied", "NoSpace", "Timeout", "ConnectionRefused",
    "TransactionNotFoundError", "TransactionReceiptNotFoundError", "HttpRequestError",
    "RpcRequestError", "TimeoutError", "InvalidSerializableTransactionError", "InvalidLegacyVError",
    "TypeError", "SyntaxError", "RangeError", "Error", "Other",
}


INSTALL_SERVER_THROW_SITES = {
    "unknown",
    "binder-policy-window",
    "binder-origin",
    "binder-host",
    "binder-retained-issuer",
    "binder-new-issuer",
    "installer-open",
    "installer-exclusive",
    "installer-deployment",
    "installer-host",
    "installer-profile",
    "host-daemon",
    "host-state-writer",
    "release-directory-mode",
    "release-pathset",
    "release-symlink",
    "release-file-mode",
    "release-file-bytes",
}


POST_PLAN_REQUEST_STAGES = {"install-request", "install-response",
                            "installation-status-request", "installation-status-response"}
POST_PLAN_RESPONSE_STAGES = {"install-response", "installation-status-response"}


def validate_post_plan_action(row):
    stage, status = row["stage"], row["responseStatus"]
    if stage not in POST_PLAN_REQUEST_STAGES:
        assert "requestCount" not in row
        return
    count = row.get("requestCount")
    assert type(count) is int and count in {0, 1, 2}
    if stage in POST_PLAN_RESPONSE_STAGES:
        assert count == 1 and type(status) is int and 100 <= status <= 599
    else:
        assert status is None


def validate_install_client_observation(row):
    if "clientObservation" not in row:
        return
    observed = row["clientObservation"]
    stage, status = row["stage"], row["responseStatus"]
    assert stage in {"installation-prepare-request", "installation-prepare-response"}
    assert isinstance(observed, dict) and set(observed) == {
        "requestCount", "requestFailed", "clickCompleted", "elapsedMs", "waitMs",
        "phaseRemainingMs", "workerRemainingMs", "productFetchCapMs", "clickCapMs",
    }
    assert type(observed["requestCount"]) is int and observed["requestCount"] in {0, 1, 2}
    assert type(observed["requestFailed"]) is bool and type(observed["clickCompleted"]) is bool
    assert observed["requestCount"] or not observed["requestFailed"]
    assert (status is None and stage == "installation-prepare-request") or (
        status is not None and stage == "installation-prepare-response" and observed["requestCount"] == 1
    )
    bounds = {"elapsedMs": (0, 1860000), "waitMs": (1, 1800000),
              "phaseRemainingMs": (90001, 1860000), "workerRemainingMs": (40001, 5400000)}
    for key, (minimum, maximum) in bounds.items():
        assert type(observed[key]) is int and minimum <= observed[key] <= maximum
    assert observed["phaseRemainingMs"] + 40000 <= observed["workerRemainingMs"]
    assert observed["waitMs"] <= min(observed["phaseRemainingMs"] - 90000, observed["workerRemainingMs"] - 40000)
    assert type(observed["productFetchCapMs"]) is int and observed["productFetchCapMs"] == 180000
    assert type(observed["clickCapMs"]) is int and observed["clickCapMs"] == 15000


def validate_install_server_refusal(row):
    assert isinstance(row, dict) and set(row) == {"boundary", "errorClass", "responseStatus", "throwSite"}
    assert row["boundary"] in INSTALL_SERVER_BOUNDARIES and row["errorClass"] in INSTALL_SERVER_CLASSES
    assert type(row["responseStatus"]) is int and row["responseStatus"] == 502
    assert row["throwSite"] in INSTALL_SERVER_THROW_SITES
    assert row["throwSite"] == "unknown" or row["errorClass"] == "AssertionError"
    if row["boundary"] == "http-before-setup":
        assert row["errorClass"] == "Other"


def receipt_set(path, allowed, required):
    assert 0 < path.stat().st_size <= 25 * 1024 ** 2, "evidence archive is empty or oversized"
    with tarfile.open(path, "r:") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        duplicates = sorted({name for name in names if names.count(name) > 1})
        assert not duplicates, f"duplicate evidence member(s): {', '.join(duplicates)}"
        for member in members:
            assert member.isfile(), f"non-file evidence member: {member.name}"
            assert member.size <= 1024 ** 2, f"oversized evidence member: {member.name} ({member.size} bytes)"
        contents = {member.name: archive.extractfile(member).read() for member in members}
        with path.open("rb") as stream:
            stream.seek(archive.offset)
            assert not any(stream.read()), "unexpected archive padding"
    manifest = contents.pop("RUN-SHA256SUMS")
    pairs = [line.split("  ", 1) for line in manifest.decode().splitlines()]
    assert pairs and all(len(row) == 2 for row in pairs), "malformed evidence manifest"
    pins = {}
    for pin, name in pairs:
        assert name not in pins, f"duplicate manifest entry: {name}"
        pins[name] = pin
    missing = sorted(set(pins) - set(contents))
    unlisted = sorted(set(contents) - set(pins))
    assert not missing and not unlisted, (
        f"manifest/member mismatch: missing={missing}; unlisted={unlisted}"
    )
    for name in sorted(contents):
        actual = hashlib.sha256(contents[name]).hexdigest()
        assert actual == pins[name], f"hash mismatch for {name}: expected {pins[name]}, got {actual}"
    missing_required = sorted(required - set(names))
    assert not missing_required, f"missing required evidence receipt(s): {', '.join(missing_required)}"
    unexpected = sorted(set(names) - set(allowed) - {"RUN-SHA256SUMS"})
    if unexpected:
        summary = ""
        controller = contents.get("controller-terminal.json")
        if controller:
            try:
                row = json.loads(controller)
            except (UnicodeDecodeError, json.JSONDecodeError):
                row = None
            if isinstance(row, dict):
                summary = (
                    f"; controller phase={row.get('phase')} status={row.get('status')} "
                    f"childExit={row.get('childExit')} error={row.get('error')}"
                )
        raise AssertionError(
            f"unexpected evidence member(s): {', '.join(unexpected)}{summary}"
        )
    for name, value in contents.items():
        assert value, f"empty evidence receipt: {name}"
    records = {}
    for name, value in contents.items():
        try:
            records[name] = json.loads(value)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"invalid JSON receipt {name}: {error}") from error
    return records, pins, hashlib.sha256(manifest).hexdigest()


def assess_early_hold(run, returned, terminal, result):
    assert returned.stat().st_size <= 16 * 1024
    records, _pins, manifest = receipt_set(returned, EARLY_HOLD, EARLY_HOLD)
    record = records["pre-docker-terminal.json"]
    fields = {"phase", "rc", "cleanup", "cutoffMs", "gpgvExit", "validsigExit", "utc"}
    phase = record["phase"]
    assert phase in PRE_DOCKER_PHASES
    assert set(record) == (fields | PACKAGE_FIELDS if phase in PACKAGE_PHASES else fields)
    assert type(record["rc"]) is int and 0 < record["rc"] <= 255
    assert type(record["cleanup"]) is int and record["cleanup"] in (0, 1)
    assert type(record["cutoffMs"]) is int and record["cutoffMs"] == int((run / "WORKER-CUTOFF-MS.txt").read_text())
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z", record["utc"])
    closed = datetime.fromisoformat(record["utc"])
    assert datetime.fromisoformat((run / "QEMU-STARTED-UTC.txt").read_text().strip()) <= closed
    assert closed.timestamp() < int((run / "DISPATCH-EXPIRY-EPOCH.txt").read_text())
    for code in (record["gpgvExit"], record["validsigExit"]):
        assert code is None or (type(code) is int and 0 <= code <= 255)
    assert record["validsigExit"] is None or record["gpgvExit"] == 0
    if phase in PACKAGE_PHASES:
        assert record["gpgvExit"] == record["validsigExit"] == 0
        for code in (record["installWrapperExit"], record["auditWrapperExit"]):
            assert code is None or (type(code) is int and 0 <= code <= 255)
        audit_output = record["auditHasOutput"]
        assert audit_output is None or type(audit_output) is bool
        stderr_size, stderr_hash = record["installStderrBytes"], record["installStderrSha256"]
        if stderr_size is None:
            assert stderr_hash is None
        else:
            assert type(stderr_size) is int and stderr_size >= 0
            assert isinstance(stderr_hash, str) and re.fullmatch(r"[0-9a-f]{64}", stderr_hash)
        if phase == "docker-package-policy":
            assert all(record[key] is None for key in PACKAGE_FIELDS)
        if phase == "docker-package-install":
            assert record["auditWrapperExit"] is None and audit_output is None
        if phase in {"docker-package-audit", "docker-package-identity"}:
            assert record["installWrapperExit"] == 0
        if phase == "docker-package-identity":
            assert record["auditWrapperExit"] == 0 and audit_output is False
    else:
        assert phase == "docker-signature" or record["gpgvExit"] is None
    if terminal:
        assert terminal[0][0] == ("guest-docker-package" if phase in PACKAGE_PHASES else "guest-preflight")
        assert len(terminal) == 1 and tuple(map(int, terminal[0][1:4])) == (
            record["rc"], record["cleanup"], record["cutoffMs"],
        )
    result["preDockerTerminal"] = record
    result["preDockerManifestSha256"] = manifest


def verify_worker_hold(held):
    if "hold-terminal.json" in held:
        row = held["hold-terminal.json"]
        assert set(row) == {"phase", "rc", "cleanup", "cutoffMs", "utc"}
        assert isinstance(row["phase"], str) and re.fullmatch(r"[a-z-]+", row["phase"])
        assert type(row["rc"]) is int and 0 <= row["rc"] <= 255
        assert type(row["cleanup"]) is int and row["cleanup"] in (0, 1)
        assert type(row["cutoffMs"]) is int and row["cutoffMs"] > 0
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z", row["utc"])
    if "worker-diagnostic.json" in held:
        row = held["worker-diagnostic.json"]
        fields = {"schema", "unit", "observedUtc", "workerRc", "systemd", "cgroup",
                  "oomEvents", "journalEvents", "processes"}
        assert set(row) in (fields, fields | {"collectionError"})
        if "collectionError" in row:
            assert isinstance(row["collectionError"], str) and row["collectionError"]
        assert row["schema"] == "pirate.native-notes-worker-diagnostic/1"
        assert row["unit"] == "pirate-native-notes-worker.service"
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z", row["observedUtc"])
        assert type(row["workerRc"]) is int and 0 <= row["workerRc"] <= 255
        assert isinstance(row["systemd"], dict) and isinstance(row["cgroup"], dict)
        assert isinstance(row["oomEvents"], list) and isinstance(row["journalEvents"], list)
        assert isinstance(row["processes"], list)
        for event in row["oomEvents"]:
            assert set(event) == {"pid", "comm", "uid", "totalVmKb", "anonRssKb"}
            assert all(type(event[key]) is int for key in ("pid", "uid", "totalVmKb", "anonRssKb"))
            assert isinstance(event["comm"], str)
        for event in row["journalEvents"]:
            assert set(event) == {"pid", "executable", "message"}
            assert event["pid"] is None or type(event["pid"]) is int
            assert event["executable"] is None or isinstance(event["executable"], str)
            assert isinstance(event["message"], str)
        for process in row["processes"]:
            assert set(process) == {"pid", "ppid", "comm", "uid", "rssKb", "executable"}
            assert all(type(process[key]) is int for key in ("pid", "ppid", "uid", "rssKb"))
            assert isinstance(process["comm"], str) and isinstance(process["executable"], str)
    if "close-progress.json" in held:
        row = held["close-progress.json"]
        assert set(row) == {"schema", "logPresent", "closeEntered", "closeCompleted",
                            "lastMarker", "lastMarkerUtc", "markerCount", "parseError"}
        assert row["schema"] == "pirate.native-launcher-close-progress/1"
        assert type(row["logPresent"]) is bool and type(row["closeEntered"]) is bool
        assert type(row["closeCompleted"]) is bool
        assert type(row["markerCount"]) is int and 0 <= row["markerCount"] <= len(CLOSE_MARKERS)
        assert row["lastMarker"] is None or row["lastMarker"] in CLOSE_MARKERS
        assert (row["lastMarker"] is not None) == row["closeEntered"]
        assert row["closeCompleted"] == (row["lastMarker"] == "terminal-after")
        if row["closeEntered"]:
            assert row["logPresent"] and row["markerCount"] >= 1
            assert isinstance(row["lastMarkerUtc"], str) and UTC_STAMP.fullmatch(row["lastMarkerUtc"])
            assert row["lastMarkerUtc"].endswith("Z")
        else:
            assert row["lastMarkerUtc"] is None and row["markerCount"] == 0
        assert row["parseError"] is None or row["parseError"] in CLOSE_PARSE_ERRORS
    if "artifact-progress.json" in held:
        row = held["artifact-progress.json"]
        assert set(row) in ({"schema", "runId", "entries", "parseError"},
                            {"schema", "runId", "entries", "milestones", "parseError"})
        assert row["schema"] == "pirate.native-launcher-artifact-progress/1"
        assert row["runId"] is None or (isinstance(row["runId"], str) and RUN_ID.fullmatch(row["runId"]))
        assert set(row["entries"]) == set(ARTIFACT_NAMES)

        def validate_entry(entry):
            assert type(entry.get("present")) is bool
            if entry["present"]:
                assert set(entry) == {"present", "size", "mtimeUtc"}
                assert type(entry["size"]) is int and 0 < entry["size"] <= 1024 ** 2
                assert isinstance(entry["mtimeUtc"], str) and UTC_STAMP.fullmatch(entry["mtimeUtc"])
                assert entry["mtimeUtc"].endswith("Z")
            else:
                assert set(entry) == {"present"}

        for entry in row["entries"].values():
            validate_entry(entry)
        if "milestones" in row:
            assert set(row["milestones"]) == set(MILESTONE_FILES)
            for directory, names in MILESTONE_FILES.items():
                assert set(row["milestones"][directory]) == set(names)
                for entry in row["milestones"][directory].values():
                    validate_entry(entry)
        assert row["parseError"] is None or row["parseError"] in ARTIFACT_PARSE_ERRORS
        if row["parseError"] == "ambiguous-run-dir":
            assert row["runId"] is None
        if row["runId"] is None:
            assert all(not entry["present"] for entry in row["entries"].values())
            assert all(not entry["present"]
                       for group in row.get("milestones", {}).values() for entry in group.values())
    if "guest-memory.json" in held:
        row = held["guest-memory.json"]
        assert set(row) == {"schema", "meminfoKb", "vmstat", "parseError"}
        assert row["schema"] == "pirate.guest-memory-hold/1"
        assert set(row["meminfoKb"]) == set(MEMINFO_KEYS)
        assert set(row["vmstat"]) == set(VMSTAT_KEYS)
        for key, value in row["meminfoKb"].items():
            assert value is None or (type(value) is int and 0 <= value <= 2 ** 40)
        if row["meminfoKb"]["MemTotal"] is not None:
            assert 262144 <= row["meminfoKb"]["MemTotal"] <= 2 ** 40
        for key, value in row["vmstat"].items():
            assert value is None or (type(value) is int and 0 <= value <= 2 ** 63)
        assert row["parseError"] is None or row["parseError"] in MEMORY_PARSE_ERRORS
    if "native-progress.json" in held:
        validate_native_progress_receipt(held["native-progress.json"])
    if "native-memory.json" in held:
        validate_native_memory_receipt(held["native-memory.json"])
    if "install-server-refusal.json" in held:
        validate_install_server_refusal(held["install-server-refusal.json"])
        client = held.get("wizard-install-refusal.json")
        assert client and (client["stage"], client["responseStatus"]) == ("installation-prepare-response", 502)
    if "wizard-install-refusal.json" in held:
        row = held["wizard-install-refusal.json"]
        fields = {"stage", "errorClass", "responseStatus"}
        assert fields <= set(row) <= fields | {"responseCode", "captureSkip", "clientObservation", "requestCount"}
        assert "responseCode" not in row or "captureSkip" not in row
        assert row["stage"] in INSTALL_REFUSAL_STAGES and row["errorClass"] in INSTALL_REFUSAL_CLASSES
        status = row["responseStatus"]
        assert status is None or (
            row["stage"] in {"publishing-prepare-response", "installation-prepare-response"} | POST_PLAN_RESPONSE_STAGES
            and type(status) is int and 100 <= status <= 599
        )
        if "responseCode" in row or "captureSkip" in row:
            assert (row["stage"] == "publishing-prepare-response" and status == 503) or (
                row["stage"] == "installation-prepare-response" and type(status) is int and 400 <= status <= 599
            )
        if "responseCode" in row:
            allowed = PUBLISHING_PREPARE_CODES
            if row["stage"] == "installation-prepare-response":
                allowed = allowed | INSTALLATION_PREPARE_CODES
            assert row["responseCode"] in allowed
        if "captureSkip" in row:
            assert row["captureSkip"] in PUBLISHING_PREPARE_SKIPS
        validate_install_client_observation(row)
        validate_post_plan_action(row)
        assert "chain-init-refusal.json" not in held
        controller = held.get("controller-terminal.json")
        assert controller is None or (controller["phase"], controller["status"]) == ("install-original", "FAIL")
    if "chain-init-refusal.json" in held:
        row = held["chain-init-refusal.json"]
        assert set(row) == {"phase", "errorClass", "elapsedMs"} and row["phase"] == "fixture-chain-init"
        assert row["errorClass"] in CHAIN_INIT_CLASSES
        assert type(row["elapsedMs"]) is int and 0 <= row["elapsedMs"] <= 5400 * 1000
        assert "startup-progress.json" not in held
        controller = held.get("controller-terminal.json")
        assert controller is None or controller["phase"] == "local_startup" and controller["status"] == "FAIL"
    if "startup-progress.json" in held:
        progress = held["startup-progress.json"]
        assert set(progress) == {"phases"} and type(progress["phases"]) is list
        rows = progress["phases"]
        assert 0 < len(rows) <= len(STARTUP_PHASES)
        previous = ""
        for name, row in zip(STARTUP_PHASES, rows):
            assert set(row) == {"phase", "utc"} and row["phase"] == name
            assert UTC_STAMP.fullmatch(row["utc"]) and row["utc"].endswith("Z")
            assert previous <= row["utc"]
            previous = row["utc"]
    if "controller-terminal.json" in held:
        row = held["controller-terminal.json"]
        assert {"phase", "status", "endedUtc", "childExit"} <= set(row)
        assert set(row) <= {"phase", "status", "endedUtc", "childExit", "error"}
        assert row["phase"] in HOLD_PHASES and row["status"] in {"FAIL", "PASS"}
        assert UTC_STAMP.fullmatch(row["endedUtc"])
        child = row["childExit"]
        assert child is None or (type(child) is int and -255 <= child <= 255)
        assert "error" not in row or row["error"] in HOLD_ERRORS
    if "browser-egress.json" in held:
        row = held["browser-egress.json"]
        assert set(row) == {"browserClosed", "observedUtc"} and row["browserClosed"] is True
        assert UTC_STAMP.fullmatch(row["observedUtc"])


def assess(run, result):
    serial = (run / "SERIAL.log").read_text(errors="replace")
    terminal = TERMINAL.findall(serial)
    result["guestTerminal"] = terminal
    result["holdCodes"] = re.findall(r"^PIRATE_(?:SMOKE|NOTES)_HOLD_CODE ([a-z0-9-]+)$", serial, re.MULTILINE)
    result["qemuExit"] = (run / "QEMU-EXIT.txt").read_text().strip()
    result["qemuProcessAfterWait"] = (run / "QEMU-PROCESS.txt").read_text().strip()
    assert result["qemuProcessAfterWait"] == "absent"
    assert result["qemuExit"] == "0"
    identity = json.loads((run / "QEMU-IDENTITY.json").read_text())
    argv = identity["argv"]
    assert argv[argv.index("-nic") + 1] == argv[argv.index("-display") + 1] == "none"
    assert "-netdev" not in argv and "-virtfs" not in argv and "-device" in argv
    assert isinstance(identity["startTicks"], int) and identity["startTicks"] > 0
    overlay = run / "guest.qcow2"
    st = overlay.stat()
    assert identity["overlay"] == str(overlay.resolve(strict=True))
    assert identity["overlayDevice"] == st.st_dev and identity["overlayInode"] == st.st_ino
    assert identity["overlayReadbackSha256"] == hashlib.sha256((run / "OVERLAY.json").read_bytes()).hexdigest()
    returned = run / "guest-evidence.tar"
    export = EXPORT.findall(serial)
    early_terminal = bool(terminal) and terminal[0][0] in EARLY_HOLD_STAGES
    if returned.exists() and returned.stat().st_size and (not export or early_terminal):
        assess_early_hold(run, returned, terminal, result)
        with returned.open("rb") as archive:
            result["guestEvidenceArchiveSha256"] = hashlib.file_digest(archive, "sha256").hexdigest()
        if export:
            assert export == [(str(returned.stat().st_size), result["guestEvidenceArchiveSha256"])]
            assert re.findall(r"^([0-9a-f]{64})  RUN-SHA256SUMS$", serial, re.M) == [result["preDockerManifestSha256"]]
        return
    assert len(terminal) == 1
    stage, rc, cleanup, cutoff, utc = terminal[0]
    assert cutoff == (run / "WORKER-CUTOFF-MS.txt").read_text().strip()
    elapsed_close = datetime.fromisoformat(utc[:26] + "+00:00").timestamp()
    assert elapsed_close < int((run / "DISPATCH-EXPIRY-EPOCH.txt").read_text())
    assert cleanup in {"0", "1"}
    if cleanup == "0":
        assert "PIRATE_SMOKE_PROCESSES_OR_LISTENER absent" in serial
        result["independentClosure"] = True

    if returned.exists() and returned.stat().st_size:
        with returned.open("rb") as archive:
            result["guestEvidenceArchiveSha256"] = hashlib.file_digest(archive, "sha256").hexdigest()
        assert export == [(str(returned.stat().st_size), result["guestEvidenceArchiveSha256"])]
    if stage != "evidence-sent" or rc != "0" or cleanup != "0":
        if returned.exists() and returned.stat().st_size:
            held, _pins, manifest = receipt_set(returned, HOLD, set())
            assert re.findall(r"^([0-9a-f]{64})  RUN-SHA256SUMS$", serial, re.M) == [manifest]
            verify_worker_hold(held)
            result["holdTerminal"] = held.get("hold-terminal.json")
            result["workerDiagnostic"] = held.get("worker-diagnostic.json")
            result["controllerEvidence"] = held.get("controller-terminal.json")
            result["startupProgress"] = held.get("startup-progress.json")
            result["closeProgress"] = held.get("close-progress.json")
            result["artifactProgress"] = held.get("artifact-progress.json")
            result["guestMemory"] = held.get("guest-memory.json")
            result["nativeProgress"] = held.get("native-progress.json")
            result["nativeMemory"] = held.get("native-memory.json")
            if "chain-init-refusal.json" in held:
                result["chainInitRefusal"] = held["chain-init-refusal.json"]
            if "wizard-install-refusal.json" in held:
                result["wizardInstallRefusal"] = held["wizard-install-refusal.json"]
            if "install-server-refusal.json" in held:
                result["installServerRefusal"] = held["install-server-refusal.json"]
        return
    for unit in ("docker.socket", "docker.service", "containerd.service"):
        assert f"PIRATE_SMOKE_UNIT {unit} inactive" in serial
    info, pins, manifest = receipt_set(returned, SUCCESS | SUCCESS_OPTIONAL, SUCCESS)
    if "native-progress.json" in info:
        validate_native_progress_receipt(info["native-progress.json"])
    if "native-memory.json" in info:
        validate_native_memory_receipt(info["native-memory.json"])
    assert re.findall(r"^([0-9a-f]{64})  RUN-SHA256SUMS$", serial, re.M) == [manifest]
    assert re.findall(r"^PIRATE_SMOKE_SOCKET_SHA256 ([0-9a-f]{64})$", serial, re.M) == [pins["socket.json"]]
    assert re.findall(r"^PIRATE_SMOKE_ISOLATION ([0-9a-f]{64})$", serial, re.M) == [pins["isolation.json"]]
    assert pins["socket.json"] == pins["socket-image.json"] == pins["socket-terminal.json"]
    phases = re.findall(r"^PIRATE_SMOKE_BINDING phase=([a-z-]+) result=([a-z]+)$", serial, flags=re.M)
    assert phases == [
        ("daemon-start", "captured"), ("image-loaded", "captured"), ("image-loaded", "matched"),
        ("worker-stopped", "captured"), ("worker-stopped", "matched"),
    ]
    assert (serial.index("PIRATE_SMOKE_BINDING phase=image-loaded result=matched") <
            serial.index("PIRATE_SMOKE_WORKER_START ") <
            serial.index("PIRATE_SMOKE_BINDING phase=worker-stopped result=captured"))
    assert info["release-image.json"]["imageId"] == IMAGE
    start = info["initial-unpaired.json"]
    assert start["pairingPage"] == 200 and start["unpairedState"] == 403
    assert [start[key] for key in ("paired", "enrollmentEffects", "registrationEffects", "broadcasts")] == [0, 0, 0, 0]
    assert type(start["fixtureSetupBroadcasts"]) is int and start["fixtureSetupBroadcasts"] == 1
    assert isinstance(start["fixtureSetupRpcSha256"], str) and re.fullmatch(r"0x[0-9a-f]{64}", start["fixtureSetupRpcSha256"])
    resources = info["resources.json"]
    assert resources["imageId"] == IMAGE and resources["sameStore"] and resources["sameGrant"]
    assert resources["newEffectsOnReplay"] == 0
    assert set(row["role"] for row in resources["applicationAndPeerClosed"]) == {"application", "fixture-transport"}
    assert all(row["exitCode"] == 0 and row["state"] == "exited" for row in resources["applicationAndPeerClosed"])
    before, after = info["notes-before.json"], info["notes-after.json"]
    assert before["proof"] == after["proof"] and before["playback"]["wire"] == after["playback"]["wire"]
    for receipt in (before, after):
        assert receipt["playback"]["wire"]["range"] == 206 and receipt["playback"]["analysis"]["ok"] is True
    assert before["counts"]["seal"] == 1 and after["counts"]["seal"] == 0
    binding = info["binding-before.json"]["identity"]
    assert binding == info["binding-after.json"]["identity"]
    assert info["isolation.json"]["daemonId"] == info["socket.json"]["daemonId"]
    assert info["isolation.json"]["networkNamespace"] == info["socket.json"]["networkNamespace"]
    assert info["isolation.json"]["machineIdSha256"] == info["socket.json"]["machineIdSha256"]
    assert info["browser-egress.json"]["browserClosed"] is True
    result.update(result="pass", imageId=IMAGE, installationId=resources["installationId"],
                  grantId=binding["grantId"], attachmentDigest=binding["attachmentDigest"],
                  postId=before["proof"]["postId"], sameStore=True, oldAndNewBrowserDecoded=True,
                  newEffectsOnReplay=0)


if __name__ == "__main__":
    result = {"result": "held", "independentClosure": False}
    try:
        assess(Path(sys.argv[1]), result)
    except (AssertionError, OSError, KeyError, ValueError, TypeError, tarfile.TarError) as error:
        result["verifyError"] = type(error).__name__
        result["verifyMessage"] = str(error) or "evidence verification assertion failed"
    print(json.dumps(result, indent=2, sort_keys=True))
    raise SystemExit(result["result"] != "pass")
