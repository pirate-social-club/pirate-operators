import {
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  canonical,
  exact,
  hashText,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import { address, chain } from "./manifest-core.ts";
import { sharedBytes32, directoryInstanceId } from "./shared-identity.ts";
import {
  parseWeb2ProfileDocument,
  web2ProfileDocument,
  type Web2DirectoryProfile,
} from "./web2-directory.ts";
import {
  prepareWeb2Registration,
  type Web2RegistrationPlan,
} from "./web2-registration-chain.ts";

export function wei(value: unknown): bigint {
  insist(
    typeof value === "string" && /^(0|[1-9][0-9]{0,77})(?![\s\S])/.test(value),
    "invalid_wei",
  );
  const n = BigInt(value);
  insist(n < 2n ** 256n, "invalid_wei");
  return n;
}
export function signature(value: unknown): Hex {
  insist(
    typeof value === "string" &&
      /^0x(?:[0-9a-fA-F]{2}){1,16384}(?![\s\S])/.test(value),
    "invalid_signature",
  );
  return value as Hex;
}
export interface HostedPolicy {
  schema: "pirate.hosted-enrollment-policy/1";
  pilotId: string;
  serviceOrigin: string;
  deployment: Omit<
    Web2DirectoryProfile,
    "communityKey" | "communityId" | "installationId"
  >;
  registrar: Address;
  funder: Address;
  registrarRevision: string;
  noticeSha256: Hex;
  inviteMaxSeconds: number;
  challengeSeconds: number;
  maxSafeBlockAgeSeconds: number;
  broadcastRetrySeconds: number;
  maxBroadcastAttempts: number;
  registrationGas: string;
  topupGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  extraFeeCeiling: string;
  extraFeeField: "none" | "l1Fee";
  globalCeiling: string;
  communityCeiling: string;
  recipientCeiling: string;
  controllerInitialWei: string;
  publisherInitialWei: string;
}
export function policyDocument(p: HostedPolicy) {
  return {
    ...p,
    deployment: {
      ...p.deployment,
      deploymentBlock: String(p.deployment.deploymentBlock),
    },
  };
}
export function ownPolicy(input: HostedPolicy): Readonly<HostedPolicy> {
  // Copy before any await and keep the closed wire policy immutable.
  const p = structuredClone(input);
  insist(
    p.schema === "pirate.hosted-enrollment-policy/1" &&
      /^[a-z0-9-]{1,64}(?![\s\S])/.test(p.pilotId),
    "invalid_hosted_policy",
  );
  insist(
    new URL(p.serviceOrigin).origin === p.serviceOrigin &&
      new URL(p.serviceOrigin).protocol === "https:",
    "invalid_service_origin",
  );
  p.registrar = address(p.registrar);
  p.funder = address(p.funder);
  sharedBytes32(p.noticeSha256);
  for (const n of [
    p.inviteMaxSeconds,
    p.challengeSeconds,
    p.maxSafeBlockAgeSeconds,
    p.broadcastRetrySeconds,
    p.maxBroadcastAttempts,
  ])
    integer(n, 1, 86400 * 30);
  insist(
    p.challengeSeconds <= p.inviteMaxSeconds,
    "invalid_challenge_lifetime",
  );
  for (const n of [
    p.registrarRevision,
    p.registrationGas,
    p.topupGas,
    p.maxFeePerGas,
    p.maxPriorityFeePerGas,
    p.extraFeeCeiling,
    p.globalCeiling,
    p.communityCeiling,
    p.recipientCeiling,
    p.controllerInitialWei,
    p.publisherInitialWei,
  ])
    wei(n);
  insist(
    wei(p.registrarRevision) > 0n &&
      wei(p.registrarRevision) < 2n ** 64n &&
      wei(p.registrationGas) > 0n &&
      wei(p.topupGas) > 0n &&
      wei(p.maxFeePerGas) > 0n &&
      wei(p.maxPriorityFeePerGas) <= wei(p.maxFeePerGas),
    "invalid_transaction_policy",
  );
  insist(
    p.extraFeeField === "none" || p.extraFeeField === "l1Fee",
    "invalid_extra_fee_policy",
  );
  insist(
    p.extraFeeField !== "none" || p.extraFeeCeiling === "0",
    "extra_fee_policy_conflict",
  );
  Object.freeze(p.deployment);
  return Object.freeze(p);
}
export function parsePolicyDocument(value: unknown): Readonly<HostedPolicy> {
  const p = object(value),
    d = object(p.deployment),
    key = `0x${"1".repeat(64)}` as Hex;
  const full = parseWeb2ProfileDocument({
    ...d,
    communityKey: key,
    installationId: key,
    communityId: directoryInstanceId(chain(d.chainId), key),
  });
  const {
    communityId: _c,
    communityKey: _k,
    installationId: _i,
    ...deployment
  } = full;
  insist(
    p.schema === "pirate.hosted-enrollment-policy/1",
    "invalid_hosted_policy",
  );
  insist(
    p.extraFeeField === "none" || p.extraFeeField === "l1Fee",
    "invalid_extra_fee_policy",
  );
  const result: HostedPolicy = {
    schema: p.schema,
    pilotId: text(p.pilotId, 64),
    serviceOrigin: text(p.serviceOrigin, 512),
    deployment,
    registrar: address(p.registrar),
    funder: address(p.funder),
    registrarRevision: text(p.registrarRevision),
    noticeSha256: sharedBytes32(p.noticeSha256),
    inviteMaxSeconds: integer(p.inviteMaxSeconds, 1, 2592000),
    challengeSeconds: integer(p.challengeSeconds, 1, 2592000),
    maxSafeBlockAgeSeconds: integer(p.maxSafeBlockAgeSeconds, 1, 2592000),
    broadcastRetrySeconds: integer(p.broadcastRetrySeconds, 1, 2592000),
    maxBroadcastAttempts: integer(p.maxBroadcastAttempts, 1, 2592000),
    registrationGas: text(p.registrationGas),
    topupGas: text(p.topupGas),
    maxFeePerGas: text(p.maxFeePerGas),
    maxPriorityFeePerGas: text(p.maxPriorityFeePerGas),
    extraFeeCeiling: text(p.extraFeeCeiling),
    extraFeeField: p.extraFeeField,
    globalCeiling: text(p.globalCeiling),
    communityCeiling: text(p.communityCeiling),
    recipientCeiling: text(p.recipientCeiling),
    controllerInitialWei: text(p.controllerInitialWei),
    publisherInitialWei: text(p.publisherInitialWei),
  };
  exact(p, Object.keys(result));
  return ownPolicy(result);
}
export const policyHash = (p: HostedPolicy) =>
  hashText(canonical(policyDocument(p)));
export function planDocument(p: Web2RegistrationPlan) {
  return {
    profile: web2ProfileDocument(p.profile),
    config: p.config,
    uri: p.uri,
    registrar: p.registrar,
    registrarRevision: String(p.registrarRevision),
    commitment: p.commitment,
  };
}
export function parsePlan(value: unknown): Web2RegistrationPlan {
  const v = object(value);
  exact(v, [
    "profile",
    "config",
    "uri",
    "registrar",
    "registrarRevision",
    "commitment",
  ]);
  insist(typeof v.uri === "string", "invalid_uri");
  const p = prepareWeb2Registration(
    parseWeb2ProfileDocument(v.profile),
    v.config,
    v.uri,
    address(v.registrar),
    wei(v.registrarRevision),
  );
  insist(p.commitment === v.commitment, "saved_plan_changed");
  return p;
}
export interface Enrollment {
  schema: "pirate.hosted-enrollment/1";
  id: Hex;
  inviteId: Hex;
  allowanceId: Hex;
  expiresAt: number;
  policyHash: Hex;
  noticeSha256: Hex;
  plan: Web2RegistrationPlan;
}
export function enrollmentDocument(e: Enrollment) {
  return { ...e, plan: planDocument(e.plan) };
}
export function parseEnrollment(value: unknown): Enrollment {
  const v = object(value);
  exact(v, [
    "schema",
    "id",
    "inviteId",
    "allowanceId",
    "expiresAt",
    "policyHash",
    "noticeSha256",
    "plan",
  ]);
  insist(
    v.schema === "pirate.hosted-enrollment/1",
    "invalid_enrollment_schema",
  );
  return Object.freeze({
    schema: v.schema,
    id: sharedBytes32(v.id),
    inviteId: sharedBytes32(v.inviteId),
    allowanceId: sharedBytes32(v.allowanceId),
    expiresAt: integer(v.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    policyHash: sharedBytes32(v.policyHash),
    noticeSha256: sharedBytes32(v.noticeSha256),
    plan: parsePlan(v.plan),
  });
}
export function assertDeployment(p: HostedPolicy, plan: Web2RegistrationPlan) {
  const {
    communityId: _c,
    communityKey: _k,
    installationId: _i,
    ...d
  } = plan.profile;
  insist(
    canonical({ ...d, deploymentBlock: String(d.deploymentBlock) }) ===
      canonical({
        ...p.deployment,
        deploymentBlock: String(p.deployment.deploymentBlock),
      }),
    "unaccepted_hosted_deployment",
  );
  insist(
    plan.registrar === p.registrar &&
      plan.registrarRevision === wei(p.registrarRevision),
    "unaccepted_registrar",
  );
}
export function enrollmentTypedData(e: Enrollment) {
  const p = e.plan;
  return {
    domain: {
      name: "Pirate Hosted Enrollment",
      version: "1",
      chainId: p.profile.chainId,
      verifyingContract: p.profile.directory,
    },
    primaryType: "HostedEnrollment" as const,
    types: {
      HostedEnrollment: [
        { name: "enrollmentId", type: "bytes32" },
        { name: "inviteId", type: "bytes32" },
        { name: "allowanceId", type: "bytes32" },
        { name: "communityKey", type: "bytes32" },
        { name: "installationId", type: "bytes32" },
        { name: "controller", type: "address" },
        { name: "publisher", type: "address" },
        { name: "origin", type: "string" },
        { name: "configurationUri", type: "string" },
        { name: "registrationCommitment", type: "bytes32" },
        { name: "policyHash", type: "bytes32" },
        { name: "noticeSha256", type: "bytes32" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    message: {
      enrollmentId: e.id,
      inviteId: e.inviteId,
      allowanceId: e.allowanceId,
      communityKey: p.profile.communityKey,
      installationId: p.profile.installationId,
      controller: p.config.controller,
      publisher: p.config.publisher,
      origin: p.config.app.origin,
      configurationUri: p.uri,
      registrationCommitment: p.commitment,
      policyHash: e.policyHash,
      noticeSha256: e.noticeSha256,
      expiresAt: BigInt(e.expiresAt),
    },
  };
}
export async function safeView(
  client: PublicClient,
  p: HostedPolicy,
  clock: () => number,
) {
  insist(
    (await client.getChainId()) === p.deployment.chainId,
    "wrong_application_chain",
  );
  const block = await client.getBlock({ blockTag: "safe" }),
    now = clock();
  insist(
    block.number !== null &&
      block.hash !== null &&
      block.timestamp <= BigInt(now) &&
      BigInt(now) - block.timestamp <= BigInt(p.maxSafeBlockAgeSeconds),
    "hosted_safe_view_unavailable",
    503,
  );
  const code = await client.getCode({
    address: p.deployment.directory,
    blockNumber: block.number,
  });
  insist(
    code &&
      keccak256(code) === p.deployment.directoryCodeHash &&
      block.number >= p.deployment.deploymentBlock,
    "hosted_directory_code_changed",
    503,
  );
  assertFreshBlock(block, p, clock());
  return block;
}
export function assertFreshBlock(
  block: { timestamp: bigint },
  p: HostedPolicy,
  now: number,
) {
  insist(
    Number.isSafeInteger(now) &&
      block.timestamp <= BigInt(now) &&
      BigInt(now) - block.timestamp <= BigInt(p.maxSafeBlockAgeSeconds),
    "hosted_safe_view_unavailable",
    503,
  );
}
export async function verifyEnrollmentProof(
  client: PublicClient,
  p: HostedPolicy,
  e: Enrollment,
  actor: Address,
  sig: Hex,
  clock: () => number,
) {
  const owned = parseEnrollment(enrollmentDocument(e)),
    signer = address(actor),
    proof = signature(sig),
    typed = enrollmentTypedData(owned);
  const block = await safeView(client, p, clock);
  const valid = await client.verifyTypedData({
    ...typed, address: signer, signature: proof, blockNumber: block.number,
  });
  insist(
    (await client.getBlock({ blockNumber: block.number })).hash === block.hash,
    "hosted_chain_reorganized",
    503,
  );
  assertFreshBlock(block, p, clock());
  insist(valid, "controller_proof_invalid", 403);
}
