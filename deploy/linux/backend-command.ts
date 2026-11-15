import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { createJSON, privateDirectory, privateFile, processIdentity, sameProcess, safeId, type OperationLease } from "./backend-state.ts";

/** Actual bounded command runner. Raw output stays private. No shell or
 * detached Promise.race: timeout/cancel must await actual owned-child exit. */
export interface OwnedCommandInput {
  lease: OperationLease; executable: string; executableSha256: string; argv: string[];
  environment: NodeJS.ProcessEnv; cwd: string; outputDirectory: string; name: string;
  seconds: number; signal: AbortSignal;
  keyMaterial?: Uint8Array;
}
export async function runOwnedCommand(input:OwnedCommandInput) {return runCommand(input);}
export async function runCurrentAuthorityCommand(input:OwnedCommandInput,assertCurrent:()=>Promise<void>){
  assert(typeof assertCurrent==="function","actual_current_effect_authority_required");
  return runCommand(input,assertCurrent);
}
async function runCommand(input:OwnedCommandInput,assertCurrent?:()=>Promise<void>) {
  await input.lease.assertHeld(); assert(!input.signal.aborted,"native_effect_cancelled");
  assert(safeId(input.name), "backend_command_name_invalid");
  assert(input.environment.HOME === process.env.HOME, "backend_HOME_changed");
  assert(Object.keys(input.environment).every((key) => ["HOME", "PATH", "TMPDIR", "TZ", "LANG", "NODE_COMPILE_CACHE"].includes(key)),
    "backend_ambient_or_secret_environment_refused");
  assert(Number.isSafeInteger(input.seconds) && input.seconds > 0 && input.seconds <= 300);
  if (input.keyMaterial) assert.equal(input.keyMaterial.byteLength, 32);
  await privateDirectory(input.outputDirectory);
  const fs = await import("node:fs/promises");
  assert.equal(await fs.realpath(input.executable), input.executable);
  const before = await fs.lstat(input.executable);
  assert(before.isFile() && !before.isSymbolicLink() && before.size <= 256 * 1024 * 1024 && (before.mode & 0o111));
  const executable = await open(input.executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await executable.stat(); assert(current.ino === before.ino && current.dev === before.dev && current.isFile());
    assert.equal(createHash("sha256").update(await executable.readFile()).digest("hex"), input.executableSha256);
  }
  finally { await executable.close(); }
  const stdoutPath = join(input.outputDirectory, input.name + ".stdout"), stderrPath = join(input.outputDirectory, input.name + ".stderr");
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  const stdout = await open(stdoutPath, flags, 0o600);
  let stderr: Awaited<ReturnType<typeof open>>;
  try { stderr = await open(stderrPath, flags, 0o600); } catch (error) { await stdout.close(); throw error; }
  let child: ReturnType<typeof spawn>;
  try {
    // Source/hash/private-output acquisition may await. The actual V2 native
    // mutator revalidates its ORIGINAL/current authority at the last boundary,
    // not only before entering this command runner.
    if(assertCurrent)await assertCurrent();
    assert(!input.signal.aborted,"native_effect_cancelled");
    child = spawn(input.executable, input.argv, { shell: false, detached: true, cwd: input.cwd,
      env: input.environment, stdio: ["ignore", stdout.fd, stderr.fd, input.keyMaterial ? "pipe" : "ignore"] });
  } catch (error) { await stdout.close(); await stderr.close(); throw error; }
  let timer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false, cancelled = false, owned: Awaited<ReturnType<typeof processIdentity>> = null, custodyError: unknown;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exit.catch(() => {}); // The same raw failure is awaited/reported below.
  const spawned = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  async function stop() {
    try {
      assert(owned && sameProcess(owned, await processIdentity(owned.hostPid)), "backend_child_identity_uncertain");
      process.kill(owned.hostPid, "SIGTERM");
      killTimer = setTimeout(() => { void (async () => {
        try { assert(owned && sameProcess(owned, await processIdentity(owned.hostPid))); process.kill(owned.hostPid, "SIGKILL"); }
        catch (error) { custodyError = error; }
      })(); }, 10000);
    } catch (error) { custodyError = error; }
  }
  const cancel = () => { cancelled = true; void stop(); };
  try {
    await spawned; owned = await processIdentity(child.pid!);
    assert(owned && owned.pidNamespace === input.lease.holder.pidNamespace && owned.hostGroup === child.pid && owned.hostSession === child.pid);
    await input.lease.record(input.name + "-launch", { executable: input.executable, argv: input.argv, owned });
    timer = setTimeout(() => { timedOut = true; void stop(); }, input.seconds * 1000);
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) cancel();
    if (input.keyMaterial) {
      assert.equal(input.keyMaterial.byteLength, 32);
      const copy = Buffer.from(input.keyMaterial), pipe = child.stdio[3] as Writable;
      try { await new Promise<void>((resolve, reject) => { pipe.once("error", reject); pipe.end(copy, resolve); }); }
      finally { copy.fill(0); }
    }
    const result = await exit; await stdout.sync(); await stderr.sync();
    const descendants: number[] = [];
    for (const id of await (await import("node:fs/promises")).readdir("/proc")) {
      if (!/^[0-9]+$/.test(id)) continue;
      let text: string;
      try { text = await readFile("/proc/" + id + "/stat", "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const fields = text.slice(text.lastIndexOf(")") + 2).split(/\s+/);
      if (Number(fields[3]) === owned.hostSession) descendants.push(Number(id));
    }
    const facts = { ...result, timedOut, cancelled, owned, descendants,
      custodyUncertain: custodyError !== undefined || descendants.length > 0 };
    await input.lease.record(input.name + "-exit", facts);
    assert(!facts.custodyUncertain && !timedOut && !cancelled && result.code === 0 && result.signal === null, "backend_command_failed_or_custody_uncertain");
    return { stdoutPath, stderrPath, facts };
  } finally {
    if (child.exitCode === null && child.signalCode === null && owned) {
      // Cleanup is real signalling and an awaited exit. If matching fails the
      // outer owner retains custody; this function does not invent disposal.
      try { await stop(); await exit; } catch (error) { custodyError = error; }
    }
    if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    input.signal.removeEventListener("abort", cancel); await stdout.close(); await stderr.close();
    // Caller must retain the operation lease on any uncertainty. No broad kill,
    // descendant adoption, lock release or claimed cleanup on an exception.
  }
}
