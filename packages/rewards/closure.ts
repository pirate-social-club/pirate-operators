import { bytes32, hashJson, insist, object } from "../community/common.ts";
import type {
  RewardClosureEvidence,
  RewardOfferInput,
  RewardSources,
} from "./contracts.ts";
import type { OfferRow, RewardStore } from "./store.ts";
import { rewardAmount } from "./validation.ts";

export interface RewardClosureSnapshot {
  schema: "pirate.reward-closure/1";
  programId: string;
  inputHash: string;
  entriesHash: string;
  evidence: RewardClosureEvidence;
}

export function requiresRewardClosure(row: OfferRow) {
  const version = object(JSON.parse(row.purchase_evidence)).closureVersion;
  insist(
    version === undefined || version === 1,
    "reward_closure_version_unknown",
    503,
  );
  return version === 1;
}

export function checkRewardClosureEvidence(
  input: RewardOfferInput,
  evidence: RewardClosureEvidence,
) {
  insist(
    evidence.chainId === 6343 &&
      input.resultSources &&
      evidence.sources.length === input.resultSources.length,
    "reward_closure_sources_changed",
    503,
  );
  rewardAmount(evidence.cutoffNumber);
  insist(
    rewardAmount(evidence.cutoffTimestampSeconds) * 1000n <
      BigInt(input.cutoffAt),
    "reward_closure_cutoff_changed",
    503,
  );
  bytes32(evidence.cutoffHash);
  for (const [i, pin] of evidence.sources.entries()) {
    insist(
      bytes32(pin.sourceHash) === input.resultSources[i],
      "reward_closure_sources_changed",
      503,
    );
    bytes32(pin.policyEvidenceHash);
  }
}

export async function verifyRewardClosure(
  store: RewardStore,
  source: RewardSources | undefined,
  row: OfferRow,
  input: RewardOfferInput,
) {
  if (!requiresRewardClosure(row)) return;
  insist(
    source?.closure && row.entries_json !== null,
    "reward_closure_unavailable",
    503,
  );
  const stored = await store
    .statement(
      "SELECT snapshot_json,snapshot_hash FROM reward_closure_snapshots WHERE program_id=? AND offer_id=?",
      store.program,
      row.offer_id,
    )
    .first<{ snapshot_json: string; snapshot_hash: string }>();
  insist(stored, "reward_closure_unavailable", 503);
  const snapshot: RewardClosureSnapshot = JSON.parse(stored.snapshot_json);
  insist(
    snapshot.schema === "pirate.reward-closure/1" &&
      snapshot.programId === store.program &&
      snapshot.inputHash === row.input_hash &&
      snapshot.inputHash === hashJson(input) &&
      snapshot.entriesHash === hashJson(JSON.parse(row.entries_json)) &&
      stored.snapshot_hash === hashJson(snapshot),
    "reward_closure_snapshot_changed",
    503,
  );
  checkRewardClosureEvidence(input, snapshot.evidence);
  await source.closure.verify(input, snapshot.evidence);
}
