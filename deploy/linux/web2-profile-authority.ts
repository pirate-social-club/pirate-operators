import assert from "node:assert/strict";
import {
  keccak256,
  serializeTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  canonical,
  exact,
  insist,
  object,
} from "../../packages/community/common.ts";
import { address } from "../../packages/community/manifest-core.ts";
import {
  directoryV3Abi,
  parseWeb2ProfileDocument,
  web2ProfileDocument,
} from "../../packages/community/web2-directory.ts";
import { readWeb2Community } from "../../packages/community/web2-directory-reader.ts";
import {
  bindWeb2RegistrationTransaction,
  observeWeb2Registration,
  prepareWeb2Registration,
} from "../../packages/community/web2-registration-chain.ts";
import {
  enrollmentDocument,
  enrollmentTypedData,
  parseEnrollment,
} from "../../packages/community/hosted-enrollment.ts";
import { verifyAccountTypedData } from "../../packages/community/account-signature-verifier.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";
import {
  linuxWeb2DraftFrom,
  type LinuxWeb2Draft,
} from "../../packages/community-setup/linux-web2-profile.ts";
import {
  canonicalDigest,
  readPrivateJSON,
  verifyRecord,
  type SignedRecord,
  type TrustAnchor,
} from "./installed-records.ts";

/** Host-issued admission, stored privately. Never accepted from a browser. */
export interface Web2HostAdmission {
  schema: "pirate.linux-web2-host-admission/1";
  installationId: string;
  directoryInstallationId: Hex;
  communityId: Hex;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  hostFingerprint: string;
  releaseArtifactDigest: string;
  targetDigest: string;
  draftDigest: string;
  revokedPlanIds: string[];
}
export interface Web2ChainAuthority {
  client: PublicClient;
  send: IpfsTransport;
  now: () => bigint;
  maxSafeBlockAgeSeconds: bigint;
  /** Exact installed source/deployment allowlist, independent of the draft. */
  deployment: Omit<
    ReturnType<typeof web2ProfileDocument>,
    "communityId" | "communityKey" | "installationId"
  >;
  registrar: Address;
  registrarRevision: bigint;
}
export interface Web2EnrollmentEvidence {
  schema: "pirate.linux-web2-enrollment-evidence/1";
  transactionHash: Hex;
  registrationBlock: string;
  registrationBlockHash: Hex;
  safeBlock: string;
  safeBlockHash: Hex;
  observedAt: string;
  configurationRevision: number;
  configurationSha256: string;
}
/** Controller-authorized pre-registration installation authority. The genuine
 * enrollment document and its controller signature live in the draft; this
 * evidence records the verification outcome at one explicit safe block. */
export interface Web2InstallationAuthorizationEvidence {
  schema: "pirate.linux-web2-installation-authorization/1";
  enrollmentId: Hex;
  controller: Address;
  enrollmentSha256: string;
  expiresAt: string;
  safeBlock: string;
  safeBlockHash: Hex;
  observedAt: string;
  configurationRevision: number;
  configurationSha256: string;
}
export type Web2InstallEnrollment =
  | Web2EnrollmentEvidence
  | Web2InstallationAuthorizationEvidence;
export interface Web2InstallPlan {
  schema: "pirate.linux-web2-install-plan/1";
  planId: string;
  installationId: string;
  durableScope: string;
  generation: number;
  draft: LinuxWeb2Draft;
  releaseArtifactDigest: string;
  releaseSourceDigest: string;
  /** Optional only for retained pre-attachment plans. New owner bindings require it. */
  publishingAttachmentDigest?: Hex;
  targetDigest: string;
  hostFingerprint: string;
  enrollment: Web2InstallEnrollment;
  registrationAuthority: {
    registrar: Address;
    registrarRevision: string;
    maxSafeBlockAgeSeconds: string;
  };
}

export function ownWeb2ChainAuthority(
  input: Web2ChainAuthority,
): Readonly<Web2ChainAuthority> {
  const result = {
    ...input,
    deployment: structuredClone(input.deployment),
    registrar: address(input.registrar),
  };
  assert(typeof result.now === "function" && typeof result.send === "function");
  assert(
    typeof result.maxSafeBlockAgeSeconds === "bigint" &&
      result.maxSafeBlockAgeSeconds > 0n &&
      result.maxSafeBlockAgeSeconds < 2n ** 64n,
    "explicit_install_freshness_required",
  );
  assert(
    typeof result.registrarRevision === "bigint" &&
      result.registrarRevision > 0n &&
      result.registrarRevision < 2n ** 64n,
  );
  Object.freeze(result.deployment);
  return Object.freeze(result);
}

