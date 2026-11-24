import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireOperation,
  hash,
  processIdentity,
} from "../deploy/linux/backend-state.ts";
import {
  createLocalController,
  type InstalledTarget,
} from "../deploy/linux/local-target-controller.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "lcm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["control", "docker-config", "resources", "output"]) {
    await mkdir(join(root, name), { mode: 0o700 });
  }
  const socket = join(root, "docker.sock");
  const server = createServer();
  server.listen(socket);
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const holder = await processIdentity(process.pid);
  assert(holder);
  const lease = await acquireOperation(
    join(root, "control"),
    "fast-metadata-fixture",
    "fast-metadata-fixture",
    {},
    holder.pidNamespace,
  );
  const docker = await realpath("/bin/true");
  const target: InstalledTarget = {
    installationId: "fast-metadata-fixture",
    daemonId: "fixture-daemon",
    docker,
    dockerSha256: hash(await readFile(docker)),
    socket,
    dockerConfig: join(root, "docker-config"),
    stateRoot: root,
    maintenanceDirectory: join(root, "maintenance"),
    resourceDirectory: join(root, "resources"),
    outputDirectory: join(root, "output"),
    cwd: root,
    environment: { HOME: process.env.HOME },
    hostWriters: [],
    allowedReadOnlyRoots: [],
    allowedWritableRoots: [],
    containers: [
      {
        key: "application",
        name: "fixture-app",
        imageId: "sha256:" + hash("image"),
        configurationDigest: hash("configuration"),
        ingress: false,
        user: "1000:1000",
        argv: ["fixture"],
        roles: ["application"],
        network: hash("network"),
        ports: [],
        mounts: [],
      },
    ],
  };
  return { root, lease, target };
}

test("local target retains fast read-only metadata children that finish before proc observation", async (t) => {
  const { lease, target } = await fixture(t);
  const controller = await createLocalController(target, lease);
  try {
    let completedBeforeObservation = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await controller.command(
        ["container", "ls", "--all", "--quiet", "--no-trunc"],
        new AbortController().signal,
      );
      assert.equal(result.text, "");
      assert.equal(result.facts.code, 0);
      completedBeforeObservation ||=
        result.facts.completedBeforeNativeObservation === true;
    }
    assert.equal(
      completedBeforeObservation,
      true,
      "fixture did not exercise the fast-completion path",
    );
  } finally {
    await controller.dispose();
  }
});
