import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeImageRecipe } from "../deploy/linux/complete-image-recipe.ts";

const pinnedBase = "docker.io/library/node:24.18.1-bookworm-slim@sha256:" +
  "235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7";
const installedReleasePath = "/opt/pirate-runtime-ca-test";
const source = [
  "const fs=require('node:fs');",
  "fs.accessSync('/etc/ssl',fs.constants.X_OK);",
  "fs.accessSync('/etc/ssl/certs',fs.constants.X_OK);",
  "fs.readFileSync('/etc/ssl/certs/ca-certificates.crt');",
].join("");

function docker(args: string[], options: { encoding?: BufferEncoding; timeout?: number; input?: Buffer } = {}) {
  return execFileSync("docker", args, {
    encoding: options.encoding ?? "utf8", timeout: options.timeout ?? 120_000,
    input: options.input, stdio: ["ignore", "pipe", "pipe"],
  }) as string;
}

const suppliedImage = process.env.PIRATE_TEST_IMAGE;
const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

test("the runtime image lets UID 1000 traverse the CA directories and read the bundle", {
  skip: !suppliedImage && !dockerAvailable ? "Docker is required for the runtime image probe" : false,
}, async () => {
  let scratch: string | undefined;
  let builtImage = "";
  let container = "";
  try {
    let image = suppliedImage;
    let node = suppliedImage ? `${process.env.PIRATE_TEST_RELEASE_ROOT}/toolchain/node` :
      `${installedReleasePath}/toolchain/node`;
    if (!image) {
      scratch = await mkdtemp(join(tmpdir(), "pirate-runtime-ca-test."));
      const release = join(scratch, "release");
      await mkdir(join(release, "toolchain"), { recursive: true });
      let roots: Buffer;
      try { roots = await readFile("/etc/ssl/certs/ca-certificates.crt"); }
      catch { roots = Buffer.from("disposable runtime CA probe\n"); }
      await writeFile(join(release, "toolchain/ca-certificates.crt"), roots);
      await symlink("/usr/local/bin/node", join(release, "toolchain/node"));
      await writeFile(join(scratch, "Dockerfile"), completeImageRecipe({
        imageBase: pinnedBase, uid: 1000, gid: 1000, installedReleasePath,
      }));
      builtImage = `pirate-runtime-ca-test:${process.pid}`;
      docker(["build", "--network=none", "--tag", builtImage, "--file",
        join(scratch, "Dockerfile"), scratch], { timeout: 600_000 });
      image = builtImage;
    }
    assert.ok(image && node.startsWith("/") && !node.includes(".."));
    container = docker([
      "container", "create", "--pull=never", "--network", "none", "--read-only",
      "--user", "1000:1000", "--entrypoint", node, image, "-e", source,
    ], { timeout: 30_000 }).trim();
    assert.match(container, /^[0-9a-f]{64}$/);
    docker(["container", "start", "--attach", container], { timeout: 30_000 });
  } finally {
    if (container) {
      try { docker(["container", "rm", "--force", container], { timeout: 30_000 }); }
      catch { /* preserve the probe failure; cleanup is best effort */ }
    }
    if (builtImage) {
      try { docker(["image", "rm", "--force", builtImage], { timeout: 30_000 }); }
      catch { /* preserve the probe failure; cleanup is best effort */ }
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});
