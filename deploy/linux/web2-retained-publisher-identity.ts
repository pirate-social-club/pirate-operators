import { bytesToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, exact, hashJson, insist, object } from "../../packages/community/common.ts";
import { address } from "../../packages/community/manifest-core.ts";
import type { OperationLease } from "./backend-state.ts";
import type { createManagedKeyClient } from "./managed-key-channel.ts";

export interface Web2RetainedPublisherIdentityRequest {
  installationId: string;
  operationId: string;
  leaseIntentSha256: string;
  keyReference: string;
  generation: number;
}

export interface Web2RetainedPublisherBinding {
  keyReference: string;
  generation: number;
  installationId: string;
  publisher: Address;
  custodyBindingDigest: Hex;
}

/** Construct inside the existing publisher custodian, on the exact admitted
 * action lease. Only the fixed, identity-only read capability leaves custody. */
export function createWeb2RetainedPublisherIdentityReader(input: {
  lease: OperationLease;
  original: Web2RetainedPublisherBinding;
  keys: Pick<Awaited<ReturnType<typeof createManagedKeyClient>>, "withKey">;
  /** Re-authenticate the retained, issuer-signed binding on the same action. */
  readCurrentBinding(): Promise<Web2RetainedPublisherBinding>;
}) {
  const { lease } = input;
  const original = structuredClone(input.original);
  exact(object(original), ["keyReference", "generation", "installationId", "publisher", "custodyBindingDigest"]);
  const { custodyBindingDigest, ...binding } = original;
  insist(
    binding.installationId === lease.installationId &&
      typeof binding.keyReference === "string" && binding.keyReference.length > 0 && binding.keyReference.length <= 256 &&
      !/[\x00-\x1f\x7f\u2028\u2029]/.test(binding.keyReference) &&
      Number.isSafeInteger(binding.generation) && binding.generation > 0 &&
      address(binding.publisher) === binding.publisher &&
      custodyBindingDigest === hashJson(binding),
    "retained_publisher_custody_binding_changed",
    409,
  );

  const expectedRequest: Web2RetainedPublisherIdentityRequest = {
    installationId: lease.installationId,
    operationId: lease.operationId,
    leaseIntentSha256: lease.intentRef.sha256,
    keyReference: binding.keyReference,
    generation: binding.generation,
  };
  const withKey = input.keys.withKey.bind(input.keys);
  const readCurrentBinding = input.readCurrentBinding.bind(input);

  async function assertCurrent() {
    await lease.assertHeld();
    const current = await readCurrentBinding();
    insist(
      lease.installationId === expectedRequest.installationId &&
        lease.operationId === expectedRequest.operationId &&
        lease.intentRef.sha256 === expectedRequest.leaseIntentSha256 &&
        canonical(current) === canonical(original),
      "retained_publisher_custody_binding_changed",
      409,
    );
    await lease.assertHeld();
  }

  return Object.freeze({
    async read(request: Web2RetainedPublisherIdentityRequest) {
      insist(
        canonical(object(request)) === canonical(expectedRequest),
        "retained_publisher_identity_request_changed",
        409,
      );
      await assertCurrent();
      const derivedAddress = await withKey(binding.keyReference, binding.generation, async bytes => {
        insist(bytes.byteLength === 32, "retained_publisher_key_address_changed", 409);
        return address(privateKeyToAccount(bytesToHex(bytes)).address.toLowerCase());
      });
      insist(derivedAddress === binding.publisher, "retained_publisher_key_address_changed", 409);
      await assertCurrent();
      return { address: derivedAddress, custodyBindingDigest };
    },
  });
}
