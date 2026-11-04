import { createHash } from "node:crypto";
import {
  copyFile,
  readFile,
  symlink,
  lstat,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Provisioner } from "./setup.ts";
import { privateDirectory } from "./state.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  "infra/alchemy.run.ts",
  "infra/migrations/0001_setup.sql",
  "community/worker.mjs",
  "package-lock.json",
];
export function provisioner(directory: string): Provisioner {
  return {
    async digest() {
      const hash = createHash("sha256");
      for (const file of sources) {
        hash.update(file + "\0");
        hash.update(await readFile(join(root, file)));
      }
      return hash.digest("hex");
    },
    async deploy(settings, plan, secrets) {
      if (!process.env.CLOUDFLARE_API_TOKEN)
        throw new Error("Cloudflare token missing");
      const cwd = join(directory, "deployment");
      await privateDirectory(cwd);
      await privateDirectory(join(cwd, "migrations"));
      await writeFile(
        join(cwd, "package.json"),
        '{"private":true,"type":"module"}\n',
        { mode: 0o600 },
      );
      await copyFile(
        join(root, "infra/alchemy.run.ts"),
        join(cwd, "alchemy.run.ts"),
      );
      await copyFile(
        join(root, "infra/migrations/0001_setup.sql"),
        join(cwd, "migrations/0001_setup.sql"),
      );
      await copyFile(
        join(root, "community/worker.mjs"),
        join(cwd, "worker.mjs"),
      );
      const modules = join(cwd, "node_modules");
      try {
        await symlink(join(root, "node_modules"), modules, "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (
        !(await lstat(modules)).isSymbolicLink() ||
        (await realpath(modules)) !==
          (await realpath(join(root, "node_modules")))
      )
        throw new Error("Unexpected deployment dependencies");
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        DO_NOT_TRACK: "1",
        CI: "1",
        NO_COLOR: "1",
        CLOUDFLARE_ACCOUNT_ID: settings.accountId,
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
        COMMUNITY_SLUG: settings.slug,
        COMMUNITY_NAME: settings.name,
        ACRCLOUD_HOST: settings.acrHost,
        PLAN_ID: plan.id,
        ...secrets,
      };
      // A fixed executable and argv; browser input never becomes shell code.
      // Provider output may contain secrets. Do not stream it to the browser or logs.
      for (const command of ["plan", "deploy"]) {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            join(root, "node_modules/.bin/alchemy"),
            [
              command,
              "--stage",
              "setup",
              "--no-input",
              ...(command === "deploy" ? ["--yes"] : []),
            ],
            { cwd, env, stdio: "ignore" },
          );
          child.on("error", () => reject(new Error("Alchemy could not start")));
          child.on("exit", (code) =>
            code === 0
              ? resolve()
              : reject(new Error("Alchemy did not complete")),
          );
        });
      }
      // No arbitrary probe URL. It must match the reviewed workers.dev origin.
      const response = await fetch(`${plan.origin}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Deployed endpoint is not ready");
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 4096) throw new Error("Unexpected health response");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing health response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 4096) throw new Error("Unexpected health response");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        health.schema !== "pirate.community-setup/1" ||
        health.planId !== plan.id ||
        health.infrastructure !== "provisioned"
      )
        throw new Error("Deployment receipt mismatch");
    },
  };
}
