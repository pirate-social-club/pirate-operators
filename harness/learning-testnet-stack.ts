// Run the reviewed Alchemy stack with existing managed secrets in memory only.
// Usage: node --import ./apps/community-wizard/node_modules/tsx/dist/loader.mjs harness/learning-testnet-stack.ts [--deploy]
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import { curatedCloudContext } from "./curated-release-plan.ts";
import { check } from "../packages/protocol/index.ts";
import { firstSong } from "../services/first-song-profile.ts";

const root = resolve(import.meta.dirname, "..");
const state = join(
  homedir(),
  ".local/state/pirate-learning-results-testnet-20261106",
);
const deploy = process.argv.includes("--deploy");
const sdk = await infisicalAuth().client();
const secret = async (
  projectId: string,
  secretPath: string,
  secretName: string,
) => {
  const value = await sdk.secrets().getSecret({
    projectId,
    environment: "staging",
    secretPath,
    secretName,
    includeImports: false,
    expandSecretReferences: false,
  });
  check(value.secretValue, "required_managed_secret_missing");
  return value.secretValue;
};
const [cloud, speech, password, keys, journal] = await Promise.all([
  curatedCloudContext(),
  secret(
    "fac45f92-9450-42fb-8c2f-f20d043fdfab",
    "/services/api-next",
    "ELEVENLABS_API_KEY",
  ),
  secret(
    "43d2261a-f739-428f-92f2-5f907db24c07",
    "/communities/first-song-20261105-runner",
    "PIRATE_WIZARD_STATE_PASSWORD",
  ),
  readFile(
    join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json"),
    "utf8",
  ).then(JSON.parse),
  readFile(join(state, "deployment.json"), "utf8").then(JSON.parse),
]);
check(
  journal.intents.deploy.settled && journal.intents.grader.settled,
  "contract_setup_pending",
);
const operator = privateKeyToAccount(keys.keys.operator),
  issuer = privateKeyToAccount(keys.keys.communityAdmin);
const approval = await readFile(
  join(state, "moss-activation-approval.json"),
  "utf8",
)
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
if (approval)
  check(
    approval.chainId === 6343 &&
      /^0x[0-9a-f]{40}$/.test(approval.address) &&
      Date.now() - Date.parse(approval.approvedAt) < 86400000,
    "activation_approval_invalid",
  );
check(
  journal.operator.toLowerCase() === operator.address.toLowerCase(),
  "operator_changed",
);
await mkdir(join(state, "alchemy"), { recursive: true, mode: 0o700 });
const now = Math.floor(Date.now() / 1000);
const quoteWindowPath = join(state, "quote-window.json");
let quoteWindow = await readFile(quoteWindowPath, "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
if (!quoteWindow) {
  quoteWindow = { validFrom: now - 60, validUntil: now + 30 * 86400 };
  await import("./private-json.ts").then(({ durableJson }) =>
    durableJson(quoteWindowPath, quoteWindow),
  );
}
check(
  Number.isSafeInteger(quoteWindow.validFrom) &&
    Number.isSafeInteger(quoteWindow.validUntil) &&
    quoteWindow.validFrom <= now &&
    now < quoteWindow.validUntil,
  "quote_window_expired_or_invalid",
);
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  CI: "true",
  NO_COLOR: "1",
  CLOUDFLARE_API_TOKEN: cloud.token,
  CLOUDFLARE_ACCOUNT_ID: cloud.accountId,
  PIRATE_WIZARD_STATE_PASSWORD: password,
  LEARNING_COMMUNITY_ID: firstSong.directoryProfile.communityId,
  LEARNING_RESULTS_CONTRACT: journal.intents.deploy.address.toLowerCase(),
  LEARNING_GRADER_ADDRESS: operator.address.toLowerCase(),
  LEARNING_ISSUER_ADDRESS: issuer.address,
  LEARNING_OPERATOR_PRIVATE_KEY: keys.keys.operator,
  LEARNING_ELEVENLABS_API_KEY: speech,
  ...(approval
    ? { LEARNING_APPROVED_ACTIVATION_ACCOUNT: approval.address }
    : {}),
  LEARNING_SPONSOR_CAP_WEI: "500000000000000",
  LEARNING_GAS_PRICE_WEI: "1000000",
  LEARNING_GAS_LIMIT: "1500000",
  LEARNING_DATA_FEE_WEI: "100000000000",
  LEARNING_SPEECH_DAILY_LIMIT: "0",
  LEARNING_QUOTE_VALID_FROM: String(quoteWindow.validFrom),
  LEARNING_QUOTE_VALID_UNTIL: String(quoteWindow.validUntil),
};
const config = resolve(
  root,
  "apps/community-wizard/infra/learning-testnet.alchemy.ts",
);
const executable = resolve(
  root,
  "apps/community-wizard/node_modules/.bin/alchemy",
);
const child = spawn(
  executable,
  [
    deploy ? "deploy" : "plan",
    config,
    "--stage",
    "testnet",
    "--no-input",
    ...(deploy ? ["--yes"] : []),
  ],
  {
    cwd: join(state, "alchemy"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "",
  outputBytes = 0;
const collect = (bytes: Buffer) => {
  outputBytes += bytes.length;
  if (outputBytes <= 2 * 1024 * 1024) output += String(bytes);
};
child.stdout.on("data", collect);
child.stderr.on("data", collect);
process.exitCode = await new Promise<number>((done) =>
  child.once("exit", (code) => done(code ?? 1)),
);
if (outputBytes > 2 * 1024 * 1024)
  console.log(
    "Deployment output withheld because it exceeded the bounded log size.",
  );
else {
  for (const value of [cloud.token, speech, password, keys.keys.operator])
    output = output.replaceAll(value, "[redacted]");
  process.stdout.write(output);
}
