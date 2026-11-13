import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { bindBrowser, verifyBrowserUnchanged } from "./audit-browser.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "storybook-browser-binding-"));
  try {
    const executable = path.join(root, "browser");
    await writeFile(executable, "fixture executable bytes", { mode: 0o700 });
    await run(executable, sha("fixture executable bytes"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("binds the exact requested executable bytes and freezes their identity", () => fixture(async (file, digest) => {
  const binding = await bindBrowser(file, digest);
  assert.equal(binding.executablePath, file);
  assert.equal(binding.sha256, digest);
  assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(await verifyBrowserUnchanged(binding), binding);
}));
test("rejects a different executable even when its path exists", () => fixture(async (file) => {
  await assert.rejects(bindBrowser(file, sha("different bytes")), /mismatch/u);
}));
test("detects replacement after initial binding", () => fixture(async (file, digest) => {
  const binding = await bindBrowser(file, digest);
  await writeFile(file, "replacement");
  await assert.rejects(verifyBrowserUnchanged(binding), /mismatch/u);
}));
test("rejects missing and non-executable files", () => fixture(async (file, digest, root) => {
  await assert.rejects(bindBrowser(path.join(root, "missing"), digest));
  await chmod(file, 0o600);
  await assert.rejects(bindBrowser(file, digest));
}));
test("rejects relative paths and malformed hashes before launching anything", async () => {
  await assert.rejects(bindBrowser("relative", "a".repeat(64)), /Absolute/u);
  await assert.rejects(bindBrowser("/absolute", "not-a-hash"), /SHA256/u);
});