/** Reconstruct the genuine signed chain transaction using its signature fields.
 * This reuses the owning registration authenticator, not the JSON status receipt. */
export async function authenticateWeb2Enrollment(
  input: Web2ChainAuthority,
  value: unknown,
): Promise<Web2EnrollmentEvidence> {
  const authority = ownWeb2ChainAuthority(input),
    draft = linuxWeb2DraftFrom(value);
  const p = parseWeb2ProfileDocument(draft.enrollment.profile);
  const {
    communityId: _community,
    communityKey: _key,
    installationId: _install,
    ...deployment
  } = draft.enrollment.profile;
  insist(
    canonical(deployment) === canonical(authority.deployment),
    "unadmitted_install_deployment",
    503,
  );
  const original = draft.enrollment.operations.find(
    (op) => op.kind === "registration",
  );
  insist(
    original &&
      original.state === "consumed" &&
      original.transactionHash &&
      original.receipt !== null,
    "registration_not_confirmed",
  );
  const expectedHash = original.transactionHash;
  const tx = await authority.client.getTransaction({ hash: expectedHash });
  insist(
    tx.type === "eip1559" &&
      tx.hash === expectedHash &&
      tx.to !== null &&
      tx.blockHash !== null,
    "original_install_transaction_unavailable",
    503,
  );
  const raw = serializeTransaction(
    {
      type: "eip1559",
      chainId: tx.chainId,
      nonce: tx.nonce,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      to: tx.to,
      value: tx.value,
      data: tx.input,
      accessList: tx.accessList,
    },
    { r: tx.r, s: tx.s, v: tx.v },
  );
  insist(
    keccak256(raw) === expectedHash,
    "original_install_transaction_mismatch",
    503,
  );
  const plan = prepareWeb2Registration(
    p,
    draft.configuration,
    draft.enrollment.configurationUri,
    authority.registrar,
    authority.registrarRevision,
  );
  const operation = await bindWeb2RegistrationTransaction(plan, raw, {
    nonce: tx.nonce,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  });
  const observed = await observeWeb2Registration(authority.client, operation);
  insist(
    observed.status === "consumed",
    "original_install_registration_not_safe",
    503,
  );
  const current = await readWeb2Community(
    authority.client,
    p,
    {
      now: authority.now,
      maxSafeBlockAgeSeconds: authority.maxSafeBlockAgeSeconds,
    },
    authority.send,
  );
  // An unlisted community is installable. Unavailable evidence is not authority.
  insist(
    current.eligibility.status === "available",
    "install_directory_unavailable",
    503,
  );
  const c = current.config;
  insist(
    canonical(c) === canonical(draft.configuration) &&
      c.configurationRevision === draft.configuration.configurationRevision &&
      c.controller === draft.configuration.controller &&
      c.publisher === draft.configuration.publisher &&
      c.app.origin === draft.origin &&
      c.postsContract === draft.configuration.postsContract &&
      c.learningRecords === "0x0000000000000000000000000000000000000000",
    "install_current_authority_changed",
    409,
  );
  const code = await authority.client.getCode({
    address: draft.deployment.posts.address,
    blockNumber: current.blockNumber,
  });
  insist(
    code &&
      keccak256(code) === draft.deployment.posts.runtimeCodeHash &&
      current.blockNumber >= BigInt(draft.deployment.posts.deploymentBlock),
    "install_posts_source_changed",
    503,
  );
  const [registration, safe] = await Promise.all([
    authority.client.getBlock({ blockNumber: observed.receipt.blockNumber }),
    authority.client.getBlock({ blockNumber: current.blockNumber }),
  ]);
  insist(
    registration.hash === observed.receipt.blockHash &&
      safe.hash === current.blockHash,
    "install_chain_reorganized",
    503,
  );
  const now = authority.now();
  insist(
    now >= current.verificationSnapshot.capturedAt &&
      now >= safe.timestamp &&
      now - safe.timestamp <= authority.maxSafeBlockAgeSeconds,
    "install_authority_expired_during_read",
    503,
  );
  return {
    schema: "pirate.linux-web2-enrollment-evidence/1",
    transactionHash: expectedHash,
    registrationBlock: String(observed.receipt.blockNumber),
    registrationBlockHash: observed.receipt.blockHash,
    safeBlock: String(current.blockNumber),
    safeBlockHash: current.blockHash,
    observedAt: String(now),
    configurationRevision: c.configurationRevision,
    configurationSha256: canonicalDigest(c),
  };
}

