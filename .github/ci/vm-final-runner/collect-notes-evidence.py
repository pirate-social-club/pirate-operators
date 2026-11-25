"""Return only scoped Notes receipts from the closed disposable guest."""
import argparse
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
            if (row["stage"], row["responseStatus"]) == ("installation-prepare-response", 502):
                try:
                    evidence = read_bounded_install_refusal(server)
                    validate_install_server_refusal(evidence)
                except (AssertionError, OSError, TypeError, ValueError):
                    pass
                else:
                    write_json(session / "install-server-refusal.json", evidence)

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
