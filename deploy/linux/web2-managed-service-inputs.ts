/** Installed server-only adapters. No browser JSON, raw-key output, arbitrary
 * signing payload or provisioning/rotation side effect enters these ports. */
import { canonical, CommunityError, exact, hashText, insist, object, text } from "../../packages/community/common.ts";
import { parsePolicyDocument } from "../../packages/community/hosted-enrollment.ts";
import { authenticatedManagedRegistration, selectionFor, type ManagedPublishingRegistration } from "../../packages/release/managed-publishing-admission.ts";
import { configuredGrantSelection, requireGrantObservation } from "./web2-publishing-attachment.ts";
import { createWeb2PublisherProofSigner } from "./web2-publisher-proof.ts";
import { readCanonicalBytes } from "../../packages/recognition/canonical-protocol.ts";
import { signRecord, verifyRecord, type SignedRecord, type TrustAnchor } from "./installed-records.ts";
import type { createManagedKeyClient } from "./managed-key-channel.ts";
import type { OperationLease } from "./backend-state.ts";
import type { ManagedOwnerGrantPort, PublisherProofSigner, GrantAttachmentObservation } from "./web2-operator-inputs.ts";
import { address } from "../../packages/community/manifest-core.ts";

type KeyChannel = Pick<Awaited<ReturnType<typeof createManagedKeyClient>>, "withKey" | "withSecret">;
export interface InstalledWeb2ManagedServiceInputs {
  schema: "pirate.linux-web2-managed-service-inputs/1";
  installationId: string;
  serviceTrust: TrustAnchor;
  registration: SignedRecord<ManagedPublishingRegistration>;
  publisherPolicy: unknown;
}
function installedBody(input: InstalledWeb2ManagedServiceInputs) {
  const body = structuredClone(input); exact(object(body), ["schema", "installationId", "serviceTrust", "registration", "publisherPolicy"]);
  exact(object(body.serviceTrust), ["keyId", "spki"]);
  insist(body.schema === "pirate.linux-web2-managed-service-inputs/1", "managed_installed_inputs_unavailable", 503);
  const r = authenticatedManagedRegistration(body.registration, body.serviceTrust), policy = parsePolicyDocument(body.publisherPolicy);
  insist(body.installationId === r.scope.hostInstallationId && policy.deployment.chainId === 6343 &&
    policy.deployment.directory === r.deployment.directoryProfile.directory && policy.deployment.directoryCodeHash === r.deployment.directoryProfile.directoryCodeHash &&
    policy.deployment.directoryAbiSha256 === r.deployment.directoryProfile.directoryAbiSha256 &&
    policy.deployment.sourceCommit === r.deployment.directoryProfile.sourceCommit &&
    String(policy.deployment.deploymentBlock) === r.deployment.directoryProfile.deploymentBlock,
    "managed_installed_binding_changed", 409);
  return { body, r, policy };
}
/** Callable host provisioning producer. Input authority comes from the signed
 * Pirate registration and the independently installed host signing channel.
 * It adopts existing refs/generations and signs only this validated record. */