/** Pre-registration installation authority: the controller's genuine signature
 * over the exact enrollment the operator approved. The enrollment commits to
 * the same registration plan the draft carries, so installing before the
 * receipt exists never changes what registration will later bind on-chain.
 * This never replaces chain evidence; once registration is consumed the
 * original transaction path in authenticateWeb2Enrollment remains authoritative. */
export async function authenticateWeb2InstallationAuthorization(
  input: Web2ChainAuthority,
  value: unknown,
): Promise<Web2InstallationAuthorizationEvidence> {
  const authority = ownWeb2ChainAuthority(input),
    draft = linuxWeb2DraftFrom(value);
  insist(draft.authorization !== undefined, "registration_not_confirmed");
  const enrollment = parseEnrollment(draft.authorization.enrollment);
  const p = parseWeb2ProfileDocument(draft.enrollment.profile);
  const {
    communityId: _community,
    communityKey: _key,
    installationId: _install,
    ...deployment
  } = draft.enrollment.profile;
  insist(
    canonical(deployment) === canonical(authority.deployment),
    "unadmitted_install_deployment",
    503,
  );
  const plan = prepareWeb2Registration(
    p,
    draft.configuration,
    draft.enrollment.configurationUri,
    authority.registrar,
    authority.registrarRevision,
  );
  insist(
    enrollment.id === draft.enrollment.enrollmentId &&
      enrollment.plan.commitment === plan.commitment &&
      enrollment.plan.registrar === authority.registrar &&
      enrollment.plan.registrarRevision === authority.registrarRevision &&
      canonical(enrollment.plan.config) === canonical(draft.configuration) &&
      enrollment.plan.uri === draft.enrollment.configurationUri,
    "install_enrollment_authorization_changed",
    409,
  );
  const controller = address(draft.configuration.controller);
  insist(
    enrollment.plan.config.controller === controller,
    "install_enrollment_authorization_changed",
    409,
  );
  insist(
    (await authority.client.getChainId()) === p.chainId,
    "wrong_application_chain",
    503,
  );
  const block = await authority.client.getBlock({ blockTag: "safe" });
  const now = authority.now();
  insist(
    block.number !== null &&
      block.hash !== null &&
      block.timestamp <= now &&
      now - block.timestamp <= authority.maxSafeBlockAgeSeconds,
    "install_safe_view_unavailable",
    503,
  );
  insist(
    BigInt(enrollment.expiresAt) > now,
    "install_enrollment_authorization_expired",
    503,
  );
  const code = await authority.client.getCode({
    address: draft.deployment.posts.address,
    blockNumber: block.number,
  });
  insist(
    code &&
      keccak256(code) === draft.deployment.posts.runtimeCodeHash &&
      block.number >= BigInt(draft.deployment.posts.deploymentBlock),
    "install_posts_source_changed",
    503,
  );
  const valid = await verifyAccountTypedData(authority.client, {
    data: enrollmentTypedData(enrollment),
    address: controller,
    signature: draft.authorization.controllerSignature,
    blockNumber: block.number,
  });
  insist(
    (await authority.client.getBlock({ blockNumber: block.number })).hash ===
      block.hash,
    "install_chain_reorganized",
    503,
  );
  insist(valid, "controller_proof_invalid", 403);
  return {
    schema: "pirate.linux-web2-installation-authorization/1",
    enrollmentId: enrollment.id,
    controller,
    enrollmentSha256: canonicalDigest(enrollmentDocument(enrollment)),
    expiresAt: String(enrollment.expiresAt),
    safeBlock: String(block.number),
    safeBlockHash: block.hash,
    observedAt: String(now),
    configurationRevision: draft.configuration.configurationRevision,
    configurationSha256: canonicalDigest(draft.configuration),
  };
}

/** Select the authority evidence appropriate to this exact draft. A consumed
 * registration keeps the stronger chain-transaction path; before that receipt
 * exists the controller-signed enrollment is the only admitted authority. */
