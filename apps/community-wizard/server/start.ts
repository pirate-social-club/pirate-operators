import {
  open,
  unlink,
  realpath,
  access,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWizardServer } from "./http.ts";
import { createSetup } from "./setup.ts";
import { infisicalConfigured, infisicalStore } from "./secrets.ts";
import { provisioner } from "./provision.ts";
import { statePassword } from "../infra/protected-data.ts";
import { privateDirectory } from "./state.ts";

process.umask(0o077);
const directory = resolve(
  process.env.PIRATE_WIZARD_STATE_DIR ??
    join(homedir(), ".local/state/pirate-community-wizard"),
);
await privateDirectory(directory);
for (let parent = await realpath(directory); ; parent = dirname(parent)) {
  const inRepository = await access(join(parent, ".git")).then(
    () => true,
    () => false,
  );
  if (inRepository)
    throw new Error("Use a private state directory outside Git repositories.");
  if (dirname(parent) === parent) break;
}
const lockPath = join(directory, "runner.lock");
let lock: FileHandle;
try {
  lock = await open(lockPath, "wx", 0o600);
} catch {
  console.error(
    "This state directory is locked. Stop its runner before reopening. After a crash, confirm no Alchemy process remains before removing runner.lock.",
  );
  process.exit(1);
}
await lock.writeFile(String(process.pid) + "\n");
const setup = await createSetup(
  directory,
  infisicalStore,
  provisioner(directory),
);
const server = createWizardServer(
  setup,
  resolve(dirname(fileURLToPath(import.meta.url)), "../dist"),
  {
    infisical: infisicalConfigured(),
    cloudflare: Boolean(process.env.CLOUDFLARE_API_TOKEN),
    stateProtection: (() => {
      try {
        statePassword();
        return true;
      } catch {
        return false;
      }
    })(),
  },
);
const port = Number(process.env.PIRATE_WIZARD_PORT ?? 8789);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid loopback port");
server.listen(port, "127.0.0.1", () =>
  console.log(`Community wizard: http://127.0.0.1:${port}`),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await setup.settled().catch(() => {});
  await lock.close();
  await unlink(lockPath);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
