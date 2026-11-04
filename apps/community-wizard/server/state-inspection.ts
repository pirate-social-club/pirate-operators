import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Inspect actual generated files after each provider phase, not just Config.Redacted wrappers.
export async function inspectPrivateFiles(directory: string, values: string[]) {
  const needles = values.filter(Boolean).map((value) => Buffer.from(value));
  let total = 0;
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (
        path === directory &&
        entry.name === "node_modules" &&
        entry.isSymbolicLink()
      )
        continue;
      if (entry.isSymbolicLink())
        throw new Error(
          "Unexpected symlink in deployment state; inspection refused.",
        );
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        total += (await stat(file)).size;
        if (total > 64 * 1024 * 1024)
          throw new Error("Deployment state exceeds the inspection budget.");
        const contents = await readFile(file);
        if (needles.some((secret) => contents.includes(secret)))
          throw new Error(
            "Plaintext credential detected in generated deployment files. Preserve private state and repair storage before continuing.",
          );
      }
    }
  }
  await walk(directory);
}
