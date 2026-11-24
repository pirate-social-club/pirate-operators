import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const image = process.env.PIRATE_TEST_IMAGE;
const releaseRoot = process.env.PIRATE_TEST_RELEASE_ROOT;

test("the runtime image lets UID 1000 traverse the CA directories and read the bundle", {
  skip: !image || !releaseRoot ? "set PIRATE_TEST_IMAGE and PIRATE_TEST_RELEASE_ROOT to run the container probe" : false,
}, () => {
  assert.match(image!, /^(sha256:)?[0-9a-f]{64}$/);
  assert.ok(releaseRoot!.startsWith("/") && !releaseRoot!.includes(".."));
  const node = `${releaseRoot}/toolchain/node`;
  const source = [
    "const fs=require('node:fs');",
    "fs.accessSync('/etc/ssl',fs.constants.X_OK);",
    "fs.accessSync('/etc/ssl/certs',fs.constants.X_OK);",
    "fs.readFileSync('/etc/ssl/certs/ca-certificates.crt');",
  ].join("");
  let container = "";
  try {
    container = execFileSync("docker", [
      "container", "create", "--pull=never", "--network", "none", "--read-only",
      "--user", "1000:1000", "--entrypoint", node, image!, "-e", source,
    ], { encoding: "utf8", timeout: 30_000 }).trim();
    assert.match(container, /^[0-9a-f]{64}$/);
    execFileSync("docker", ["container", "start", "--attach", container], {
      encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    if (container) {
      try { execFileSync("docker", ["container", "rm", "--force", container], { stdio: "ignore", timeout: 30_000 }); }
      catch { /* the start failure is the test result; cleanup is best effort */ }
    }
  }
});
