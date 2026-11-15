import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export async function bindBrowser(executable, expectedSha256) {
  if (!path.isAbsolute(executable ?? "") || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")) {
    throw new Error("Absolute browser executable and exact SHA256 required");
  }
  const actualPath = await realpath(executable);
  if (!(await stat(actualPath)).isFile()) throw new Error("Browser executable is not a file");
  await access(actualPath, constants.X_OK);
  const actualSha256 = createHash("sha256").update(await readFile(actualPath)).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error("Browser executable SHA256 mismatch");
  return Object.freeze({ executablePath: actualPath, sha256: actualSha256 });
}

export async function verifyBrowserUnchanged(binding) {
  return bindBrowser(binding.executablePath, binding.sha256);
}
