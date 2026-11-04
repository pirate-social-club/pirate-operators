// This wrapper uses the existing cf login and the task's private local state.
// Plan is the default. Deploy requires an explicit --execute argument.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

process.umask(0o077);
const cwd = dirname(fileURLToPath(import.meta.url));
const state = resolve(
  homedir(),
  ".local/state/pirate-creator-wallet-testnet/alchemy",
);
mkdirSync(state, { recursive: true, mode: 0o700 });
chmodSync(state, 0o700);
const link = resolve(cwd, ".alchemy");
if (!existsSync(link)) symlinkSync(state, link, "dir");
if (
  !lstatSync(link).isSymbolicLink() ||
  realpathSync(link) !== realpathSync(state)
) {
  throw Error(
    "Preserve and migrate the existing .alchemy state to the private state directory before using this wrapper.",
  );
}
if (!process.env.SUI_OPERATOR_SECRET_KEY)
  throw Error("Inject the dedicated testnet operator through Infisical.");
const config = JSON.parse(
  readFileSync(
    resolve(homedir(), ".config/cloudflare/config/default.json"),
    "utf8",
  ),
);
if (!config.oauth_token)
  throw Error("Run cf login for the existing operator profile.");
const execute = process.argv.includes("--execute");
if (process.argv.slice(2).some((arg) => arg !== "--execute"))
  throw Error("Usage: node deploy.mjs [--execute]");
const args = [
  execute ? "deploy" : "plan",
  "--stage",
  "testnet",
  "--no-input",
  ...(execute ? ["--yes"] : []),
];
const result = spawnSync(resolve(cwd, "node_modules/.bin/alchemy"), args, {
  cwd,
  stdio: "inherit",
  env: {
    ...process.env,
    CLOUDFLARE_API_TOKEN: config.oauth_token,
    CLOUDFLARE_ACCOUNT_ID: "08a4c22cf52e2ecae883e36f80a33f4a",
    DO_NOT_TRACK: "1",
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
