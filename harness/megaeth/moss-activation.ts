// Manual proof for the one captured MOSS consent. --send remains an explicit
// owner-approved action. Every signed transaction is saved privately before
// broadcast; reruns reconcile the same journal, with at most three nonces.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { check } from "../../packages/protocol/index.ts";
import type { Env } from "../../services/runtime.ts";
import {
  OPERATOR,
  RECORDS,
  RPC,
  consentFromJson,
  song,
} from "../moss-consent/consent-probe.ts";
import { ActivationJournal } from "./activation-journal.ts";
import { runActivation } from "./activation-run.ts";

const SEND = process.argv.includes("--send");
const STATE = join(homedir(), ".local/state/pirate-operators-moss-consent");
const KEYS =
  process.env.MEGAETH_KEYS ??
  join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json");
const LEARNER = "0xa1ffb1ae235aa526188f6facdc34eef1ab4fdae3";
const ATTEMPT =
  "0xb2cd06f4d6495ee3cf9963edd0699d8739eef7dda7057e6aec43bf09c51ae452";
// At most 300k + 300k + 400k gas, each capped at 0.001 gwei.
const LIMITS = { maxFeePerGas: 1_000_000n, maxTotalFee: 1_000_000_000_000n };
const log = (value: unknown) => console.log(JSON.stringify(value));

async function main() {
  const probe = JSON.parse(
    readFileSync(join(STATE, "probe-result-2026-11-04.json"), "utf8"),
  ) as {
    consent: Record<string, unknown>;
    signature: Hex;
  };
  const consent = consentFromJson(probe.consent);
  check(
    consent.learner.toLowerCase() === LEARNER && consent.attemptId === ATTEMPT,
    "unexpected_probe_identity",
  );
  const env = {
    RPC_URL: RPC,
    PAYMENT_CHAIN_ID: "6343",
    ACCOUNT_DELEGATE: "0xf655611abe392f35cbb36181d920a302c4df2284",
    ACCOUNT_INITIALIZER: "0xdb03009c44a36a7490d80c9a9e1a03b53497dc42",
  } as Env;
  if (SEND) {
    const file = JSON.parse(readFileSync(KEYS, "utf8")) as {
      chainId: number;
      keys: { operator: Hex };
    };
    check(file.chainId === 6343, "keys_not_for_megaeth_testnet");
    check(
      privateKeyToAccount(file.keys.operator).address === OPERATOR,
      "operator_key_mismatch",
    );
    env.PRIVATE_KEY = file.keys.operator;
  }
  const directory = join(STATE, "activation");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const location = relative(realpathSync(repository), realpathSync(directory));
  check(location.startsWith("../"), "journal_must_be_outside_repository");
  const journal = new ActivationJournal(join(directory, `${ATTEMPT}.sqlite`));
  try {
    const result = await runActivation(
      {
        env,
        consent,
        signature: probe.signature,
        song,
        records: RECORDS,
        operator: OPERATOR,
        chainId: 6343,
        limits: LIMITS,
      },
      journal,
      SEND,
    );
    journal.set("run:last_status", result);
    log({ mode: SEND ? "send" : "read_only", ...result });
    if (SEND && result.status === "complete") {
      const evidence = {
        kind: "megaeth-moss-activation",
        recordedAt: new Date().toISOString(),
        chainId: 6343,
        records: RECORDS,
        ...result,
        note: "Authorization chain ID 0 is not chain-bound. Broadcast was restricted to MegaETH testnet. Full signatures and raw transactions stay private.",
      };
      mkdirSync("docs/evidence", { recursive: true });
      const path = `docs/evidence/megaeth-moss-activation-${evidence.recordedAt.slice(0, 10)}.json`;
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
      log({ step: "evidence", path });
    }
  } catch (error) {
    // SDK errors can contain the full authorization; diagnostics stay private.
    journal.set("run:last_error", {
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    journal.close();
  }
}
main().catch((error) => {
  const code =
    error instanceof Error && /^[a-z_]{3,80}$/.test(error.message)
      ? error.message
      : "activation_incomplete_retry_same_journal";
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