export async function authenticateWeb2InstallEnrollment(
  input: Web2ChainAuthority,
  value: unknown,
): Promise<Web2InstallEnrollment> {
  const draft = linuxWeb2DraftFrom(value);
  const original = draft.enrollment.operations.find(
    (op) => op.kind === "registration",
  );
  if (
    original &&
    original.state === "consumed" &&
    original.transactionHash &&
    original.receipt !== null
  )
    return authenticateWeb2Enrollment(input, draft);
  // A Wizard can stop after registration lands but before its hosted receipt is
  // saved. The signed installation original must not be rewritten for that
  // recovery case. Rediscover the community's exact binding event through the
  // safe chain view, then use its transaction hash only as a lookup: the normal
  // enrollment authenticator still reconstructs and validates the transaction,
  // receipt, registration events, safe block and current Directory binding.
  if (draft.authorization !== undefined) {
    const authority = ownWeb2ChainAuthority(input),
      profile = parseWeb2ProfileDocument(draft.enrollment.profile),
      event = directoryV3Abi.find(
        (row) => row.type === "event" && row.name === "CommunityBound",
      );
    assert(event, "directory_binding_event_unavailable");
    const safe = await authority.client.getBlock({ blockTag: "safe" });
    insist(
      safe.number !== null && safe.hash !== null,
      "install_safe_view_unavailable",
      503,
    );
    const logs = await authority.client.getLogs({
      address: profile.directory,
      event,
      args: { communityId: profile.communityId },
      fromBlock: profile.deploymentBlock,
      toBlock: safe.number,
      strict: true,
    });
    insist(logs.length <= 1, "ambiguous_install_registration", 503);
    const discovered = logs[0]?.transactionHash;
    if (discovered) {
      const recovered = linuxWeb2DraftFrom({
        ...draft,
        enrollment: {
          ...draft.enrollment,
          operations: [
            ...draft.enrollment.operations.filter(
              (op) => op.kind !== "registration",
            ),
            {
              kind: "registration",
              state: "consumed",
              transactionHash: discovered,
              receipt: { discovered: true },
            },
          ],
        },
      });
      return authenticateWeb2Enrollment(input, recovered);
    }
  }
  return authenticateWeb2InstallationAuthorization(input, draft);
}

export async function readWeb2HostAdmission(input: {
  path: string;
  trust: TrustAnchor;
  now: () => number;
  installationId: string;
  draft: LinuxWeb2Draft;
  releaseArtifactDigest: string;
  targetDigest: string;
  hostFingerprint: string;
  minimumGeneration: number;
  planId?: string;
}): Promise<Web2HostAdmission> {
  const { now, ...fields } = input,
    captured = structuredClone(fields);
  const record = await readPrivateJSON<SignedRecord<Web2HostAdmission>>(
    captured.path,
  );
  const body = verifyRecord(record, captured.trust),
    row = object(body);
  exact(row, [
    "schema",
    "installationId",
    "directoryInstallationId",
    "communityId",
    "generation",
    "issuedAt",
    "expiresAt",
    "hostFingerprint",
    "releaseArtifactDigest",
    "targetDigest",
    "draftDigest",
    "revokedPlanIds",
  ]);
  assert(
    body.schema === "pirate.linux-web2-host-admission/1" &&
      body.installationId === captured.installationId &&
      body.directoryInstallationId ===
        captured.draft.enrollment.installationId &&
      body.communityId === captured.draft.enrollment.communityId &&
      body.draftDigest === canonicalDigest(captured.draft) &&
      body.releaseArtifactDigest === captured.releaseArtifactDigest &&
      body.targetDigest === captured.targetDigest &&
      body.hostFingerprint === captured.hostFingerprint,
    "web2_host_admission_binding_changed",
  );
  const checkedAt = now();
  assert(
    Number.isSafeInteger(checkedAt) &&
      Number.isSafeInteger(body.generation) &&
      body.generation >= captured.minimumGeneration &&
      body.generation > 0 &&
      Number.isSafeInteger(body.issuedAt) &&
      Number.isSafeInteger(body.expiresAt) &&
      body.issuedAt <= checkedAt &&
      checkedAt < body.expiresAt,
    "web2_host_admission_expired",
  );
  assert(
    Array.isArray(body.revokedPlanIds) &&
      body.revokedPlanIds.every((x) => typeof x === "string") &&
      (!captured.planId || !body.revokedPlanIds.includes(captured.planId)),
    "web2_install_plan_revoked",
  );
  return structuredClone(body);
}
