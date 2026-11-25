#!/usr/bin/python3
"""One guest-local disposable original on the admitted Notes native runner."""
import datetime as dt
import errno
import json
import os
from pathlib import Path
import pty
import queue
import re
import signal
import subprocess
import sys
import threading
import time


ROOT = Path("/opt/pw2-rehearsal")
CHECKOUT = Path("/opt/pw2-machine-source/checkout")
TOOLS = ROOT / "inputs/notes-controller"
STARTUP_PREP_LIMIT = 240
STARTUP_READY = b"Pirate Notes local startup prepared."
PROMPTS = {
    b"wizard> ": "wizard",
    b"Notes application before restart> ": "before",
    b"Notes application after restart> ": "after",
}
ACKS = {
    b"The disposable approval is recorded.": "approval",
    b"Exact funded fixture infrastructure prepared.": "services",
}


def require(value, error):
    if not value:
        raise RuntimeError(error)


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def private_read(path):
    row = path.lstat()
    require(path.resolve(strict=True) == path and path.is_file() and row.st_uid == 1000
            and not row.st_mode & 0o077 and 0 < row.st_size <= 16 * 1024 * 1024, "private_record")
    return json.loads(path.read_bytes())


def write_receipt(path, result):
    with path.open("x", encoding="utf8") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")


