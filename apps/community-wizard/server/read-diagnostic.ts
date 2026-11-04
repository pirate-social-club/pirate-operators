import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statePassword, unseal } from "../infra/protected-data.ts";
const [id, consent] = process.argv.slice(2);
if (
  !/^\d+-(plan|deploy)-[a-f0-9-]+\.enc$/.test(id ?? "") ||
  consent !== "--show-sensitive"
) {
  console.error(
    "Usage: npm run diagnostic -- <log-id> --show-sensitive\nOnly use a private terminal: decoded provider output can contain secrets. Do not paste it into chat or public reports.",
  );
  process.exit(1);
}
const directory = resolve(
  process.env.PIRATE_WIZARD_STATE_DIR ??
    join(homedir(), ".local/state/pirate-community-wizard"),
);
const data = JSON.parse(
  unseal(
    await readFile(join(directory, "diagnostics", id), "utf8"),
    statePassword(),
    `diagnostic:${id}`,
  ),
);
process.stdout.write(
  data.output + (data.truncated ? "\n[Output truncated at 1 MiB]\n" : "\n"),
);
