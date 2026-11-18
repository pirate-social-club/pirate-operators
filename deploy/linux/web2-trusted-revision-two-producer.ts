import assert from "node:assert/strict";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";
import { hashJson } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import { parseWeb2ProfileDocument } from "../../packages/community/web2-directory.ts";
import { readWeb2Community } from "../../packages/community/web2-directory-reader.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { exact, record } from "../../services/publication-command-contract.ts";
import { canonicalDigest, verifyRecord, type SignedRecord } from "./installed-records.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { openTrustedRevisionTwoHostBinding, type Web2TrustedRevisionTwoBinding } from "./web2-expanded-publication.ts";
import type { Web2ChainAuthority, Web2EnrollmentEvidence } from "./web2-profile-authority.ts";
import { optionalWeb2Record, retainWeb2Record, type Web2RuntimeBindingPolicy } from "./web2-runtime-binding.ts";
import {
  prepareTrustedRevisionTwoApprovalCheck, readApprovedTrustedRevisionTwo, requireTrustedRevisionTwoResources,
  requireTrustedRevisionTwoStart, trustedRevisionTwoApprovalName, trustedRevisionTwoOriginalPublishing,
  type Web2TrustedRevisionTwoApproval,
} from "./web2-trusted-revision-two.ts";

export type Web2TrustedRevisionTwoIssuer =
  (body: Web2TrustedRevisionTwoApproval) => Promise<SignedRecord<Web2TrustedRevisionTwoApproval>>;

const servedRecord = "web2-trusted-revision-one-served";

export function trustedRevisionOneResourceDigest(
  expected: number, resources: readonly { spec: { key: string }; actual: { Id: string } | null }[],
) {
  requireTrustedRevisionTwoResources(expected, resources);
  const bindings = resources.map(({ spec, actual }) => {
    assert(actual && typeof actual.Id === "string" && /^[a-f0-9]{64}$/.test(actual.Id),
      "trusted_revision_two_original_resource_identity_required");
    return { key: spec.key, id: actual.Id };
  });
  assert(new Set(bindings.map(x => x.key)).size === expected && new Set(bindings.map(x => x.id)).size === expected,
    "trusted_revision_two_original_resource_identity_required");
  return canonicalDigest(bindings);
}

type WitnessScope = {
  graph: NativeGraph;
  original: Web2NativeOriginal;
  policy: Web2RuntimeBindingPolicy;
  resourcesSha256: string;
};

type ServingWitness = ReturnType<typeof witnessScope> & {
  safeBlock: string;
  safeBlockHash: Hex;
};

function witnessScope(input: WitnessScope) {
  return {
    schema: "pirate.web2-trusted-revision-one-served/1",
    nativeOriginalSha256: nativeDigest(input.original),
    graphSha256: canonicalDigest(input.graph),
    policySha256: canonicalDigest(input.policy),
    resourcesSha256: input.resourcesSha256,
  } as const;
}

function checkWitness(witness: ServingWitness, input: WitnessScope) {
  exact(record(witness), [
    "schema", "nativeOriginalSha256", "graphSha256", "policySha256", "resourcesSha256", "safeBlock", "safeBlockHash",
  ]);
  const { safeBlock, safeBlockHash, ...scope } = witness;
  assert(canonicalDigest(scope) === canonicalDigest(witnessScope(input)) &&
    typeof safeBlock === "string" && /^[1-9][0-9]{0,19}$/.test(safeBlock) &&
    BigInt(safeBlock) >= BigInt(input.original.record.body.enrollment.safeBlock) &&
    BigInt(safeBlock) < (1n << 64n) &&
    typeof safeBlockHash === "string" && /^0x[0-9a-f]{64}$/.test(safeBlockHash),
    "trusted_revision_two_original_serving_witness_changed");
}

/** Called only by the successful installed revision-one TLS observation. The
 * owner-private record is bound to the already verified original and controller. */
