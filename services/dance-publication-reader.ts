import { hashTypedData, type Address, type Hex } from "viem";
import { canonical, CommunityError, insist } from "../packages/community/common.ts";
import { DANCE_DB_NOW, DanceStore } from "../packages/dance/store.ts";
import { danceId, validateFence } from "../packages/dance/validation.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { danceAccountCommitment, type DanceCapture, type DanceDecision } from "../packages/dance-chain/v2/wire.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import { publicationConsentAbi, publicationConsentTypes } from "../packages/protocol/generated/publication-consent-v1.ts";
import { consentDigest, consentUint64, parsePublicationGrant, publicationDomain } from "../packages/protocol/publication-consent.ts";
import type { BoundPublicationGrantV1, PreparedConsentCommandV1,
  ConsentCommandReceiptV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { dancePublicationChecks } from "./dance-publication-checks.ts";
import { verifyDancePublicationSource } from "./dance-publication-source.ts";

type PrivateGrant = { accountId: string; binding: BoundPublicationGrantV1 };
type Admission = { kind: "capture"; capture: DanceCapture; learner: PrivateGrant } |
  { kind: "review"; capture: DanceCapture; decision: DanceDecision;
    learner: PrivateGrant; reviewer: PrivateGrant };
/** Adapter over learning's ORIGINAL app-DB bindings and existing operator nonce
 * journal, never a second journal. Predicates must bind every supplied original
 * grant/source/private-account/wallet field AND captured localFenceGeneration,
 * current purpose-keyed denial/generation and recorded canonical receipt.
 * No latest-grant substitution, cross-store atomicity or RPC-to-recorded update.
 * reconcileOriginal authenticates the exact command/digest/source/event receipt
 * independently of CURRENT grant usability, including after registry replacement. */
export interface DancePublicationJournal {
  readonly db: D1Database;
  acceptanceFences(input: {
    captureHash: Hex; grants: readonly PrivateGrant[];
    configurationRevision: string; ownerEpoch: string;
  }): Promise<readonly DanceFence[]>;
  reconcileOriginal(command: PreparedConsentCommandV1): Promise<ConsentCommandReceiptV1>;
}
type SourceInput = Omit<Parameters<typeof verifyDancePublicationSource>[0], "afterAwait">;
type Fresh = SourceInput & {
  db: D1Database; journal: DancePublicationJournal; original: Admission;
  releaseSelectionSha256: Hex;
};
/** Receipt FIRST. Pending/unknown/refused/recorded all retain their original
 * command; none fall through to a new permission query or another send. */
export async function resolveDancePublication(input:
  { originalCommand: PreparedConsentCommandV1; journal: DancePublicationJournal } |
  { fresh: Fresh }) {
  if ("originalCommand" in input) {
    const original = structuredClone(input.originalCommand);
    const expected = canonical(original);
    Object.freeze(original.source); Object.freeze(original.message); Object.freeze(original);
    const supplied = structuredClone(original);
    const receipt = structuredClone(await input.journal.reconcileOriginal(supplied));
    insist(canonical(supplied) === expected && canonical(original) === expected,
      "dance_publication_command_mutated", 503);
    insist(receipt.commandId === original.commandId && receipt.digest === original.digest &&
      receipt.action === original.action && receipt.purpose === original.message.purpose &&
      canonical(receipt.source) === canonical(original.source),
      "dance_publication_receipt_mismatch", 503);
    if (receipt.state === "recorded" || receipt.state === "reverted") {
      consentDigest(receipt.transactionHash);
      consentDigest(receipt.observed.blockHash);
      consentUint64(receipt.observed.blockNumber);
      consentUint64(receipt.observed.timestampS);
      insist(Number.isSafeInteger(receipt.transactionIndex) && receipt.transactionIndex >= 0,
        "dance_publication_receipt_mismatch", 503);
    }
    return { kind: "original-command" as const, original, receipt };
  }
  return readDancePublicationAdmission(input.fresh);
}
/** Fresh admission observations + predicates, never a permission boolean.
 * Caller MUST reuse fences in its accepting batch together with original
 * command/capture/role/rules/media guards. This function never sends or journals. */
export async function readDancePublicationAdmission(input: Fresh) {
  const { client, journal, db } = input, clock = { ...input.clock };
  const data = structuredClone({ selected: input.selected, profile: input.profile,
    config: input.config, caller: input.caller, owner: input.owner,
    original: input.original, releaseSelectionSha256: input.releaseSelectionSha256 });
  try {
    insist(journal && journal.db === db && typeof journal.acceptanceFences === "function",
      "dance_publication_journal_unavailable", 503);
    const req = data.original, c = req.capture;
    const plan = dancePublicationChecks(data.selected, req.kind === "capture" ?
      { kind: "capture", capture: c } : { kind: "review", capture: c, reviewer: req.decision });
    const privateGrants = req.kind === "capture" ? [req.learner] : [req.learner, req.reviewer];
    const accounts = privateGrants.map(g => danceId(g.accountId));
    const expectedSource = { schema: "pirate.publication-source/1" as const, resultsVersion: 5 as const,
      chainId: data.config.chainId, communityId: data.selected.domain.communityId,
      installationId: data.config.installationId, directory: data.selected.pin.directory,
      directoryRuntimeHash: data.selected.pin.directoryRuntimeHash,
      registry: data.selected.pin.consentRegistry, registryRuntimeHash: data.selected.pin.consentRegistryRuntimeHash,
      releaseSelectionSha256: consentDigest(data.releaseSelectionSha256) };
    insist(privateGrants.length === plan.calls.length, "dance_publication_subjects_changed", 503);
    for (const [i, item] of privateGrants.entries()) {
      const b = item.binding, call = plan.calls[i], g = parsePublicationGrant(b.grant);
      consentUint64(b.localFenceGeneration);
      insist(b.schema === "pirate.bound-publication-grant/1" &&
        canonical(b.source) === canonical(expectedSource) && b.grantId === call.args[0] &&
        g.purpose === call.purpose && g.learner === call.args[1] &&
        g.publicationTarget === call.args[3] && g.policyHash === call.args[4] &&
        consentUint64(b.boundAtS) === call.args[5] &&
        consentUint64(b.recordedAtS) > 0n && consentUint64(b.recordedAtS) <= call.args[5],
        "dance_publication_original_changed", 403);
    }
    const fences = structuredClone(await journal.acceptanceFences({
      captureHash: plan.captureHash, grants: structuredClone(privateGrants),
      configurationRevision: String(data.config.configurationRevision), ownerEpoch: data.owner.epoch.toString(),
    })).map(validateFence);
    insist(fences.length > 0, "dance_publication_fences_missing", 503);
    const store = new DanceStore(db);
    const windows: { start: bigint; end: bigint }[] = [];
    let lastNow = 0n;
    let expiresAtMs = Number.MAX_SAFE_INTEGER;
    const assertLeaseTime = () => {
      const now = clock.now();
      insist(typeof now === "bigint" && now >= lastNow, "dance_clock_invalid", 503);
      lastNow = now;
      insist(windows.every(w => w.start <= now && now < w.end),
        "dance_publication_lease_expired", 403);
    };
    const addWindow = (start: bigint, end: bigint) => {
      insist(start >= 0n && start < end && end * 1000n <= 9_007_199_254_740_991n,
        "dance_publication_lease_invalid", 503);
      windows.push({ start, end });
      const endMs = Number(end * 1000n);
      expiresAtMs = Math.min(expiresAtMs, endMs);
      // Concrete accepting-batch DB clock guard, independent of safe-block time.
      fences.push({ sql: "(" + DANCE_DB_NOW + ">=? AND " + DANCE_DB_NOW + "<?)",
        values: [Number(start * 1000n), endMs] });
      assertLeaseTime();
    };
    const afterAwait = async () => {
      assertLeaseTime();
      try { await store.assert(fences); }
      catch (error) {
        if (error instanceof CommunityError && error.code === "dance_fence_changed")
          throw new CommunityError("dance_publication_local_changed", 403);
        throw error;
      }
      assertLeaseTime();
    };
    await afterAwait();
    const proof = await verifyDancePublicationSource({ ...data, client, clock, afterAwait });
    await afterAwait();
    const { source: s, config, anchor: a, at, owner } = proof;
    addWindow(owner[4] > a.timestamp ? owner[4] : a.timestamp, proof.expiresAtS);
    const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    insist(danceAccountCommitment(s.domain, accounts[0], c.learner) === c.accountCommitment,
      "dance_private_account_changed", 403);
    if (req.kind === "review") {
      const d = req.decision;
      insist(accounts[0] !== accounts[1] && !eq(d.reviewerWallet, c.learner) &&
        d.reviewerAccountCommitment !== c.accountCommitment && d.reviewerGroupId !== c.groupId &&
        danceAccountCommitment(s.domain, accounts[1], d.reviewerWallet) === d.reviewerAccountCommitment &&
        d.expectedOwnerEpoch === owner[0] && d.expectedConfigurationRevision === BigInt(config.configurationRevision),
        "dance_reviewer_context_changed", 403);
      if (eq(d.reviewerWallet, owner[3])) {
        insist(d.expectedReviewerRoleEpoch === owner[0], "dance_owner_role_changed", 403);
      } else {
        const role = await client.readContract({ address: s.domain.verifier, abi: danceVerdictsAbi,
          functionName: "reviewerRoles", args: [d.reviewerWallet], ...at });
        await afterAwait();
        insist(role[3] && role[0] === d.expectedReviewerRoleEpoch && role[1] === owner[0] &&
          a.timestamp < role[2], "dance_reviewer_role_changed", 403);
        addWindow(a.timestamp, role[2]);
      }
    }
    const observations = [];
    for (const [i, call] of plan.calls.entries()) {
      assertLeaseTime();
      insist(call.args[5] <= lastNow, "dance_publication_original_changed", 403);
      // Preserve the actual start while a newer canonical observation arrives.
      // Safe-block lag is temporary; it must never cause a backdated binding.
      insist(call.args[5] <= a.timestamp, "dance_publication_observation_pending", 503);
      const r = { address: s.pin.consentRegistry, abi: publicationConsentAbi, ...at } as const;
      const [[allowed, reason], [revision, purpose], [g, recordedAt]] = await Promise.all([
        client.readContract({ ...r, functionName: "checkGrant", args: call.args }),
        client.readContract({ ...r, functionName: "purpose", args: [call.args[2]] }),
        client.readContract({ ...r, functionName: "grantOf", args: [call.args[0]] }),
      ]);
      await afterAwait();
      insist(allowed && reason === 0, "dance_publication_grant_denied", 403);
      const b = privateGrants[i].binding, parsed = parsePublicationGrant(b.grant);
      const exact = { ...g, learner: g.learner.toLowerCase(), publicationTarget: g.publicationTarget.toLowerCase(),
        permissionRevision: g.permissionRevision.toString(), withdrawalEpoch: g.withdrawalEpoch.toString(),
        issuedAt: g.issuedAt.toString(), validAfter: g.validAfter.toString(),
        expiresAt: g.expiresAt.toString(), submitBefore: g.submitBefore.toString() };
      insist(purpose.enabled && revision > 0n && eq(purpose.target, s.domain.verifier) &&
        purpose.runtimeHash === s.pin.runtimeCodeHash && purpose.policyHash === call.args[4] &&
        purpose.maxGrantDurationSeconds > 0n && purpose.maxSubmissionDelaySeconds > 0n &&
        g.permissionRevision === revision && canonical(exact) === canonical(b.grant) &&
        recordedAt === consentUint64(b.recordedAtS) && recordedAt <= call.args[5] &&
        g.validAfter <= call.args[5] && a.timestamp < g.expiresAt &&
        hashTypedData({ domain: publicationDomain(s.domain.chainId, s.pin.consentRegistry),
          types: publicationConsentTypes, primaryType: "PublicationGrant", message: parsed }) === call.args[0],
        "dance_publication_original_changed", 403);
      addWindow(recordedAt > g.validAfter ? recordedAt : g.validAfter, g.expiresAt);
      observations.push({ binding: structuredClone(b),
        observed: { blockNumber: a.number.toString(), blockHash: a.hash, timestampS: a.timestamp.toString() } });
    }
    await proof.finish(); await afterAwait();
    const result = { kind: "canonical-read/2" as const, sourceHash: s.sourceHash, captureHash: plan.captureHash,
      anchor: structuredClone(a), observations, fences, expiresAtMs };
    assertLeaseTime();
    return result;
  } catch (error) {
    if (error instanceof CommunityError) throw error;
    throw new CommunityError("dance_publication_unavailable", 503);
  }
}
