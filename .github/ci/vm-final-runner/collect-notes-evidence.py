"""Return only scoped Notes receipts from the closed disposable guest."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess


ROOT = Path("/opt/pw2-rehearsal")
RECEIPTS = {
    "release-image.json": "rehearsal-release-image.json",
    "restart-before.json": "rehearsal-restart-original.json",
    "restart-terminal.json": "rehearsal-restart-terminal.json",
    "restart-after.json": "rehearsal-restart-new-boot.json",
    "initial-unpaired.json": "notes-initial-unpaired.json",
    "wizard-held.json": "w6-wizard-hold-registration.json",
    "wizard-funded.json": "w6-wizard-fund-original.json",
    "wizard-installed.json": "w6-wizard-install-original.json",
    "wizard-reopened.json": "reopened/w6-wizard-retained-repair.json",
    "reopened-original.json": "rehearsal-reopened-original.json",
    "replay.json": "rehearsal-notes-replay.json",
    "launcher-terminal.json": "terminal.json",
    "notes-before.json": "application-before/w6-native-notes-before.json",
    "binding-before.json": "application-before/w6-native-notes-binding.json",
    "notes-after.json": "reopened/application-after/w6-native-notes-after.json",
    "binding-after.json": "reopened/application-after/w6-native-notes-binding.json",
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
CLOSE_LINE = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) ([a-z-]+)$")
CLOSE_PARSE_ERRORS = {"malformed-line", "unreadable", "oversized"}
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
STATIC_RECEIPTS = {
    "controller-terminal.json": "notes-controller-terminal.json",
    "browser-egress.json": "notes-browser-egress.json",
}


INSTALL_SERVER_BOUNDARIES = {
    "http-before-setup", "wizard-before-install-port", "installed-prepare-before-release-sign",
    "installed-prepare-release-sign", "installed-prepare-application-release-sign",
    "installed-prepare-admission-sign", "installed-prepare-after-admission-sign",
    "installed-prepare-profile-sign", "installed-prepare-after-profile-sign",
    "wizard-after-install-port",
    "install-before-apply", "install-apply", "install-after-apply",
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
    "apply-ingress-custody",
    "apply-start-intent",
    "apply-start-effect",
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


def validate_install_server_container(row):
    if "container" not in row:
        return
    container = row["container"]
    assert isinstance(container, dict)
    if container.get("present") is False:
        assert set(container) == {"present"}
        return
    assert set(container) == {"present", "running", "exitCode", "oomKilled"}
    assert container["present"] is True
    assert type(container["running"]) is bool and type(container["oomKilled"]) is bool
    assert type(container["exitCode"]) is int and 0 <= container["exitCode"] <= 255


def validate_service_child_exit(row):
    assert isinstance(row, dict) and set(row) == {"phase", "spawnedUtc", "exitUtc", "elapsedMs",
                                                  "exitCode", "signalCode", "pairCodeObserved"}
    assert row["phase"] in {"initial", "restart"}
    assert UTC_STAMP.fullmatch(row["spawnedUtc"]) and UTC_STAMP.fullmatch(row["exitUtc"])
    assert row["spawnedUtc"] <= row["exitUtc"]
    assert type(row["elapsedMs"]) is int and 0 <= row["elapsedMs"] <= 5400 * 1000
    assert row["exitCode"] is None or (type(row["exitCode"]) is int and 0 <= row["exitCode"] <= 255)
    assert row["signalCode"] is None or (
        type(row["signalCode"]) is str and re.fullmatch(r"SIG[A-Z0-9]{1,10}", row["signalCode"]))
    assert (row["exitCode"] is None) != (row["signalCode"] is None)
    assert type(row["pairCodeObserved"]) is bool


LAUNCHER_INTERRUPTION_REASONS = {
    "owned installed service exited before pairing",
    "bounded_native25_wait_expired",
    "owned_service_launch_error",
    "owned_service_log_bound",
    "owned_service_shutdown_uncertain",
    "root_native25_cancelled",
    "root_native32_diagnostic_cancel",
    "native25_3600_second_deadline",
    "unclassified-private-error",
}


def validate_launcher_interruption(row):
    assert isinstance(row, dict) and set(row) == {"at", "reason"}
    assert UTC_STAMP.fullmatch(row["at"])
    assert type(row["reason"]) is str and row["reason"] in LAUNCHER_INTERRUPTION_REASONS


APPLY_ASSERTION_CODES = {
    "original_start_effect_uncertain", "original_start_intent_changed", "native_expanded_publication_selection_changed",
}


APPLY_OBSERVATION_OPERATIONS = {
    "load-original", "reauthorize", "read-start-intent", "retain-launch", "retain-start-intent",
    "authorize", "create", "inspect", "retain-ingress", "start", "ingress-wait", "public-ingress-start",
}


def validate_apply_observation(row):
    assert isinstance(row, dict) and set(row) == {"observations"}
    entries = row["observations"]
    assert isinstance(entries, list) and 1 <= len(entries) <= 128
    for entry in entries:
        assert isinstance(entry, dict)
        base = {"event", "operation", "phase", "at"}
        assert base <= set(entry)
        assert entry["event"] == "web2-install-apply-observation"
        assert entry["operation"] in APPLY_OBSERVATION_OPERATIONS
        assert entry["phase"] in {"enter", "complete", "throw"}
        assert type(entry["at"]) is int and 0 <= entry["at"] <= 2 ** 53
        if entry["phase"] == "enter":
            assert set(entry) == base
            continue
        elapsed = entry.get("elapsedMs")
        assert type(elapsed) is int and 0 <= elapsed <= 1800000
        extras = {"elapsedMs"}
        if entry["operation"] == "start":
            assert type(entry.get("signalAborted")) is bool
            extras.add("signalAborted")
        else:
            assert "signalAborted" not in entry
        if entry["phase"] == "throw":
            assert entry.get("errorClass") in INSTALL_SERVER_CLASSES
            extras.add("errorClass")
            if "message" in entry:
                assert entry["errorClass"] == "AssertionError" and entry["message"] in APPLY_ASSERTION_CODES
                extras.add("message")
        assert set(entry) == base | extras


PUBLICATION_FAILURE_PHASES = {
    "bootstrap",
    "baseline", "composer", "single_seal", "wait_for_same_published_original",
    "play_before_ordinary_restart", "public_read_only_replay",
}
PUBLICATION_LITERAL_REASONS = {
    "original_seal_not_accepted",
    "no_publication_window_before_restart_reserve",
    "insufficient_remaining_window_before_seal",
    "decoded_capture_before_restart_failed",
    "decoded_capture_after_restart_failed",
}
PUBLICATION_FAILURE_CATEGORIES = PUBLICATION_LITERAL_REASONS | {
    "unexpected-public-proof", "original-publication-unconfirmed", "unclassified-private-error",
}
PUBLICATION_EMBEDDED_STATUS = {
    "unexpected_public_proof": "unexpected-public-proof",
    "one_original_publication_unconfirmed": "original-publication-unconfirmed",
}


def validate_publication_failure(row):
    assert isinstance(row, dict) and set(row) == {"phase", "sealAcceptedAndIdentified", "failure"}
    assert row["phase"] in PUBLICATION_FAILURE_PHASES
    assert type(row["sealAcceptedAndIdentified"]) is bool
    failure = row["failure"]
    assert isinstance(failure, dict) and set(failure) <= {"category", "status"} and "category" in failure
    assert failure["category"] in PUBLICATION_FAILURE_CATEGORIES
    if "status" in failure:
        assert type(failure["status"]) is int and 100 <= failure["status"] <= 599
        assert failure["category"] in {"unexpected-public-proof", "original-publication-unconfirmed"}
    else:
        assert failure["category"] not in {"unexpected-public-proof", "original-publication-unconfirmed"}


def project_publication_failure(record):
    # Projects bounded evidence from the browser helper's private failure record.
    # The record's error text is arbitrary and stays private; only the allowlisted
    # category, an embedded three-digit proof status, the controlled phase and the
    # seal fact cross the boundary.
    assert isinstance(record, dict)
    phase = record.get("phase")
    assert phase in PUBLICATION_FAILURE_PHASES
    original = record.get("original")
    seal = (
        isinstance(original, dict)
        and isinstance(original.get("postId"), str) and re.fullmatch(r"0x[0-9a-f]{64}", original["postId"])
        and isinstance(original.get("submissionId"), str) and re.fullmatch(r"[a-f0-9-]{36}", original["submissionId"])
        and original.get("jobId") == "publication:" + original["submissionId"]
        and isinstance(original.get("sealUtc"), str) and UTC_STAMP.fullmatch(original["sealUtc"])
    )
    error = record.get("error")
    message = ""
    if isinstance(error, dict) and type(error.get("message")) is str and len(error["message"]) <= 1024:
        message = error["message"]
    category = "unclassified-private-error"
    status = None
    embedded = re.fullmatch(r"(unexpected_public_proof|one_original_publication_unconfirmed)_http_(\d{3})", message)
    if embedded:
        category = PUBLICATION_EMBEDDED_STATUS[embedded[1]]
        status = int(embedded[2])
    elif message in PUBLICATION_LITERAL_REASONS:
        category = message
    failure = {"category": category}
    if status is not None:
        failure["status"] = status
    row = {"phase": phase, "sealAcceptedAndIdentified": bool(seal), "failure": failure}
    validate_publication_failure(row)
    return row


def publication_failure_files(root=ROOT, owner=1000):
    artifact_root = root / "artifacts"
    if not artifact_root.is_dir() or artifact_root.resolve(strict=True) != artifact_root:
        return []
    if artifact_root.stat().st_uid != owner:
        return []
    try:
        runs = sorted(
            item.name for item in artifact_root.iterdir()
            if RUN_DIR.fullmatch(item.name) and item.is_dir() and not item.is_symlink()
        )
    except OSError:
        return []
    if len(runs) != 1:
        return []
    directory = artifact_root / runs[0]
    found = []
    for relative, output in (
        ("application-before/w6-native-notes-before-failed.json", "publication-failure-before.json"),
        ("reopened/application-after/w6-native-notes-after-failed.json", "publication-failure-after.json"),
    ):
        file = directory / relative
        if file.is_file() and not file.is_symlink():
            found.append((file, output))
    return found


def validate_install_server_refusal(row):
    base = {"boundary", "errorClass", "message", "responseStatus", "throwSite"}
    assert isinstance(row, dict) and base <= set(row) <= base | {"container"}
    assert row["boundary"] in INSTALL_SERVER_BOUNDARIES and row["errorClass"] in INSTALL_SERVER_CLASSES
    assert type(row["responseStatus"]) is int and row["responseStatus"] == 502
    assert row["throwSite"] in INSTALL_SERVER_THROW_SITES
    assert row["throwSite"] == "unknown" or row["errorClass"] == "AssertionError"
    assert type(row["message"]) is str and (
        re.fullmatch(r"[a-z0-9_]{1,80}", row["message"]) or row["message"] == "unclassified-private-error")
    if row["boundary"] == "http-before-setup":
        assert row["errorClass"] == "Other"
    validate_install_server_container(row)


def private_json(file):
    info = file.lstat()
    assert file.resolve(strict=True) == file and stat.S_ISREG(info.st_mode)
    assert info.st_uid == 1000 and info.st_nlink == 1 and info.st_mode & 0o077 == 0
    assert 0 < info.st_size <= 1024 ** 2
    data = file.read_bytes()
    return data, json.loads(data)


def read_bounded_install_refusal(path):
    cap = 512
    controls = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

    def identity(info):
        assert stat.S_ISREG(info.st_mode) and info.st_uid == 1000 and info.st_nlink == 1
        assert info.st_mode & 0o077 == 0 and 0 < info.st_size <= cap
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    directory = os.open(path.parent, controls | os.O_DIRECTORY)
    try:
        before = identity(os.stat(path.name, dir_fd=directory, follow_symlinks=False))
        fd = os.open(path.name, controls, dir_fd=directory)
        try:
            opened = os.fstat(fd)
            assert identity(opened) == before
            data = os.read(fd, cap + 1)
            assert 0 < len(data) <= cap and len(data) == opened.st_size
            assert identity(os.fstat(fd)) == before
            assert identity(os.stat(path.name, dir_fd=directory, follow_symlinks=False)) == before
        finally:
            os.close(fd)
    finally:
        os.close(directory)
    return json.loads(data)


def write_json(path, value):
    with path.open("x") as file:
        json.dump(value, file, sort_keys=True)
        file.write("\n")


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
RUN_DIR = re.compile(r"manual-[a-f0-9]{12}\Z")
MEMORY_PARSE_ERRORS = {"unreadable"}
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


def stamp_utc(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"


def read_artifact_progress(root=ROOT, owner=1000):
    progress = {
        "schema": "pirate.native-launcher-artifact-progress/1",
        "runId": None,
        "entries": {name: {"present": False} for name in ARTIFACT_NAMES},
        "milestones": {
            directory: {name: {"present": False} for name in names}
            for directory, names in MILESTONE_FILES.items()
        },
        "parseError": None,
    }
    try:
        artifact_root = root / "artifacts"
        if not artifact_root.is_dir():
            return progress
        assert artifact_root.resolve(strict=True) == artifact_root
        assert artifact_root.stat().st_uid == owner
        runs = sorted(
            item.name for item in artifact_root.iterdir()
            if RUN_DIR.fullmatch(item.name) and item.is_dir() and not item.is_symlink()
        )
    except (AssertionError, OSError):
        progress["parseError"] = "artifacts-unreadable"
        return progress
    if not runs:
        return progress
    if len(runs) != 1:
        progress["parseError"] = "ambiguous-run-dir"
        return progress
    progress["runId"] = runs[0]
    directory = artifact_root / runs[0]

    def scan(file):
        try:
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode) or file.resolve(strict=True) != file:
                return None
            if info.st_uid != owner or info.st_nlink != 1 or info.st_mode & 0o077:
                return None
            return {
                "present": True,
                "size": info.st_size,
                "mtimeUtc": stamp_utc(info.st_mtime),
            }
        except OSError:
            return None

    for name in ARTIFACT_NAMES:
        row = scan(directory / name)
        if row is not None:
            progress["entries"][name] = row
    for subdirectory, names in MILESTONE_FILES.items():
        for name in names:
            row = scan(directory / subdirectory / name)
            if row is not None:
                progress["milestones"][subdirectory][name] = row
    return progress


MEMINFO_KEYS = ("MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SwapTotal", "SwapFree", "Committed_AS")
VMSTAT_KEYS = ("pswpin", "pswpout", "oom_kill")


def read_guest_memory(meminfo=Path("/proc/meminfo"), vmstat=Path("/proc/vmstat")):
    receipt = {
        "schema": "pirate.guest-memory-hold/1",
        "meminfoKb": {key: None for key in MEMINFO_KEYS},
        "vmstat": {key: None for key in VMSTAT_KEYS},
        "parseError": None,
    }
    try:
        for line in meminfo.read_text().splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].rstrip(":") in MEMINFO_KEYS and parts[1].isdigit():
                receipt["meminfoKb"][parts[0].rstrip(":")] = int(parts[1])
        for line in vmstat.read_text().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0] in VMSTAT_KEYS and parts[1].isdigit():
                receipt["vmstat"][parts[0]] = int(parts[1])
    except OSError:
        receipt["parseError"] = "unreadable"
    if receipt["meminfoKb"]["MemTotal"] is None:
        receipt["parseError"] = "unreadable"
    return receipt


def read_close_progress(path=ROOT / "logs" / "close.stderr.log", owner=1000):
    progress = {
        "schema": "pirate.native-launcher-close-progress/1",
        "logPresent": False,
        "closeEntered": False,
        "closeCompleted": False,
        "lastMarker": None,
        "lastMarkerUtc": None,
        "markerCount": 0,
        "parseError": None,
    }
    try:
        info = path.lstat()
    except OSError:
        return progress
    try:
        assert stat.S_ISREG(info.st_mode) and path.resolve(strict=True) == path
        assert info.st_uid == owner and info.st_nlink == 1 and info.st_mode & 0o077 == 0
        progress["logPresent"] = True
        if info.st_size > 64 * 1024:
            progress["parseError"] = "oversized"
            return progress
        data = path.read_bytes()
    except (AssertionError, OSError):
        progress["parseError"] = "unreadable"
        return progress
    markers = []
    malformed = False
    position = -1
    for line in data.decode("utf-8", "replace").splitlines():
        match = CLOSE_LINE.fullmatch(line)
        index = CLOSE_MARKERS.index(match.group(2)) if match and match.group(2) in CLOSE_MARKERS else -1
        if index <= position:
            malformed = True
            break
        position = index
        markers.append((match.group(1), match.group(2)))
    if malformed:
        progress["parseError"] = "malformed-line"
    if markers:
        progress["closeEntered"] = True
        progress["markerCount"] = len(markers)
        progress["lastMarkerUtc"], progress["lastMarker"] = markers[-1]
        progress["closeCompleted"] = progress["lastMarker"] == "terminal-after"
    return progress


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


def read_native_progress(path=ROOT / "logs" / "native-progress.ndjson", owner=1000):
    receipt = {
        "schema": "pirate.native-launcher-progress/1",
        "logPresent": False,
        "rows": [],
        "rowCount": 0,
        "finalRow": None,
        "openOps": [],
        "parseError": None,
    }
    try:
        info = path.lstat()
    except OSError:
        return receipt
    try:
        assert stat.S_ISREG(info.st_mode) and path.resolve(strict=True) == path
        assert info.st_uid == owner and info.st_nlink == 1 and info.st_mode & 0o077 == 0
        receipt["logPresent"] = True
        if info.st_size > 256 * 1024:
            receipt["parseError"] = "oversized"
            return receipt
        data = path.read_bytes()
    except (AssertionError, OSError):
        receipt["parseError"] = "unreadable"
        return receipt
    rows = []
    malformed = False
    for line in data.decode("utf-8", "replace").splitlines():
        try:
            row = json.loads(line)
            assert type(row) is dict and type(row.get("at")) is str and UTC_STAMP.fullmatch(row["at"])
            if row.get("kind") == "op":
                assert set(row) == {"at", "kind", "op", "event"}
                assert row["op"] in PROGRESS_OPS and row["event"] in {"enter", "return"}
            elif row.get("kind") == "role":
                assert set(row) == {"at", "kind", "role", "pid", "ppid", "startTicks", "comm"}
                assert row["role"] in PROGRESS_ROLES
                assert type(row["pid"]) is int and type(row["ppid"]) is int and row["pid"] > 0 and row["ppid"] > 0
                assert type(row["startTicks"]) is str and re.fullmatch(r"[0-9]+", row["startTicks"])
                assert type(row["comm"]) is str and 0 < len(row["comm"]) <= 64 and row["comm"].isprintable()
            else:
                raise AssertionError
        except (AssertionError, ValueError, TypeError):
            malformed = True
            break
        rows.append(row)
        if len(rows) > 4096:
            malformed = True
            break
    if malformed:
        receipt["parseError"] = "malformed-line"
    receipt["rows"] = rows
    receipt["rowCount"] = len(rows)
    if rows:
        receipt["finalRow"] = rows[-1]
    open_ops = []
    counts = {}
    for row in rows:
        if row["kind"] != "op":
            continue
        counts[row["op"]] = counts.get(row["op"], 0) + (1 if row["event"] == "enter" else -1)
    open_ops = sorted(op for op, count in counts.items() if count > 0)
    receipt["openOps"] = open_ops
    return receipt


NATIVE_MEMORY_BASE_KEYS = {"at", "kind", "launcherRssKb", "servicePid", "serviceRssKb", "memAvailableKb", "uidRssKb"}
NATIVE_MEMORY_HEAP_KEYS = {"heapUsedKb", "heapTotalKb", "externalKb", "arrayBuffersKb", "largeObjectKb", "smapsAnonKb", "smapsFileKb", "smapsSharedKb", "transferCount", "transferBytes", "transferPeakBytes", "transferPeakPath", "topRss"}


def validate_native_memory_sample(row):
    if set(row) == NATIVE_MEMORY_BASE_KEYS:
        extended = False
    elif set(row) == NATIVE_MEMORY_BASE_KEYS | NATIVE_MEMORY_HEAP_KEYS:
        extended = True
    else:
        return False
    if row.get("kind") != "sample":
        return False
    if type(row["at"]) is not str or not UTC_STAMP.fullmatch(row["at"]):
        return False
    numeric_keys = ["launcherRssKb", "serviceRssKb", "memAvailableKb", "uidRssKb"]
    if extended:
        numeric_keys += ["heapUsedKb", "heapTotalKb", "externalKb", "arrayBuffersKb", "largeObjectKb", "smapsAnonKb", "smapsFileKb", "smapsSharedKb", "transferCount", "transferBytes", "transferPeakBytes"]
    for key in numeric_keys:
        if row[key] is not None and not (type(row[key]) is int and 0 <= row[key] < 2 ** 40):
            return False
    if row["servicePid"] is not None and not (type(row["servicePid"]) is int and row["servicePid"] > 0):
        return False
    if extended:
        peak_path = row["transferPeakPath"]
        if peak_path is not None and not (type(peak_path) is str and len(peak_path) <= 48):
            return False
        top = row["topRss"]
        if type(top) is not list or len(top) > 5:
            return False
        for entry in top:
            if type(entry) is not dict or set(entry) != {"pid", "comm", "rssKb"}:
                return False
            if type(entry["pid"]) is not int or entry["pid"] <= 0:
                return False
            if type(entry["comm"]) is not str or not 0 < len(entry["comm"]) <= 64:
                return False
            if type(entry["rssKb"]) is not int or not 0 <= entry["rssKb"] < 2 ** 40:
                return False
    return True


def read_native_memory(path=ROOT / "logs" / "native-memory.ndjson", owner=1000):
    receipt = {
        "schema": "pirate.native-memory-samples/1",
        "logPresent": False,
        "samples": [],
        "sampleCount": 0,
        "finalSample": None,
        "peakLauncherRssKb": None,
        "peakServiceRssKb": None,
        "peakUidRssKb": None,
        "minMemAvailableKb": None,
        "parseError": None,
    }
    try:
        info = path.lstat()
    except OSError:
        return receipt
    try:
        assert stat.S_ISREG(info.st_mode) and path.resolve(strict=True) == path
        assert info.st_uid == owner and info.st_nlink == 1 and info.st_mode & 0o077 == 0
        receipt["logPresent"] = True
        if info.st_size > 1024 * 1024:
            receipt["parseError"] = "oversized"
            return receipt
        data = path.read_bytes()
    except (AssertionError, OSError):
        receipt["parseError"] = "unreadable"
        return receipt
    samples = []
    malformed = False
    for line in data.decode("utf-8", "replace").splitlines():
        try:
            row = json.loads(line)
            assert type(row) is dict and row.get("kind") == "sample"
            assert validate_native_memory_sample(row)
        except (AssertionError, ValueError, TypeError):
            malformed = True
            break
        samples.append(row)
        if len(samples) > 2048:
            malformed = True
            break
    if malformed:
        receipt["parseError"] = "malformed-line"
    receipt["samples"] = samples
    receipt["sampleCount"] = len(samples)
    if samples:
        receipt["finalSample"] = samples[-1]
        def peak(key):
            values = [row[key] for row in samples if row[key] is not None]
            return max(values) if values else None
        receipt["peakLauncherRssKb"] = peak("launcherRssKb")
        receipt["peakServiceRssKb"] = peak("serviceRssKb")
        receipt["peakUidRssKb"] = peak("uidRssKb")
        available = [row["memAvailableKb"] for row in samples if row["memAvailableKb"] is not None]
        receipt["minMemAvailableKb"] = min(available) if available else None
    return receipt


def inspect_resource(config, resource):
    raw = subprocess.check_output(
        ["/usr/bin/docker", "--host", "unix:///run/docker.sock", "--config", str(config), "inspect", resource],
        timeout=15,
    )
    rows = json.loads(raw)
    assert len(rows) == 1 and rows[0]["Id"] == resource
    return rows[0]


def collect_success(session, image, cutoff):
    _raw, original = private_json(ROOT / "manual-run-original.json")
    run_id = original["runId"]
    assert re.fullmatch("manual-[0-9a-f]{12}", run_id)
    assert original["installationId"] == "rehearsal-" + run_id
    artifacts = ROOT / "artifacts" / run_id
    assert str(artifacts) == original["artifacts"]
    values = {}
    for output, source in (RECEIPTS | STATIC_RECEIPTS).items():
        source_root = artifacts if output in RECEIPTS else ROOT
        raw, values[output] = private_json(source_root / source)
        with (session / output).open("xb") as file:
            file.write(raw)
    write_json(session / "native-progress.json", read_native_progress())
    write_json(session / "native-memory.json", read_native_memory())
    before = values["restart-before.json"]
    stopped = values["restart-terminal.json"]
    after = values["restart-after.json"]
    replay = values["replay.json"]
    terminal = values["launcher-terminal.json"]
    assert before["before"]["fixed"] == after["after"]["fixed"]
    assert before["before"]["transport"] == after["after"]["transport"]
    assert before["authority"] == after["authority"] == replay["authority"]
    assert before["notesBefore"] == replay["notesAfter"]
    assert before["process"]["hostStartTicks"] != after["process"]["hostStartTicks"]
    assert before["before"]["startedAt"] != after["after"]["startedAt"]
    assert stopped["service"] == before["process"] and stopped["serviceProcessAbsent"] is True
    assert stopped["serviceExitCode"] == 0 and stopped["serviceSignalCode"] is None
    old_app = stopped["application"]
    assert old_app["id"] == before["before"]["fixed"]["appId"] and old_app["imageId"] == image
    assert old_app["exitCode"] == 0 and old_app["running"] is False and old_app["oomKilled"] is False
    assert terminal["observedCleanupErrors"] == [] and terminal["stateRetained"] is True
    before_app = before["before"]["fixed"]
    assert before_app["appId"] == terminal["appId"] and before_app["imageId"] == terminal["imageId"] == image
    assert values["binding-after.json"]["identity"] == values["binding-before.json"]["identity"]
    assert values["browser-egress.json"]["browserClosed"] is True
    controller = values["controller-terminal.json"]
    assert controller["status"] == "PASS" and controller["childExit"] == 0
    assert len(controller["cdp"]) == 4 and all("closedUtc" in item for item in controller["cdp"].values())

    config = session / "docker"
    closed = []
    for label, field in (("application", "appId"), ("fixture-transport", "sidecarId")):
        resource = terminal[field]
        assert re.fullmatch("[a-f0-9]{64}", resource)
        item = inspect_resource(config, resource)
        state = item["State"]
        assert item["Image"] == image and state["Running"] is False and state["Pid"] == 0
        assert state["OOMKilled"] is False and state["ExitCode"] == 0
        closed.append({"role": label, "id": resource, "image": image, "state": state["Status"],
                       "exitCode": state["ExitCode"], "finishedAt": state["FinishedAt"]})
    write_json(session / "resources.json", {
        "imageId": image, "installationId": original["installationId"], "applicationAndPeerClosed": closed,
        "runtimeCutoffMs": cutoff, "sameStore": True, "sameGrant": True, "newEffectsOnReplay": 0,
    })


def collect_hold(session):
    write_json(session / "close-progress.json", read_close_progress())
    write_json(session / "artifact-progress.json", read_artifact_progress())
    write_json(session / "guest-memory.json", read_guest_memory())
    write_json(session / "native-progress.json", read_native_progress())
    write_json(session / "native-memory.json", read_native_memory())
    phases = []
    for name in STARTUP_PHASES:
        file = ROOT / f"notes-startup-{name}.json"
        if not file.is_file():
            break
        try:
            _raw, row = private_json(file)
            assert set(row) == {"phase", "utc"} and row["phase"] == name
            assert UTC_STAMP.fullmatch(row["utc"]) and row["utc"].endswith("Z")
            assert not phases or phases[-1]["utc"] <= row["utc"]
        except (AssertionError, OSError, TypeError, ValueError):
            break
        phases.append({"phase": name, "utc": row["utc"]})
    if phases:
        write_json(session / "startup-progress.json", {"phases": phases})

    chain_init = ROOT / "notes-chain-init-refusal.json"
    if not phases and chain_init.is_file():
        try:
            _raw, row = private_json(chain_init)
            assert set(row) == {"phase", "errorClass", "elapsedMs"} and row["phase"] == "fixture-chain-init"
            assert row["errorClass"] in CHAIN_INIT_CLASSES
            assert type(row["elapsedMs"]) is int and 0 <= row["elapsedMs"] <= 5400 * 1000
        except (AssertionError, OSError, TypeError, ValueError):
            pass
        else:
            write_json(session / "chain-init-refusal.json", row)

    install_refusal = ROOT / "notes-wizard-install-refusal.json"
    if install_refusal.is_file():
        try:
            row = read_bounded_install_refusal(install_refusal)
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
        except (AssertionError, OSError, TypeError, ValueError):
            pass
        else:
            write_json(session / "wizard-install-refusal.json", row)
            server = ROOT / "notes-install-server-refusal.json"
            if (row["stage"], row["responseStatus"]) in {("installation-prepare-response", 502), ("install-response", 502)}:
                try:
                    evidence = read_bounded_install_refusal(server)
                    validate_install_server_refusal(evidence)
                except (AssertionError, OSError, TypeError, ValueError):
                    pass
                else:
                    write_json(session / "install-server-refusal.json", evidence)

    for child_phase in ("initial", "restart"):
        child_exit = ROOT / f"notes-service-child-exit-{child_phase}.json"
        if not child_exit.is_file():
            continue
        try:
            _raw, row = private_json(child_exit)
            validate_service_child_exit(row)
            assert row["phase"] == child_phase
        except (AssertionError, OSError, TypeError, ValueError):
            continue
        write_json(session / f"service-child-exit-{child_phase}.json", row)

    interruption = ROOT / "notes-launcher-interruption.json"
    if interruption.is_file():
        try:
            _raw, row = private_json(interruption)
            validate_launcher_interruption(row)
        except (AssertionError, OSError, TypeError, ValueError):
            pass
        else:
            write_json(session / "launcher-interruption.json", row)

    for failure_file, output in publication_failure_files():
        try:
            _raw, record = private_json(failure_file)
            row = project_publication_failure(record)
        except (AssertionError, OSError, TypeError, ValueError):
            continue
        write_json(session / output, row)

    apply_observation = ROOT / "notes-apply-observation.json"
    if apply_observation.is_file():
        try:
            _raw, row = private_json(apply_observation)
            validate_apply_observation(row)
        except (AssertionError, OSError, TypeError, ValueError):
            pass
        else:
            write_json(session / "apply-observation.json", row)

    for output, source in STATIC_RECEIPTS.items():
        file = ROOT / source
        if not file.is_file():
            continue
        try:
            _raw, row = private_json(file)
            if output == "browser-egress.json":
                assert row["browserClosed"] is True and UTC_STAMP.fullmatch(row["observedUtc"])
                masked = {"browserClosed": True, "observedUtc": row["observedUtc"]}
            else:
                assert row["phase"] in HOLD_PHASES and row["status"] in {"FAIL", "PASS"}
                assert UTC_STAMP.fullmatch(row["endedUtc"])
                child = row.get("childExit")
                assert child is None or (type(child) is int and -255 <= child <= 255)
                masked = {"phase": row["phase"], "status": row["status"],
                          "endedUtc": row["endedUtc"], "childExit": child}
                if row.get("error") is not None:
                    error = row["error"]
                    masked["error"] = error if isinstance(error, str) and error in HOLD_ERRORS else "unclassified-private-error"
        except (AssertionError, KeyError, OSError, TypeError, ValueError):
            continue
        write_json(session / output, masked)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("session", type=Path)
    parser.add_argument("image", nargs="?")
    parser.add_argument("cutoff", nargs="?", type=int)
    parser.add_argument("--hold", action="store_true")
    args = parser.parse_args()
    if args.hold:
        collect_hold(args.session)
    else:
        assert args.image and args.cutoff
        collect_success(args.session, args.image, args.cutoff)
