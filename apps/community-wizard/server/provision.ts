import { createHash } from "node:crypto";
import {
  copyFile,
  readFile,
  symlink,
  lstat,
  realpath,
  writeFile,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { statePassword } from "../infra/protected-data.ts";
import { runWithDiagnostics } from "./diagnostics.ts";
import { waitForHealth } from "./health.ts";
import { inspectPrivateFiles } from "./state-inspection.ts";
import type { Provisioner } from "./setup.ts";
import { privateDirectory } from "./state.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  "infra/alchemy.run.ts",
  "infra/encrypted-state.ts",
  "infra/protected-data.ts",
  "infra/migrations/0001_setup.sql",
  "community/worker.mjs",
  "package-lock.json",
  "server/provision.ts",
  "server/diagnostics.ts",
  "server/state-inspection.ts",
  "server/health.ts",
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
    async health(plan) {
      await waitForHealth(plan.origin, plan.id);
    },
    async deploy(settings, plan, secrets) {
      const password = statePassword();
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
      for (const file of ["encrypted-state.ts", "protected-data.ts"]) {
        await copyFile(join(root, "infra", file), join(cwd, file));
      }
      const modules = join(cwd, "node_modules");
      try {
        if (!(await lstat(modules)).isSymbolicLink())
          throw new Error("Unexpected deployment dependencies");
        await unlink(modules);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
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
        MODERATION_MODE: settings.moderationMode,
        PIRATE_WIZARD_STATE_PASSWORD: password,
        ...secrets,
      };
      await inspectPrivateFiles(cwd, [
        password,
        process.env.CLOUDFLARE_API_TOKEN!,
        ...Object.values(secrets),
      ]);
      // Only the runner passes credentials; raw output is encrypted, never sent to the browser.
      for (const command of ["plan", "deploy"]) {
        await runWithDiagnostics(
          join(root, "node_modules/.bin/alchemy"),
          [
            command,
            "--stage",
            "setup",
            "--no-input",
            ...(command === "deploy" ? ["--yes"] : []),
          ],
          { cwd, env, directory, password, phase: command },
        );
        await inspectPrivateFiles(cwd, [
          password,
          process.env.CLOUDFLARE_API_TOKEN!,
          ...Object.values(secrets),
        ]);
      }
      await waitForHealth(plan.origin, plan.id);
    },
  };
}
