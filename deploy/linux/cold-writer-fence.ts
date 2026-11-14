import assert from "node:assert/strict";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { runOwnedCommand } from "./backend-command.ts";
import { hash, privateDirectory, privateFile, processIdentity, sameProcess, type OperationLease, type ProcessIdentity } from "./backend-state.ts";
import { containerProcessEvidence, requireLifetimeAbsent, requireObserverHostFrame } from "./writer-evidence.ts";

interface Container {
  Id: string; Image: string;
  Config: { Labels: Record<string, string> };
  HostConfig: { RestartPolicy: { Name: string } };
  State: { Running: boolean; Paused: boolean; Restarting: boolean; Dead: boolean; Pid: number; ExitCode: number };
  Mounts: Array<{ Source: string; RW: boolean }>;
}
export interface ColdWriterPlan {
  installationId: string;
  daemonId: string;
  // Server-owned complete release inventory. Browser checkbox lists are not admission.
  inventoryDigest: string;
  roots: Record<string, string>;
  containers: Array<{ id: string; imageId: string; configurationDigest: string; ingress: boolean; roles: string[] }>;
  alreadyStoppedHostWriters: ProcessIdentity[];
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const canonical = (value: unknown): string => value !== null && typeof value === "object" ?
  Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" :
    "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}" : JSON.stringify(value);

/** Real local Docker readbacks and stop commands. No remote/ambient Docker
 * context, pull, create, delete, broad signal, restart-policy change or adoption. */
export async function createColdWriterFence(input: {
  lease: OperationLease; plan: ColdWriterPlan; inventoryFile: string;
  executable: string; executableSha256: string; socket: string;
  privateDockerConfig: string; outputDirectory: string; cwd: string;
  environment: NodeJS.ProcessEnv; signal: AbortSignal;
  // Actual installed controller must prevent new starts while its persistent
  // maintenance guard is held. This required boundary is not a claimed flag.
  controller: { enterMaintenance(): Promise<void>; assertMaintenanceHeld(): Promise<void> };
}) {
  const { lease, plan } = input; await lease.assertHeld(); assert.equal(plan.installationId, lease.installationId);
  requireObserverHostFrame(lease.holder, await processIdentity(process.pid));
  const inventory = await privateFile(input.inventoryFile, 1048576);
  try {
    const bytes = await inventory.readFile(); assert.equal(hash(bytes), plan.inventoryDigest);
    const { inventoryDigest, ...preimage } = plan;
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), preimage, "backup_writer_inventory_not_bound");
  } finally { await inventory.close(); }
  await privateDirectory(input.privateDockerConfig); assert.deepEqual(await readdir(input.privateDockerConfig), []);
  assert.equal(await realpath(input.socket), input.socket); const socketIdentity = await lstat(input.socket);
  assert(socketIdentity.isSocket(), "backup_local_daemon_socket_required");
  assert(plan.containers.length > 0 && new Set(plan.containers.map((v) => v.id)).size === plan.containers.length);
  for (const root of Object.values(plan.roots)) await privateDirectory(root);
  assert(Object.keys(plan.roots).length > 0);
  const roots = Object.values(plan.roots);
  assert(roots.every((a) => roots.every((b) => a === b || !overlaps(a, b))), "backup_root_alias");
  const roles = [...new Set(plan.containers.flatMap((v) => v.roles))].sort();
  assert.deepEqual(roles, Object.keys(plan.roots).sort(), "backup_writer_roles_incomplete");
  let sequence = 0, entered = false; const priorProcesses: ProcessIdentity[] = [];
  const containerProcesses: ReturnType<typeof containerProcessEvidence>[] = [];
  async function command(argv: string[]) {
    await lease.assertHeld();
    const socket = await lstat(input.socket);
    assert(socket.isSocket() && socket.dev === socketIdentity.dev && socket.ino === socketIdentity.ino, "backup_daemon_socket_changed");
    async function raw(args: string[]) {
      const name = "docker-" + String(++sequence).padStart(4, "0");
      const result = await runOwnedCommand({ ...input, name, seconds: 45,
        argv: ["--host", "unix://" + input.socket, "--config", input.privateDockerConfig, ...args] });
      const file = await privateFile(result.stdoutPath, 16 * 1024 * 1024);
      try { return await file.readFile("utf8"); } finally { await file.close(); }
    }
    const actual = JSON.parse(await raw(["info", "--format", "{{json .}}"]));
    assert(typeof plan.daemonId === "string" && plan.daemonId.length > 0 && actual.ID === plan.daemonId &&
      actual.Name === hostname(), "backup_local_daemon_identity_changed");
    return raw(argv);
  }
  async function inspectAll() {
    const ids = (await command(["container", "ls", "--all", "--quiet", "--no-trunc"])).trim().split(/\s+/).filter(Boolean);
    assert(ids.length <= 10000 && ids.every((id) => id.length === 64 && !/[^a-f0-9]/.test(id)));
    if (ids.length === 0) return [];
    const actual = JSON.parse(await command(["inspect", "--type", "container", ...ids])) as Container[];
    assert(actual.length === ids.length && actual.every((v) => ids.includes(v.Id)));
    return actual;
  }
  async function validate(all: Container[], stopped: boolean) {
    requireObserverHostFrame(lease.holder, await processIdentity(process.pid));
    const lifetimes = [];
    for (const host of plan.alreadyStoppedHostWriters) {
      const current = await processIdentity(host.hostPid);
      lifetimes.push(requireLifetimeAbsent(host, current));
      // A namespace/permission error propagates, never becoming absence.
    }
    for (const actual of all) {
      const expected = plan.containers.find((v) => v.id === actual.Id);
      const touches = actual.Mounts.some((m) => m.RW && roots.some((r) => overlaps(m.Source, r)));
      assert(!touches || expected, "backup_unregistered_mount_writer");
      if (!expected) continue;
      assert(actual.Image === expected.imageId && actual.Config.Labels["io.pirate.installation"] === plan.installationId,
        "backup_container_identity_changed");
      assert(hash(canonical(actual.Config)) === expected.configurationDigest, "backup_container_configuration_changed");
      assert(expected.roles.every((role) => actual.Mounts.some((mount) => overlaps(mount.Source, plan.roots[role]!))),
        "backup_role_mount_mismatch");
      assert(actual.HostConfig.RestartPolicy.Name === "no", "backup_supervisor_not_fenced");
      assert(!actual.State.Paused && !actual.State.Restarting && !actual.State.Dead, "backup_container_state_uncertain");
      if (stopped) assert(!actual.State.Running && actual.State.Pid === 0 && actual.State.ExitCode === 0, "backup_writer_not_cleanly_stopped");
    }
    assert(plan.containers.every((v) => all.some((row) => row.Id === v.id)), "backup_resource_missing");
    if (stopped) for (const previous of priorProcesses)
      lifetimes.push(requireLifetimeAbsent(previous, await processIdentity(previous.hostPid)));
    return lifetimes;
  }
  return {
    async enter() {
      assert(!entered); await input.controller.enterMaintenance(); await input.controller.assertMaintenanceHeld();
      await lease.record("cold-fence-intent", { inventoryDigest: plan.inventoryDigest, containers: plan.containers, roots: plan.roots });
      const all = await inspectAll(); await validate(all, false);
      for (const expected of [...plan.containers].sort((a, b) => Number(b.ingress) - Number(a.ingress))) {
        await input.controller.assertMaintenanceHeld();
        const current = (await inspectAll()).find((v) => v.Id === expected.id)!;
        await validate(await inspectAll(), false);
        if (current.State.Running) {
          const observer = requireObserverHostFrame(lease.holder, await processIdentity(process.pid));
          const identity = await processIdentity(current.State.Pid);
          const evidence = containerProcessEvidence(observer, current.Id, current.State.Pid, identity);
          requireObserverHostFrame(lease.holder, await processIdentity(process.pid));
          const after = (await inspectAll()).find((v) => v.Id === expected.id);
          assert(after?.State.Running && after.State.Pid === evidence.dockerHostPid, "backup_container_pid_changed_uncertain");
          assert(sameProcess(evidence.containerProcess, await processIdentity(evidence.dockerHostPid)), "backup_container_lifetime_changed_uncertain");
          containerProcesses.push(evidence); priorProcesses.push(evidence.containerProcess);
          await lease.record("cold-container-process-observed", evidence);
          await command(["container", "stop", "--time", "30", expected.id]);
        }
      }
      entered = true; return this.assertCold();
    },
    async assertCold() {
      assert(entered); await lease.assertHeld(); await input.controller.assertMaintenanceHeld();
      const first = await inspectAll(); const firstLifetimes = await validate(first, true);
      const second = await inspectAll(); const secondLifetimes = await validate(second, true);
      return lease.record("cold-fence-readback", { inventoryDigest: plan.inventoryDigest,
        first: first.filter((v) => plan.containers.some((p) => p.id === v.Id)).map((v) => ({ id: v.Id, state: v.State })),
        second: second.filter((v) => plan.containers.some((p) => p.id === v.Id)).map((v) => ({ id: v.Id, state: v.State })),
        priorProcesses, containerProcesses, firstLifetimes, secondLifetimes });
    },
    // There is deliberately no automatic restart or release on error. The
    // owning lifecycle must reconcile exact identities and actual health before
    // it can remove maintenance and reopen ingress.
  };
}