class Runner:
    def __init__(self, deadline, node):
        self.deadline = deadline
        self.mono_deadline = time.monotonic() + deadline - time.time()
        self.node = node
        self.events = queue.Queue(maxsize=18)
        self.proc = None
        self.master = None
        self.current_prompt = None
        self.reader_failure = None
        self.private_log = None

    def remaining(self):
        return min(self.deadline - time.time(), self.mono_deadline - time.monotonic())

    def emit(self, kind, value):
        try:
            self.events.put_nowait((kind, value))
        except queue.Full:
            self.reader_failure = "guest_pty_event_queue_full"

    def read_pty(self):
        buf = b""
        while True:
            try:
                chunk = os.read(self.master, 65536)
            except OSError as err:
                if err.errno != errno.EIO:
                    self.reader_failure = "guest_private_pty_read"
                break
            if not chunk:
                break
            if self.private_log is not None:
                self.private_log.write(chunk)
                self.private_log.flush()
            buf += chunk
            if len(buf) > 262144:
                self.reader_failure = "guest_private_pty_line_bound"
                break
            while buf:
                prefix = next((p for p in PROMPTS if buf.startswith(p)), None)
                if prefix:
                    self.emit(PROMPTS[prefix], None)
                    buf = buf[len(prefix):]
                    continue
                if b"\n" not in buf:
                    break
                line, buf = buf.split(b"\n", 1)
                private_line = line.strip()
                if private_line == STARTUP_READY:
                    self.emit("startup_ready", None)
                elif private_line.startswith(b'{"wizard":'):
                    try:
                        value = json.loads(private_line)
                        self.emit("handoff", value)
                    except (UnicodeDecodeError, ValueError):
                        self.reader_failure = "guest_pty_handoff_shape"
                else:
                    for marker, kind in ACKS.items():
                        if marker in private_line:
                            self.emit(kind, None)
        self.emit("closed", None)

    def start(self):
        log_dir = ROOT / "logs"
        log_dir.mkdir(mode=0o700, exist_ok=True)
        self.private_log = (log_dir / "native-runner.private.log").open("xb", buffering=0)
        self.master, slave = pty.openpty()
        try:
            self.proc = subprocess.Popen(
                ["/usr/bin/bash", str(CHECKOUT / ".local/web2-native-private-practice-reviewed/launch-manual-demo.sh")],
                cwd=CHECKOUT, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                env={**os.environ, "TERM": "dumb"},
            )
        finally:
            os.close(slave)
        threading.Thread(target=self.read_pty, daemon=True).start()

    def expect(self, kind, timeout):
        limit = time.monotonic() + min(self.remaining(), timeout)
        while (remaining := min(self.remaining(), limit - time.monotonic())) > 0:
            require(not self.reader_failure, self.reader_failure or "pty_failure")
            try:
                actual, value = self.events.get(timeout=min(0.2, remaining))
            except queue.Empty:
                require(self.proc.poll() is None, "native_runner_exit")
                continue
            if min(self.remaining(), limit - time.monotonic()) <= 0:
                break
            if actual == kind:
                if kind in PROMPTS.values():
                    self.current_prompt = kind
                return value
            require(False, "unexpected_guest_prompt_order_" + actual)
        raise RuntimeError("guest_prompt_timeout_" + kind)

    def command(self, prompt, command):
        allowed = {"wizard": {"approve registration", "services", "continue", "stop"},
                   "before": {"restart", "stop"}, "after": {"stop"}}
        require(self.current_prompt == prompt and command in allowed[prompt], "unowned_terminal_command")
        self.current_prompt = None
        os.write(self.master, command.encode("ascii") + b"\n")

    def browser(self, script, args, private_input=None, timeout=180):
        install_observer = script == "wizard-notes-control.mjs" and args[0] == "install-original"
        if install_observer:
            wall_started_ns = time.time_ns()
            mono_started_ns = time.monotonic_ns()
        budget = min(self.remaining() - 40, timeout)
        require(budget > 0, "guest_browser_cutoff")
        env = None
        if install_observer:
            # Set both absolute phase limits before starting Node. The child
            # cannot acquire a new continuation reserve from a wall rollback.
            duration_ns = int(budget * 1_000_000_000)
            phase_wall_ms = min(int((self.deadline - 40) * 1000), (wall_started_ns + duration_ns) // 1_000_000)
            phase_mono_ns = mono_started_ns + duration_ns
            env = {**os.environ, "PIRATE_NOTES_INSTALL_PHASE_DEADLINE_MS": str(phase_wall_ms),
                   "PIRATE_NOTES_INSTALL_PHASE_MONO_DEADLINE_NS": str(phase_mono_ns)}
            budget = min(budget, (phase_mono_ns - time.monotonic_ns()) / 1_000_000_000)
            require(budget > 0, "guest_browser_cutoff")
        stdout_path = ROOT / "logs" / (script + "." + args[0] + ".stdout.log")
        stderr_path = ROOT / "logs" / (script + "." + args[0] + ".stderr.log")
        with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
            result = subprocess.run(
                [self.node, str(TOOLS / script), *args], cwd=CHECKOUT, env=env,
                input=json.dumps(private_input).encode("utf8") if private_input is not None else b"",
                stdout=stdout, stderr=stderr, timeout=budget, check=False,
            )
        # CDP and Wizard errors can include sensitive local input. These streams stay in memory.
        require(result.returncode == 0, "guest_browser_phase_failed_" + args[0])

    def cdp_listener(self, port):
        return subprocess.check_output(
            ["/usr/bin/ss", "-H", "-ltnp", "sport", "=", ":" + str(port)], text=True, timeout=3
        ).splitlines()

    def cdp_identity(self, path, expected_label):
        endpoint = private_read(path)
        require(endpoint.get("controlLabel") == expected_label, "guest_cdp_role")
        match = re.fullmatch(r"ws://127[.]0[.]0[.]1:([0-9]{1,5})/devtools/browser/[a-f0-9-]{36}",
                             endpoint.get("webSocket", ""))
        require(match, "guest_cdp_endpoint")
        port = int(match.group(1))
        rows = self.cdp_listener(port)
        require(len(rows) == 1 and rows[0].split()[3] == "127.0.0.1:" + str(port), "guest_cdp_listener")
        pids = re.findall(r"pid=([0-9]+)", rows[0])
        require(pids and len(set(pids)) == 1, "guest_cdp_pid")
        pid = int(pids[0])
        proc = Path("/proc") / str(pid)
        require(os.readlink(proc / "exe") == os.environ["PIRATE_MANUAL_CHROMIUM"], "guest_cdp_executable")
        fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
        require(proc.stat().st_uid == 1000, "guest_cdp_owner")
        ancestor = int(fields[1])
        for _ in range(12):
            if ancestor == self.proc.pid:
                break
            require(ancestor > 1, "guest_cdp_runner_ancestor")
            parent = (Path("/proc") / str(ancestor) / "stat").read_text().rsplit(")", 1)[1].split()
            ancestor = int(parent[1])
        require(ancestor == self.proc.pid, "guest_cdp_runner_ancestor")
        return {"port": port, "pid": pid, "startTicks": fields[19], "loopback": True, "seenUtc": utc()}

    def cdp_gone(self, identity):
        deadline = time.monotonic() + min(8, self.remaining())
        port, pid = identity["port"], identity["pid"]
        while time.monotonic() < deadline:
            try:
                fields = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
                same = fields[19] == identity["startTicks"]
            except (FileNotFoundError, ProcessLookupError):
                same = False
            if not same and not self.cdp_listener(port):
                identity["closedUtc"] = utc()
                return
            time.sleep(0.15)
        raise RuntimeError("guest_previous_cdp_still_live")

    def abort(self):
        if self.proc is None or self.proc.poll() is not None:
            return
        if self.current_prompt:
            self.command(self.current_prompt, "stop")
            try:
                self.proc.wait(timeout=min(max(1, self.remaining()), 12))
                return
            except subprocess.TimeoutExpired:
                pass
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
            self.proc.wait(timeout=15)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if self.proc.poll() is None:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait(timeout=5)


def terminate(_signum, _frame):
    raise RuntimeError("outer_guest_termination")


def main():
    require(sys.argv[1:] == [str(ROOT), str(CHECKOUT)], "exact_guest_paths")
    require(os.getuid() == os.getgid() == 1000, "guest_operator_identity")
    require(ROOT.resolve(strict=True) == ROOT and (ROOT.stat().st_mode & 0o777) == 0o700
            and ROOT.stat().st_uid == 1000, "private_guest_root")
    require(os.environ.get("PIRATE_MANUAL_RUN_ROOT") == str(ROOT)
            and os.environ.get("PIRATE_MANUAL_BROWSER_CONTROL") == "disposable-loopback"
            and os.environ.get("DISPLAY") == ":96", "guest_local_control_selection")
    require(not (ROOT / "manual-run-original.json").exists(), "original_already_exists")
    for family in ("-4", "-6"):
        routes = subprocess.check_output(["/usr/sbin/ip", family, "route", "show", "default"])
        require(not routes.strip(), "guest_default_route_present")
    require(not any((link / "device").exists() for link in Path("/sys/class/net").iterdir()),
            "guest_has_physical_network_device")
    raw_deadline = os.environ["PIRATE_DEMO_DEADLINE_MS"]
    require(re.fullmatch(r"[0-9]{13}", raw_deadline), "exact_guest_cutoff")
    node = os.environ["PIRATE_MANUAL_NODE"]
    require(Path(node).resolve(strict=True) == Path(node) and Path(node).is_file(), "pinned_node_path")
    ctl = Runner(int(raw_deadline) / 1000, node)
    require(ctl.remaining() > 660, "insufficient_full_guest_window")
    os.umask(0o077)
    summary = {"schema": "pirate.native-notes-guest-controller/1", "startedUtc": utc(), "steps": [],
               "phase": "start", "status": "FAIL", "syntheticFixtureOperator": True,
               "humanAudibilityObserved": False}
    summary["cdp"] = {}
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    write_receipt(ROOT / "notes-controller-start.json", summary)
    run_id = None
    try:
        ctl.start()
        summary["phase"] = "local_startup"
        ctl.expect("startup_ready", STARTUP_PREP_LIMIT)
        summary["phase"] = "initial_wizard"
        handoff = ctl.expect("handoff", 180)
        ctl.expect("wizard", 12)
        original = private_read(ROOT / "manual-run-original.json")
        run_id = original["runId"]
        require(re.fullmatch(r"manual-[a-f0-9]{12}", run_id), "fixture_run_id")
        artifacts = ROOT / "artifacts" / run_id

        def cdp(label, directory, kind):
            summary["cdp"][label] = ctl.cdp_identity(directory / (kind + "-browser-control.json"), kind)

        cdp("wizard_before", artifacts, "wizard")

        def wizard(step, data, timeout=180):
            summary["phase"] = step
            ctl.browser("wizard-notes-control.mjs", [step, str(ROOT), str(CHECKOUT), run_id, raw_deadline], data, timeout)
            summary["steps"].append({"step": step, "utc": utc()})

        wizard("hold-registration", handoff)
        public_info = {key: handoff[key] for key in ("wizard", "communityOrigin", "fixtureOwner")}
        handoff = None
        ctl.command("wizard", "approve registration")
        ctl.expect("approval", 40)
        ctl.expect("wizard", 10)
        wizard("fund-original", public_info, 240)
        ctl.command("wizard", "services")
        ctl.expect("services", 90)
        ctl.expect("wizard", 15)
        wizard("install-original", public_info, 1860)
        ctl.command("wizard", "continue")
        ctl.expect("before", 50)
        ctl.cdp_gone(summary["cdp"]["wizard_before"])
        cdp("application_before", artifacts / "application-before", "application")

        def notes(step, timeout):
            summary["phase"] = "notes-" + step
            ctl.browser("native-notes-control.mjs", [step, str(ROOT), run_id, public_info["communityOrigin"],
                                                       raw_deadline, str(CHECKOUT)], timeout=timeout)
            summary["steps"].append({"step": "notes-" + step, "utc": utc()})

        notes("publish", 290)
        ctl.command("before", "restart")
        summary["phase"] = "ordinary_native_restart"
        reopened = ctl.expect("handoff", 600)
        require(reopened.get("communityOrigin") == public_info["communityOrigin"]
                and reopened.get("fixtureOwner") == public_info["fixtureOwner"]
                and "fixtureInvitation" not in reopened, "restart_original_scope")
        ctl.expect("wizard", 12)
        ctl.cdp_gone(summary["cdp"]["application_before"])
        cdp("wizard_after", artifacts / "reopened", "wizard")
        wizard("retained-repair", reopened, 75)
        reopened = None
        ctl.command("wizard", "continue")
        ctl.expect("after", 50)
        ctl.cdp_gone(summary["cdp"]["wizard_after"])
        cdp("application_after", artifacts / "reopened/application-after", "application")
        notes("replay", 80)
        ctl.command("after", "stop")
        summary["phase"] = "close"
        exit_code = ctl.proc.wait(timeout=min(max(1, ctl.remaining() - 15), 90))
        require(exit_code == 0, "exact_native_runner_terminal_failure")
        ctl.cdp_gone(summary["cdp"]["application_after"])
        terminal = ROOT / "artifacts" / run_id / "rehearsal-notes-replay.json"
        private_read(terminal)
        summary["status"] = "PASS"
    except (OSError, KeyError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        summary["error"] = exc.args[0] if type(exc) is RuntimeError else type(exc).__name__
    finally:
        try:
            ctl.abort()
        except (OSError, RuntimeError, subprocess.SubprocessError):
            summary["status"] = "FAIL"
            summary["cleanupInconclusive"] = True
        finally:
            for identity in summary["cdp"].values():
                if "closedUtc" not in identity:
                    try:
                        ctl.cdp_gone(identity)
                    except (OSError, RuntimeError, subprocess.SubprocessError):
                        summary["status"] = "FAIL"
                        summary["cleanupInconclusive"] = True
            if ctl.private_log is not None:
                ctl.private_log.close()
            if ctl.master is not None:
                os.close(ctl.master)
            summary.update(endedUtc=utc(), runId=run_id,
                           childExit=None if ctl.proc is None else ctl.proc.returncode)
            write_receipt(ROOT / "notes-controller-terminal.json", summary)
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, KeyError, RuntimeError, ValueError, subprocess.SubprocessError) as failure:
        if (os.getuid() == 1000 and ROOT.is_dir() and ROOT.resolve() == ROOT
                and ROOT.stat().st_uid == 1000 and (ROOT.stat().st_mode & 0o777) == 0o700
                and not (ROOT / "notes-controller-terminal.json").exists()):
            os.umask(0o077)
            write_receipt(ROOT / "notes-controller-terminal.json", {
                "schema": "pirate.native-notes-guest-controller/1", "phase": "preflight",
                "status": "FAIL", "endedUtc": utc(), "error": str(failure) if type(failure) is RuntimeError
                else type(failure).__name__, "childExit": None,
            })
        sys.exit(1)
