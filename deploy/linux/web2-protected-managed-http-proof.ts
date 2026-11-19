import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { recoverTypedDataAddress, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { bytes32, canonical, exact, hashJson, object } from "../../packages/community/common.ts";
import { isHistoricalConfiguration, type CommunityConfig } from "../../packages/community/config-manifest.ts";
import { validateLyrics } from "../../packages/community/lyric-manifest.ts";
import { address } from "../../packages/community/manifest-core.ts";
import { catalogOwner } from "../../packages/community/owner-policy.ts";
import { evidenceDomain } from "../../packages/moderation/evidence.ts";
import { serviceRequestTypes, signServiceRequest, type ServiceAuthorization } from "../../packages/moderation/pairing.ts";
import {
  recognitionDomain, recognitionRequestTypes, signRecognitionRequest, type RecognitionAuthorization,
} from "../../packages/recognition/authorization.ts";
import { acceptedIntent, recognitionProfile, reservationId, type AcceptedIntent, type RecognitionProfile } from "../../packages/recognition/intent.ts";
import {
  verifyProtectedCatalogOriginal, verifyProtectedCatalogCanonical, type ProtectedCatalogSelection,
} from "../../packages/recognition/protected-catalog.ts";
import { pinOperationId } from "../../packages/release/artifacts.ts";
import type { ReleaseContext } from "../../packages/release/authority.ts";
import { validateOwnerGrant, type OwnerBudgetGrant } from "../../packages/release/owner-grant.ts";
import { ownerReleaseKey, requireOwnerGrantScope } from "../../packages/release/owner-release.ts";
import { createJSON, privateDirectory } from "./backend-state.ts";
import { readPrivateJSON } from "./installed-records.ts";

const routes = {
  release_pin: "/v1/owner-releases/pin",
  release_pin_status: "/v1/owner-releases/pin/status",
  intent_reserve: "/v1/reservations",
  intent_status: "/v1/reservations/status",
  intent_bind: "/v1/reservations/bind",
  intent_commit: "/v1/reservations/commit",
} as const;
const pinRoles = ["audio", "lyrics", "post_manifest"] as const;
const pinSteps = { audio: "pin_audio", lyrics: "pin_lyrics", post_manifest: "pin_manifest" } as const;
type AppStep = (typeof pinSteps)[keyof typeof pinSteps] | "catalog_reserve" | "publication" | "catalog_confirm";
const stageCommunity = "https://staging.jazleeuw.club";
const stagePublishing = "https://pirate-managed-publishing-staging.piratesocialclub.workers.dev";
const stageRecognition = "https://pirate-managed-publishing-staging-recognition.piratesocialclub.workers.dev";
const stageInstallation = "pirate-staging-web2-6343-01";
const stageKeyReference = "staging-fluence-web2-publisher-6343";
const wireLimit = 64 * 1024;
type Action = keyof typeof routes;
type PinSubject = {
  action: "release_pin" | "release_pin_status";
  context: ReleaseContext;
  role: (typeof pinRoles)[number];
};
type RecognitionSubject = {
  action: "intent_reserve" | "intent_status";
  intent: AcceptedIntent;
  profile: RecognitionProfile;
};
type PostingEvidence = {
  intent: AcceptedIntent;
  profile: RecognitionProfile;
  posting: unknown;
  original: unknown;
};
type PostingSubject = PostingEvidence & (
  { action: "intent_bind"; readyReceipt: unknown } |
  { action: "intent_commit"; canonical: unknown; retainedReadyReceipt: unknown }
);
export type ProtectedManagedRequestSubject = PinSubject | RecognitionSubject | PostingSubject;
export interface ProtectedManagedHttpSelection {
  hostInstallationId: string;
  serviceOperationId: string;
  leaseIntentSha256: string;
  keyReference: string;
  generation: number;
  configuration: CommunityConfig;
  grant: OwnerBudgetGrant;
  subject: ProtectedManagedRequestSubject;
  applicationStep: AppStep;
  applicationOperationId: Hex;
  applicationRequestHash: Hex;
  nonce: Hex;
  /** HTTP authorization uses whole Unix seconds. */
  issuedAt: number;
  expiresAt: number;
}

export interface ProtectedManagedProofReference {
  schema: "pirate.protected-managed-http-proof-request/1";
  action: Action;
  hostInstallationId: string;
  serviceOperationId: string;
  leaseIntentSha256: string;
  operationId: Hex;
  nonce: Hex;
  bodySha256: Hex;
  expiresAt: number;
}
type Wire = {
  authorization: ServiceAuthorization | RecognitionAuthorization;
  body: Record<string, unknown>;
  signature: Hex;
};
type Selection = Readonly<{
  reference: ProtectedManagedProofReference;
  selectedSha256: Hex;
  configurationSha256: Hex;
  grantSha256: Hex;
  publisher: Hex;
  applicationOperationId: Hex;
  applicationRequestHash: Hex;
}>;
type Clock = () => number;

function pinContext(value: ReleaseContext, grant: OwnerBudgetGrant, config: CommunityConfig) {
  const context = object(value);
  exact(context, ["jobId", "admissionId", "postId", "authorId", "recipient", "lineage", "lyrics", "rating"]);
  assert(typeof context.jobId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(context.jobId) &&
    context.lineage === "root" && (context.rating === "general" || context.rating === "adult"),
  "managed_proof_context_invalid");
  for (const field of ["admissionId", "postId", "authorId"]) bytes32(context[field]);
  assert(address(context.recipient) === grant.ownerWallet, "managed_proof_recipient_changed");
  const lyrics = validateLyrics(context.lyrics);
  assert(lyrics.communityId === config.communityId && lyrics.chainId === 6343 &&
    lyrics.postsContract === config.postsContract && lyrics.postId === context.postId &&
    canonical(lyrics) === canonical(context.lyrics), "managed_proof_lyrics_changed");
  return context;
}

function typedFields<T extends Wire["authorization"]>(a: T) {
  return {
    ...a,
    configurationRevision: BigInt(a.configurationRevision),
    issuedAt: BigInt(a.issuedAt),
    expiresAt: BigInt(a.expiresAt),
  };
}

async function verifyWire(input: unknown, authorization: Wire["authorization"], body: Wire["body"], publisher: Hex) {
  const wire = object(input);
  exact(wire, ["authorization", "body", "signature"]);
  assert(canonical(wire.authorization) === canonical(authorization) &&
    canonical(wire.body) === canonical(body) &&
    typeof wire.signature === "string" && /^0x[0-9a-f]{130}(?![\s\S])/.test(wire.signature),
  "managed_proof_wire_changed");
  const signature = wire.signature as Hex;
  const actual = "requestSha256" in authorization
    ? await recoverTypedDataAddress({ domain: evidenceDomain, types: serviceRequestTypes,
      primaryType: "ServiceRequest", message: typedFields(authorization), signature })
    : await recoverTypedDataAddress({ domain: recognitionDomain, types: recognitionRequestTypes,
      primaryType: "RecognitionRequest", message: typedFields(authorization), signature });
  assert(actual.toLowerCase() === publisher, "managed_proof_signature_changed");
  return { authorization, body, signature };
}

function absent(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Runs inside the publisher custodian. A selected original is one operation,
 * one purpose, one canonical body, one nonce and one expiration. The mount
 * must supply independent current admission and an exclusive held lease. */
export function createProtectedManagedHttpProof(input: {
  selected: ProtectedManagedHttpSelection;
  journalDirectory: string;
  assertCurrent(selection: Selection): Promise<void>;
  /** Independently read the admitted native original. Required for bind and commit. */
  readCurrentCatalog?(selection: Selection): Promise<ProtectedCatalogSelection>;
  assertHeldSync(): { serviceOperationId: string; leaseIntentSha256: string; expiresAtMs: number };
  withPublisher<T>(reference: string, generation: number, use: (account: PrivateKeyAccount) => Promise<T>): Promise<T>;
  now?: Clock;
}) {
  const selected = structuredClone(input.selected);
  const { subject, configuration: config } = selected;
  const grant = validateOwnerGrant(selected.grant);
  requireOwnerGrantScope(grant, config);
  assert(selected.hostInstallationId === stageInstallation && !isHistoricalConfiguration(config) &&
    config.chainId === 6343 && config.app.origin === stageCommunity && catalogOwner(config.policies.admission) &&
    selected.keyReference === stageKeyReference && selected.generation === 1 &&
    /^web2-service-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(selected.serviceOperationId) &&
    /^[a-f0-9]{64}(?![\s\S])/.test(selected.leaseIntentSha256), "managed_proof_installation_changed");
  assert(Object.hasOwn(routes, subject.action), "managed_proof_action_refused");
  const nonce = bytes32(selected.nonce);
  const publisher = address(config.publisher);
  const pin = "context" in subject;
  const { issuedAt, expiresAt } = selected;
  const issuedAtMs = issuedAt * 1000, expiresAtMs = expiresAt * 1000;
  assert(Number.isSafeInteger(issuedAt) && Number.isSafeInteger(issuedAtMs) && issuedAt >= grant.validFrom &&
    Number.isSafeInteger(expiresAt) && Number.isSafeInteger(expiresAtMs) && expiresAt > issuedAt &&
    expiresAt <= grant.expiresAt && expiresAt - issuedAt <= (pin ? 300 : 120),
  "managed_proof_expiry_invalid");

  let authorization: Wire["authorization"];
  let body: Wire["body"];
  let operationId: Hex;
  let jobId: string;
  let acceptedAtMs = 0;
  const base = {
    communityId: bytes32(config.communityId), communityOrigin: config.app.origin,
    configurationRevision: config.configurationRevision, publisher, nonce, issuedAt, expiresAt,
  };
  if (pin) {
    assert(subject.action === "release_pin" || subject.action === "release_pin_status",
      "managed_proof_action_refused");
    assert(pinRoles.includes(subject.role), "managed_proof_role_refused");
    assert(selected.applicationStep === pinSteps[subject.role], "managed_proof_application_step_changed");
    const context = pinContext(subject.context, grant, config);
    body = { context, role: subject.role };
    jobId = subject.context.jobId;
    operationId = pinOperationId(ownerReleaseKey(grant, jobId), subject.role);
    authorization = { ...base, action: subject.action, serviceOrigin: stagePublishing, requestSha256: hashJson(body) };
  } else {
    assert(subject.action === "intent_reserve" || subject.action === "intent_status" ||
      subject.action === "intent_bind" || subject.action === "intent_commit", "managed_proof_action_refused");
    const profile = recognitionProfile(subject.profile);
    const intent = acceptedIntent(subject.intent);
    // The stored application intent preserves the millisecond seal time.
    acceptedAtMs = intent.acceptedAt;
    assert(profile.origin === stageRecognition && intent.namespace === profile.namespace &&
      intent.profileSha256 === profile.sha256 && intent.communityId === config.communityId &&
      intent.communityOrigin === config.app.origin && intent.configurationRevision === config.configurationRevision &&
      intent.publicationRevision === 1 && Math.floor(acceptedAtMs / 1000) <= issuedAt, "managed_proof_intent_changed");
    const needsPosting = subject.action === "intent_bind" || subject.action === "intent_commit";
    assert(needsPosting === ("posting" in subject), "managed_proof_native_posting_required");
    const expectedStep = subject.action === "intent_reserve" ? "catalog_reserve"
      : subject.action === "intent_bind" ? "publication"
      : subject.action === "intent_commit" ? "catalog_confirm" : selected.applicationStep;
    assert(selected.applicationStep === expectedStep &&
      (["catalog_reserve", "publication", "catalog_confirm", ...Object.values(pinSteps)]).includes(expectedStep),
    "managed_proof_application_step_changed");
    body = subject.action === "intent_bind"
      ? { jobId: intent.jobId, posting: subject.posting, original: subject.original, readyReceipt: subject.readyReceipt }
      : subject.action === "intent_commit"
        ? { jobId: intent.jobId, posting: subject.posting, original: subject.original, canonical: subject.canonical }
        : { jobId: intent.jobId };
    jobId = intent.jobId;
    operationId = reservationId(intent);
    authorization = {
      ...base, action: subject.action, namespace: bytes32(profile.namespace), profileSha256: bytes32(profile.sha256),
      serviceOrigin: profile.origin, bodySha256: hashJson(body),
    };
  }
  assert(selected.applicationOperationId === hashJson({ job: jobId, step: selected.applicationStep }),
    "managed_proof_application_original_changed");
  assert(Buffer.byteLength(canonical({ authorization, body, signature: "0x" + "0".repeat(130) })) < wireLimit,
    "managed_proof_wire_too_large");

  const reference = Object.freeze({
    schema: "pirate.protected-managed-http-proof-request/1" as const,
    action: subject.action, hostInstallationId: selected.hostInstallationId,
    serviceOperationId: selected.serviceOperationId, leaseIntentSha256: selected.leaseIntentSha256,
    operationId, nonce, bodySha256: hashJson(body), expiresAt,
  });
  const scope = Object.freeze({
    reference, configurationSha256: hashJson(config), grantSha256: bytes32(grant.sha256), publisher,
    applicationOperationId: selected.applicationOperationId,
    applicationRequestHash: bytes32(selected.applicationRequestHash),
    selectedSha256: hashJson({ selection: selected, destination: authorization.serviceOrigin + routes[subject.action] }),
  });
  const nonceRecord = hashJson({ publisher, nonce }).slice(2);
  const claimName = nonceRecord + "-intent", proofName = nonceRecord + "-proof";
  const directory = input.journalDirectory;
  const now = input.now ?? Date.now;
  const { assertCurrent, assertHeldSync, readCurrentCatalog, withPublisher } = input;

  function assertLive() {
    const held = assertHeldSync();
    const checkedAtMs = now();
    assert(held.serviceOperationId === selected.serviceOperationId &&
      held.leaseIntentSha256 === selected.leaseIntentSha256, "managed_proof_lease_changed");
    assert(Number.isSafeInteger(checkedAtMs) && Number.isSafeInteger(held.expiresAtMs) &&
      issuedAtMs <= checkedAtMs && checkedAtMs < expiresAtMs && expiresAtMs <= held.expiresAtMs,
    "managed_proof_authority_expired");
    assert(acceptedAtMs <= checkedAtMs, "managed_proof_intent_changed");
  }
  async function assertStillCurrent() {
    assertLive();
    if (subject.action === "intent_bind" || subject.action === "intent_commit") {
      assert(readCurrentCatalog, "managed_proof_catalog_scope_required");
      const catalog = await readCurrentCatalog(scope);
      assert(!isHistoricalConfiguration(config) && catalog.reference.installationId === config.installationId &&
        catalog.grantSha256 === grant.sha256 && catalog.publisher === publisher &&
        catalog.postsContract === config.postsContract && BigInt(catalog.quote.maximumFeeWei) <= BigInt(grant.limits.postFeeWei) &&
        canonical(catalog.recognition) === canonical(subject.profile), "managed_proof_catalog_scope_changed");
      const readyReceipt = subject.action === "intent_bind" ? subject.readyReceipt : subject.retainedReadyReceipt;
      const bound = await verifyProtectedCatalogOriginal({ posting: subject.posting, original: subject.original, readyReceipt },
        catalog, subject.intent, now(), subject.action === "intent_bind");
      if (subject.action === "intent_bind")
        assert(expiresAtMs <= bound.original.payload.bindExpiresAtMs, "managed_proof_authority_expired");
      else
        await verifyProtectedCatalogCanonical(subject.canonical, bound, catalog, subject.intent);
    }
    await assertCurrent(scope);
    assertLive();
  }
  async function readProof() {
    try { return await readPrivateJSON<unknown>(directory + "/" + proofName + ".json", wireLimit); }
    catch (error) {
      if (absent(error)) throw Error("managed_proof_nonce_held");
      throw error;
    }
  }

  return Object.freeze({
    reference,
    async produce(value: unknown) {
      const request = object(structuredClone(value));
      exact(request, Object.keys(reference));
      assert(canonical(request) === canonical(reference), "managed_proof_original_changed");
      await assertStillCurrent();
      await privateDirectory(directory);
      try {
        await createJSON(directory, claimName, scope);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const claim = await readPrivateJSON<unknown>(directory + "/" + claimName + ".json", 8192);
        assert(canonical(claim) === canonical(scope), "managed_proof_nonce_conflict");
        const envelope = await verifyWire(await readProof(), authorization, body, publisher);
        await assertStillCurrent();
        return { url: authorization.serviceOrigin + routes[subject.action], envelope: structuredClone(envelope) };
      }

      await assertStillCurrent();
      let entered = false;
      const signed = await withPublisher(selected.keyReference, selected.generation, async (account) => {
        assert(!entered, "managed_proof_key_reentered");
        entered = true;
        assert(account.address.toLowerCase() === publisher, "managed_proof_publisher_changed");
        await assertStillCurrent();
        assertLive();
        if ("requestSha256" in authorization) {
          const { publisher: _publisher, requestSha256: _digest, ...fields } = authorization;
          return signServiceRequest(account, fields, structuredClone(body));
        }
        const { publisher: _publisher, bodySha256: _digest, ...fields } = authorization;
        return signRecognitionRequest(account, fields, structuredClone(body));
      });
      assert(entered, "managed_proof_key_entry_missing");
      const envelope = await verifyWire(signed, authorization, body, publisher);
      await assertStillCurrent();
      await createJSON(directory, proofName, envelope);
      const persisted = await verifyWire(await readProof(), authorization, body, publisher);
      await assertStillCurrent();
      return { url: authorization.serviceOrigin + routes[subject.action], envelope: structuredClone(persisted) };
    },
  });
}
