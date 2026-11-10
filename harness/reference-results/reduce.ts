// Raw public evidence -> independently checked terminal records -> SQL boards.
// No production result, source, policy, reward-score or board reduction helpers.
import { decodeEventLog, hashTypedData, type Hex } from "viem";
import {
  abiFor,
  resultManifestUri,
  type Header,
  type ReferenceSnapshot,
} from "./facts.ts";
import {
  referenceBoards,
  type ReferenceEligibility,
  type ReferencePolicy,
  type ReferenceSession,
} from "./board.ts";
import {
  integer,
  learningDay,
  lower,
  ordered,
  publicDocument,
  rawCode,
  rawEvent,
  requireFact,
  zero,
} from "./checks.ts";
import { commitment, decodeOutcomes, immutableContext } from "./outcomes.ts";
import { policyDocument } from "./policy.ts";
import { decodeStudy, studyDocument } from "./study.ts";
import { sourceIndex } from "./source.ts";

export interface ReferenceResult extends ReferenceSession {
  header: Header;
  wire: Hex;
  commitment: Hex;
  problems: string[];
}
const enrollmentTypes = {
  Enrollment: [
    { name: "learner", type: "address" },
    { name: "communityId", type: "bytes32" },
    { name: "activities", type: "uint256" },
    { name: "publicityPolicy", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export function referenceResults(snapshot: ReferenceSnapshot) {
  requireFact(
    snapshot.schema === "pirate.reference-public-evidence/1" &&
      [6343, 31337].includes(snapshot.profile.chainId) &&
      snapshot.head.hash === snapshot.checkedHeadHash &&
      snapshot.blocks[snapshot.head.number]?.hash === snapshot.head.hash &&
      snapshot.blocks[snapshot.head.number]?.number === snapshot.head.number &&
      snapshot.blocks[snapshot.head.number]?.timestamp ===
        snapshot.head.timestamp &&
      snapshot.evaluationTimestamp >= integer(snapshot.head.timestamp),
    "snapshot_reorganized_or_invalid",
  );
  const membership = sourceIndex(snapshot);
  const records: ReferenceResult[] = [];
  const policies: ReferencePolicy[] = [];
  const eligibility: ReferenceEligibility[] = [];
  for (const contract of snapshot.profile.results) {
    const version = contract.version ?? 2,
      contractAbi = abiFor(version);
    rawCode(snapshot, contract);
    const state = snapshot.contractStates.find(
      (s) => lower(s.address) === lower(contract.address),
    );
    requireFact(
      state &&
        state.communityId === snapshot.profile.communityId &&
        (state.version === version ||
          (version === 2 && state.version === undefined)),
      "result_contract_context_changed",
    );
    const contractId = `${snapshot.profile.chainId}:${lower(contract.address)}`;
    const community = `${snapshot.profile.chainId}:${snapshot.profile.communityId}`;
    let controller = "";
    const graders = new Set<string>();
    const nonces = new Map<string, bigint>();
    const grants = new Map<
      string,
      { id: Hex; issued: bigint; expires: bigint; activities: bigint }
    >();
    const latest = new Map<string, ReferenceResult>();
    const invalidations = new Set<string>();
    const activated: ReferencePolicy[] = [];
    let sequence = 0;
    for (const log of ordered(snapshot, contract.address)) {
      requireFact(
        BigInt(log.blockNumber) >= BigInt(contract.fromBlock),
        "result_before_deployment",
      );
      const block = rawEvent(snapshot, log);
      const event = decodeEventLog({
        abi: contractAbi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      const a = event.args as any;
      sequence++;
      if (event.eventName === "ControllerChanged") {
        controller = lower(a.controller);
        continue;
      }
      if (event.eventName === "GraderSet") {
        const key = `${lower(a.grader)}:${a.activity}`;
        if (a.allowed) graders.add(key);
        else graders.delete(key);
        continue;
      }
      if (event.eventName === "Enrolled") {
        const e = a.enrollment;
        const id = hashTypedData({
          domain: {
            name: "Pirate Learning Results",
            version: String(version),
            chainId: snapshot.profile.chainId,
            verifyingContract: contract.address,
          },
          types: enrollmentTypes,
          primaryType: "Enrollment",
          message: e,
        });
        const learner = lower(a.learner);
        requireFact(
          id === a.enrollmentId &&
            learner === lower(e.learner) &&
            e.communityId === state.communityId &&
            e.publicityPolicy === state.publicityPolicy &&
            (version === 2
              ? e.activities === 1n
              : e.activities >= 1n && e.activities <= 3n) &&
            a.issuedAt === BigInt(block.timestamp) &&
            e.expiresAt > a.issuedAt &&
            e.nonce === (nonces.get(learner) ?? 0n),
          "invalid_enrollment_history",
        );
        nonces.set(learner, e.nonce + 1n);
        grants.set(learner, {
          id,
          issued: a.issuedAt,
          expires: e.expiresAt,
          activities: e.activities,
        });
        continue;
      }
      if (event.eventName === "Revoked") {
        const learner = lower(a.learner);
        requireFact(
          a.nonce === (nonces.get(learner) ?? 0n) &&
            a.enrollmentId === (grants.get(learner)?.id ?? zero),
          "invalid_revocation_history",
        );
        nonces.set(learner, a.nonce + 1n);
        grants.delete(learner);
        continue;
      }
      if (event.eventName === "PolicyActivated") {
        const period = integer(a.effectivePeriod),
          activity = version === 3 ? integer(a.activity) : 1;
        const earlier = activated.filter((p) => p.activity === activity);
        requireFact(
          (activity === 1 || (version === 3 && activity === 2)) &&
            a.clockVersion === 1 &&
            period >
              (integer(block.timestamp) < 1793552400
                ? 0
                : learningDay(block.timestamp)) &&
            (!earlier.length || period > earlier.at(-1)!.period),
          "retroactive_policy",
        );
        const p = {
          contract: contractId,
          hash: a.policyHash,
          activity,
          period,
          document: policyDocument(
            snapshot,
            a.policyURI,
            a.policyHash,
            activity,
          ),
        };
        activated.push(p);
        policies.push(p);
        continue;
      }
      if (event.eventName === "EligibilityChanged") {
        eligibility.push({
          community,
          learner: lower(a.learner),
          eligible: a.eligible,
          effectiveAt: integer(a.effectiveAt),
          order: `${log.blockNumber.padStart(30, "0")}:${String(log.transactionIndex).padStart(10, "0")}:${String(log.logIndex).padStart(10, "0")}`,
        });
        continue;
      }
      if (event.eventName === "ResultInvalidated") {
        requireFact(a.reason !== zero, "empty_invalidation_reason");
        invalidations.add(
          `${a.sessionId}:${a.revision}:${log.transactionHash}`,
        );
        continue;
      }
      if (event.eventName !== "ResultPublished") continue;
      const r = a.result as Header;
      const previous = latest.get(r.sessionId);
      const problems: string[] = [];
      let outcomes: ReferenceSession["outcomes"] = [];
      let song = "unverified";
      let period = -1;
      try {
        requireFact(
          a.sessionId === r.sessionId &&
            lower(a.learner) === lower(r.learner) &&
            a.revision === r.revision &&
            commitment(r, a.outcomes) === a.commitment,
          "result_commitment_changed",
        );
        requireFact(
          r.activity === 1 || (version === 3 && r.activity === 2),
          "unsupported_activity",
        );
        outcomes =
          r.activity === 2
            ? decodeStudy(r, a.outcomes)
            : decodeOutcomes(r, a.outcomes);
        period = learningDay(r.completedAt);
        const policy = activated
          .filter((p) => p.activity === r.activity && p.period <= period)
          .at(-1);
        requireFact(
          r.qualificationPolicy === (policy?.hash ?? zero) &&
            state.policies[
              version === 3 ? `${r.activity}:${period}` : String(period)
            ] === (policy?.hash ?? zero),
          "wrong_completion_policy",
        );
        requireFact(
          r.startedAt <= r.completedAt &&
            r.completedAt <= BigInt(block.timestamp) &&
            (r.activity === 1 || (version === 3 && r.activity === 2)),
          "result_time_or_activity_changed",
        );
        const publisher = lower(a.publisher);
        if (!previous) {
          const grant = grants.get(lower(r.learner));
          requireFact(
            r.revision === 1 &&
              r.supersedes === zero &&
              r.status >= 1 &&
              r.status <= 4 &&
              publisher === lower(r.grader) &&
              graders.has(`${publisher}:${r.activity}`) &&
              grant?.id === r.enrollmentId &&
              (grant.activities & (1n << BigInt(r.activity - 1))) !== 0n &&
              r.startedAt >= grant.issued &&
              BigInt(block.timestamp) < grant.expires,
            "initial_result_not_authorized",
          );
        } else {
          requireFact(
            r.revision === previous.header.revision + 1 &&
              r.supersedes === previous.commitment &&
              immutableContext(r) === immutableContext(previous.header) &&
              previous.problems.length === 0 &&
              r.status >= 1 &&
              r.status <= 5 &&
              (publisher === controller ||
                (previous.status !== 5 &&
                  publisher === lower(r.grader) &&
                  graders.has(`${publisher}:${r.activity}`))) &&
              (r.status !== previous.status || a.outcomes !== previous.wire),
            "invalid_correction_chain",
          );
          if (r.status === 5)
            requireFact(
              publisher === controller && a.outcomes === previous.wire,
              "invalid_controller_invalidation",
            );
        }
        const manifest =
          r.activity === 2
            ? studyDocument(snapshot, r.contentRevision)
            : publicDocument(
                snapshot,
                resultManifestUri(r.contentRevision),
                r.contentRevision,
              );
        song = membership(r, manifest, outcomes);
      } catch (error) {
        problems.push(String(error));
      }
      const item: ReferenceResult = {
        key: `${contractId}:${r.sessionId}`,
        contract: contractId,
        community,
        song,
        learner: lower(r.learner),
        period,
        activity: r.activity,
        grader: lower(r.grader),
        scoring: r.scoringPolicy,
        policy: r.qualificationPolicy,
        status: r.status,
        verified: problems.length === 0,
        outcomes,
        header: r,
        wire: a.outcomes,
        commitment: a.commitment,
        problems,
      };
      if (r.status === 5)
        (item as any).invalidation =
          `${r.sessionId}:${r.revision}:${log.transactionHash}`;
      latest.set(r.sessionId, item);
    }
    for (const r of latest.values()) {
      if (state.commitments[r.header.sessionId] !== r.commitment)
        r.problems.push("reference_current_commitment_changed");
      if (r.status === 5 && !invalidations.has((r as any).invalidation))
        r.problems.push("reference_invalidation_missing");
      r.verified = r.problems.length === 0 && r.status !== 5;
      records.push(r);
    }
  }
  return {
    records,
    policies,
    eligibility,
    ...referenceBoards(
      records,
      policies,
      eligibility,
      snapshot.evaluationTimestamp,
    ),
  };
}