export async function provisionWeb2ManagedServiceInputs(input: {
  body: InstalledWeb2ManagedServiceInputs; trust: TrustAnchor;
  signing: Pick<KeyChannel, "withSecret">; keyReference: string; generation: number;
}) {
  const { body } = installedBody(input.body), trust = structuredClone(input.trust),
    ref = text(input.keyReference, 256), generation = input.generation;
  insist(ref.length > 0 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(ref) && Number.isSafeInteger(generation) && generation > 0, "managed_provisioning_custody_unavailable", 503);
  return input.signing.withSecret(ref, generation, async bytes => signRecord(body, trust, bytes));
}
class ManagedTransportUnknown extends Error {
  constructor() { super("managed_service_transport_unknown"); }
}
export async function createWeb2ManagedServiceInputs(input: {
  record: SignedRecord<InstalledWeb2ManagedServiceInputs>;
  trust: TrustAnchor;
  key: KeyChannel;
  lease: OperationLease;
  now(): number;
  currentInstalled(): Promise<SignedRecord<InstalledWeb2ManagedServiceInputs>>;
  transport?: (request: Request) => Promise<Response>;
}): Promise<{ managedGrant: ManagedOwnerGrantPort; publisher: PublisherProofSigner }> {
  const record = structuredClone(input.record), trust = structuredClone(input.trust),
    selected = installedBody(verifyRecord(record, trust)), { body, r, policy } = selected,
    selection = selectionFor(r), custody = structuredClone(r.custody), credential = structuredClone(r.credential);
  insist(input.lease.installationId === body.installationId, "managed_installed_binding_changed", 409);
  async function check() {
    await input.lease.assertHeld();
    const current = installedBody(verifyRecord(await input.currentInstalled(), trust));
    insist(canonical(current.body) === canonical(body) && input.lease.installationId === body.installationId &&
      Number.isSafeInteger(input.now()), "managed_installed_binding_changed", 409);
    await input.lease.assertHeld();
  }
  const publisher = createWeb2PublisherProofSigner({ key: input.key, keyReference: custody.keyReference, generation: custody.generation,
    installationId: body.installationId, publisher: address(custody.publisher), lease: input.lease, policy, now: input.now,
    currentBinding: async () => { await check(); return { keyReference: custody.keyReference, generation: custody.generation,
      installationId: custody.installationId, publisher: address(custody.publisher) }; },
  });
  async function call(action: "prepare" | "attach" | "reconcile", value: unknown) {
    await check();
    return input.key.withSecret(credential.keyReference, credential.generation, async bytes => {
      const secret = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      insist(/^[A-Za-z0-9_-]{32,512}(?![\s\S])/.test(secret) && hashText(secret) === credential.sha256,
        "managed_installation_credential_changed", 409);
      await check();
      const deadline = AbortSignal.timeout(15000), request = new Request(r.serviceOrigin + "/v1/managed-publishing/" + action, {
        method: "POST", redirect: "manual", signal: deadline,
        headers: { "content-type": "application/json", authorization: "Bearer " + secret,
          "x-pirate-installation": body.installationId, "x-pirate-admission": r.admissionReference }, body: canonical(value),
      });
      let response: Response;
      let onAbort: (() => void) | undefined;
      try {
        // Abort bounds the real fetch. The race also bounds a selected transport
        // that does not implement AbortSignal; it cannot authorize a retry.
        response = await Promise.race([(input.transport ?? fetch)(request), new Promise<never>((_, reject) => {
          onAbort = () => reject(new ManagedTransportUnknown());
          if (deadline.aborted) onAbort(); else deadline.addEventListener("abort", onAbort, { once: true });
        })]);
      } catch { await check(); throw new ManagedTransportUnknown(); }
      finally { if (onAbort) deadline.removeEventListener("abort", onAbort); }
      await check();
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ManagedTransportUnknown(); }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500) throw new ManagedTransportUnknown();
        throw new CommunityError("managed_service_refused", response.status);
      }
      insist(response.headers.get("content-type") === "application/json", "managed_service_response_invalid", 503);
      let result: unknown;
      try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readCanonicalBytes(response, 65536, deadline))); }
      catch { await check(); throw new ManagedTransportUnknown(); }
      await check(); deadline.throwIfAborted(); return result;
    });
  }
  const unknown = (): GrantAttachmentObservation => ({ selectionDigest: selection.selectionDigest, grantDigest: r.grant.sha256,
    admissionReference: r.admissionReference, state: "unknown" });
  const observe = async (action: "attach" | "reconcile", digest: Parameters<ManagedOwnerGrantPort["attach"]>[0]) => {
    insist(digest === selection.selectionDigest, "managed_selection_changed", 409);
    try {
      const value = await call(action, { selectionDigest: digest });
      // Runtime validation belongs to the frozen attachment owner.
      return requireGrantObservation(JSON.parse(canonical(value)), selection);
    } catch (error) { if (error instanceof ManagedTransportUnknown) return unknown(); throw error; }
  };
  const managedGrant: ManagedOwnerGrantPort = {
    async prepare(scope) {
      insist(canonical(scope) === canonical(r.scope), "managed_scope_changed", 409);
      const result = await call("prepare", { scope });
      const checked = configuredGrantSelection(JSON.parse(canonical(result)), r.scope);
      insist(canonical(checked) === canonical(selection), "managed_selection_changed", 409);
      return checked;
    },
    attach: digest => observe("attach", digest), reconcile: digest => observe("reconcile", digest),
  };
  await check();
  // Verifies selected actual key without generating, rotating or exporting it.
  const actual = await publisher.selected();
  insist(actual.custodyBindingDigest === custody.custodyBindingDigest, "managed_custody_changed", 409);
  return { managedGrant, publisher };
}
