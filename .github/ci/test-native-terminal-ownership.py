"""Regression test for the shared-stdin readline ownership fix.

The rehearsal launcher keeps one readline interface on process.stdin across the
ordinary restart. The sealed r19 harness had each Wizard session create a second
interface on the same stream and close it at session end. Under Node 24 on a PTY,
closing that second interface pauses the stream under the launcher's interface:
later launcher prompts are displayed and input is echoed, but the question promise
never settles. This is the post-replay terminal-question-after hang reproduced
outside the guest. The fixed design gives the launcher sole ownership and lends
the one interface to Wizard sessions. These cases lock the mechanism in: the
legacy sequence must not deliver input, and the shared sequence must.
"""
import os
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

LEGACY_TWO_INTERFACE = """
import { createInterface } from "node:readline/promises";
const launcher = createInterface({ input: process.stdin, output: process.stdout });
const wizard = createInterface({ input: process.stdin, output: process.stdout });
const a = await wizard.question("wizard> ");
process.stdout.write("got1:" + a + "\\n");
wizard.close();
const b = await launcher.question("after> ");
process.stdout.write("got2:" + b + "\\n");
process.exit(0);
setTimeout(() => process.exit(3), 8000).unref();
"""

SHARED_SINGLE_INTERFACE = """
import { createInterface } from "node:readline/promises";
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const a = await terminal.question("wizard> ");
process.stdout.write("got1:" + a + "\\n");
const b = await terminal.question("after> ");
process.stdout.write("got2:" + b + "\\n");
terminal.close();
process.exit(0);
setTimeout(() => process.exit(3), 8000).unref();
"""


def drive(script, wait=5.0):
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as file:
        file.write(script)
        path = file.name
    master, slave = pty.openpty()
    proc = subprocess.Popen(["node", path], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    output = b""
    answered_wizard = answered_after = False
    end = time.monotonic() + wait
    try:
        while time.monotonic() < end and proc.poll() is None:
            ready, _w, _x = select.select([master], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            output += chunk
            if not answered_wizard and b"wizard> " in output:
                os.write(master, b"install\n")
                answered_wizard = True
            if answered_wizard and not answered_after and b"after> " in output:
                os.write(master, b"stop\n")
                answered_after = True
        return b"got2:stop" in output, output
    finally:
        proc.kill()
        proc.wait()
        os.close(master)
        Path(path).unlink()


class NativeTerminalOwnershipTests(unittest.TestCase):
    def test_shared_single_interface_delivers_stop(self):
        got2, output = drive(SHARED_SINGLE_INTERFACE)
        self.assertTrue(got2, f"shared interface must deliver stop; output tail: {output[-200:]!r}")

    def test_legacy_two_interface_close_loses_stop(self):
        # Documents the failure mechanism the fix removes. If Node ever changes this
        # behavior the premise of the ownership rule needs re-evaluation, so the case
        # stays as a detector rather than a comment.
        got2, output = drive(LEGACY_TWO_INTERFACE)
        self.assertFalse(got2, f"legacy sequence input delivery means platform behavior changed; output tail: {output[-200:]!r}")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