export async function retainTrustedRevisionOneServingWitness(input: WitnessScope & {
  assertCurrent(): Promise<Web2EnrollmentEvidence>;
}) {
  const directory = input.policy.bindingDirectory;
  await requireTrustedRevisionTwoStart(directory, input.original.record.body);
  const retained = await optionalWeb2Record<ServingWitness>(join(directory, servedRecord + ".json"));
  if (retained) {
    checkWitness(retained, input);
    return;
  }

  const { enrollment } = input.original.record.body, evidence = await input.assertCurrent();
  assert(evidence.configurationRevision === 1 && enrollment.configurationRevision === 1 &&
    evidence.configurationSha256 === enrollment.configurationSha256 &&
    evidence.transactionHash === enrollment.transactionHash &&
    evidence.registrationBlock === enrollment.registrationBlock &&
    evidence.registrationBlockHash === enrollment.registrationBlockHash,
    "trusted_revision_two_original_serving_authority_changed");
  const witness = { ...witnessScope(input), safeBlock: evidence.safeBlock, safeBlockHash: evidence.safeBlockHash };
  checkWitness(witness, input);
  await requireTrustedRevisionTwoStart(directory, input.original.record.body);
  await retainWeb2Record(directory, servedRecord, witness);
}

async function readWitness(directory: string) {
  const witness = await optionalWeb2Record<ServingWitness>(join(directory, servedRecord + ".json"));
  assert(witness, "trusted_revision_two_original_not_served");
  return witness;
}

async function verifyTrustedRevisionOneServingWitness(
  input: WitnessScope, witness: ServingWitness, chain: Web2ChainAuthority, transitionBlock: string,
) {
  checkWitness(witness, input);
  assert(BigInt(witness.safeBlock) < BigInt(transitionBlock), "trusted_revision_two_serving_anchor_not_before_transition");
  const block = await chain.client.getBlock({ blockNumber: BigInt(witness.safeBlock) });
  assert(block.hash === witness.safeBlockHash, "trusted_revision_two_serving_anchor_changed");
}

async function observeTrustedRevisionTwoTransition(chain: Web2ChainAuthority, original: Web2NativeOriginal) {
  const { draft } = original.record.body;
  const current = await readWeb2Community(
    chain.client, parseWeb2ProfileDocument(draft.enrollment.profile),
    { now: chain.now, maxSafeBlockAgeSeconds: chain.maxSafeBlockAgeSeconds }, chain.send,
  );
  const configuration = current.config, event = current.configurationEvidence?.log;
  assert(current.eligibility.status === "available" && configuration.configurationRevision === 2 &&
    event?.args.revision === 2n && configuration.learningRecords !== "0x0000000000000000000000000000000000000000",
    "trusted_revision_two_canonical_transition_required");
  const [genesis, code] = await Promise.all([
    chain.client.getBlock({ blockNumber: 0n }),
    chain.client.getCode({ address: configuration.learningRecords, blockHash: current.blockHash, requireCanonical: true }),
  ]);
  assert(genesis.hash && code && code !== "0x", "trusted_revision_two_canonical_registry_required");
  // The full original history, exact receipt, canonical anchors and allowed
  // configuration delta are checked by the same verifier used on reopen.
  return {
    configuration, configurationSha256: hashJson(configuration),
    transitionTransactionHash: event.transactionHash, transitionBlock: String(event.blockNumber),
    transitionBlockHash: event.blockHash,
    safeBlock: String(current.blockNumber), safeBlockHash: current.blockHash, genesisHash: genesis.hash,
    registry: configuration.learningRecords, registryRuntimeHash: keccak256(code),
  };
}

/** Private host writer. Only the exact installed binding and owner issuer can
 * participate. No request, transaction input or revision-two claim is accepted. */
export async function produceTrustedRevisionTwoApproval(
  binding: Web2TrustedRevisionTwoBinding, issue: Web2TrustedRevisionTwoIssuer,
) {
  return writeTrustedRevisionTwoApproval(await openTrustedRevisionTwoHostBinding(binding), issue);
}

/** The writer consumes an already verified host. The installed entrypoint
 * always obtains that host via the signed artifact and real controller. */
