// Explicit testnet successor of the retained first-song application. No new community resources.
import { readFile } from "node:fs/promises";
import { canonical, insist, object } from "../packages/community/common.ts";

export const learningApplicationBaseline =
  "0x0a1f11e21e5d2c02378fa4657cd38f400c8b4e197f83343b7bea9e3fa805a86c";
export async function learningCommunityProfile() {
  const deployment = object(
    JSON.parse(
      await readFile(
        "docs/deployments/learning-results-testnet-20261106.contract.json",
        "utf8",
      ),
    ),
  );
  insist(
    deployment.chainId === 6343 &&
      /^0x[0-9a-f]{40}$/.test(String(deployment.learningResults)),
    "learning_contract_unqualified",
    409,
  );
  return {
    chainId: 6343,
    contract: deployment.learningResults as string,
    operator: "0x14b90a55657d9695a727254eaec5e0e32d20d602",
    issuer: "0xbf85a150114d3df8b90a7793c0ea4b2f4bb8c319",
    operatorWorker: "pirate-learning-testnet-v2",
    operatorOrigin:
      "https://pirate-learning-testnet-v2.piratesocialclub.workers.dev",
    accounting: "internal",
    speechDailyCalls: 0,
    historyRetentionDays: 30,
    providerCredential: {
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "staging",
      path: "/services/api-next",
      key: "ELEVENLABS_API_KEY",
    },
    acceptance:
      "Karaoke enrollment, automatic whole-run publication, provider-billed speech, retained private history download and revocation on MegaETH testnet",
  };
}
export function assertLearningApplicationUpgrade(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const changed = [
    "sourceHashes",
    "bundleSha256",
    "bundleBytes",
    "assets",
    "migrations",
    "learning",
    "acceptance",
    "reviewedUpdate",
  ];
  const omit = (p: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(p).filter(([k]) => !changed.includes(k)));
  insist(
    canonical(omit(previous)) === canonical(omit(next)),
    "learning_upgrade_unrelated_intent_changed",
    409,
  );
  insist(
    canonical(next.migrations) ===
      canonical([...(previous.migrations as string[]), "0008_karaoke.sql"]),
    "learning_upgrade_migrations_changed",
    409,
  );
  const learning = object(next.learning);
  insist(
    learning.chainId === 6343 &&
      learning.accounting === "internal" &&
      learning.speechDailyCalls === 10 &&
      learning.historyRetentionDays === 30 &&
      learning.operatorWorker === "pirate-learning-testnet-v2",
    "learning_upgrade_scope_changed",
    409,
  );
}