export async function writeTrustedRevisionTwoApproval(
  host: Awaited<ReturnType<typeof openTrustedRevisionTwoHostBinding>>, issue: Web2TrustedRevisionTwoIssuer,
) {
  const { original, release: { graph }, chain, now, lease } = host;
  const input = { graph, original, chain, now };
  const { path, policy, trust, check } = await prepareTrustedRevisionTwoApprovalCheck(input);
  const directory = policy.bindingDirectory, plan = original.record.body;
  await requireTrustedRevisionTwoStart(directory, plan);
  const witness = await readWitness(directory);
  const witnessDigest = canonicalDigest(witness);
  const resources = () => host.inspect().then(rows => trustedRevisionOneResourceDigest(policy.target.containers.length, rows));

  async function assertCurrent(approval: Web2TrustedRevisionTwoApproval) {
    const scope = { graph, original, policy, resourcesSha256: await resources() };
    await verifyTrustedRevisionOneServingWitness(scope, witness, chain, approval.transitionBlock);
    const checked = await check(approval);
    await host.assertRetainedOriginal();
    assert(canonicalDigest(await readWitness(directory)) === witnessDigest,
      "trusted_revision_two_original_serving_witness_changed");
    const admission = await host.admission();
    await lease.assertHeld();
    host.live();
    const time = now();
    assert(approval.expiresAt <= admission.expiresAt && approval.issuedAt <= time && time < approval.expiresAt &&
      checked.live(), "trusted_revision_two_issuer_window_changed");
  }

  const retained = await optionalWeb2Record<SignedRecord<Web2TrustedRevisionTwoApproval>>(path);
  let signed: SignedRecord<Web2TrustedRevisionTwoApproval>;
  if (retained) {
    exact(record(retained), ["schema", "keyId", "body", "signature"]);
    verifyRecord(retained, trust);
    signed = retained;
  } else {
    const admission = await host.admission();
    const transition = await observeTrustedRevisionTwoTransition(chain, original);
    const { ownerWallet, grant } = trustedRevisionTwoOriginalPublishing(graph, original);
    const { enrollment } = plan;
    const approval: Web2TrustedRevisionTwoApproval = {
      schema: "pirate.web2-trusted-revision-two-approval/1",
      nativeOriginalSha256: nativeDigest(original), graphSha256: canonicalDigest(graph), ownerWallet,
      registrationTransactionHash: enrollment.transactionHash, registrationBlock: enrollment.registrationBlock,
      registrationBlockHash: enrollment.registrationBlockHash,
      ...transition,
      issuedAt: Math.max(policy.issuedAt, Math.floor(now() / 1000) * 1000),
      expiresAt: Math.min(policy.expiresAt, admission.expiresAt, grant.expiresAt * 1000),
    };
    assert(await optionalWeb2Record(path) === null, "trusted_revision_two_approval_changed");
    await assertCurrent(approval);
    signed = structuredClone(await issue(structuredClone(approval)));
    exact(record(signed), ["schema", "keyId", "body", "signature"]);
    assert(canonicalDigest(verifyRecord(signed, trust)) === canonicalDigest(approval),
      "trusted_revision_two_issuer_changed_body");
  }
  await assertCurrent(signed.body);
  // The immutable writer refuses a different existing envelope and re-syncs
  // the exact original on reentry. Unreadable or partial records stay held.
  await retainWeb2Record(directory, trustedRevisionTwoApprovalName, signed);
  const accepted = await readApprovedTrustedRevisionTwo(input);
  assert(accepted.approvalSha256 === canonicalDigest(signed), "trusted_revision_two_approval_changed");
  await host.assertRetainedOriginal();
  const admission = await host.admission();
  await lease.assertHeld();
  host.live();
  assert(accepted.approval.expiresAt <= admission.expiresAt &&
    BigInt(accepted.validFrom) <= chain.now() && chain.now() < BigInt(accepted.expiresAt),
    "trusted_revision_two_issuer_window_changed");
  return accepted.approvalSha256;
}
