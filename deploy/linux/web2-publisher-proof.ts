import { bytesToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonical,
  hashJson,
  insist,
  integer,
} from "../../packages/community/common.ts";
import { address } from "../../packages/community/manifest-core.ts";
import {
  enrollmentTypedData,
  parseEnrollment,
  ownPolicy,
  assertDeployment,
  policyHash,
} from "../../packages/community/hosted-enrollment.ts";
import type { HostedPolicy } from "../../packages/community/hosted-enrollment.ts";
import { checkedHostedPreparation } from "../../packages/community-setup/hosted-enrollment-client.ts";
import type { createManagedKeyClient } from "./managed-key-channel.ts";
import type { OperationLease } from "./backend-state.ts";
import type { PublisherProofSigner } from "./web2-operator-inputs.ts";

/** Adopts an already provisioned EOA. Never provisions or exports a key. */
export function createWeb2PublisherProofSigner(input: {
  key: Pick<Awaited<ReturnType<typeof createManagedKeyClient>>, "withKey">;
  keyReference: string;
  generation: number;
  installationId: string;
  publisher: Address;
  lease: OperationLease;
  policy: HostedPolicy;
  now(): number;
  /** Re-authenticate the original provisioning binding, not a browser choice. */
  currentBinding(): Promise<{
    keyReference: string;
    generation: number;
    installationId: string;
    publisher: Address;
  }>;
}): PublisherProofSigner {
  const binding = Object.freeze({
    keyReference: input.keyReference,
    generation: integer(input.generation, 1, Number.MAX_SAFE_INTEGER),
    installationId: input.installationId,
    publisher: address(input.publisher),
  });
  insist(
    binding.keyReference.length > 0 &&
      binding.keyReference.length <= 256 &&
      binding.installationId === input.lease.installationId,
    "publisher_custody_binding_unavailable",
    503,
  );
  const policy = ownPolicy(input.policy),
    custodyBindingDigest = hashJson(binding);
  async function check() {
    await input.lease.assertHeld();
    insist(
      canonical(await input.currentBinding()) === canonical(binding),
      "publisher_custody_binding_changed",
      409,
    );
    await input.lease.assertHeld();
  }
  return {
    async selected() {
      await check();
      // Check the actual selected key as well as its provisioning assertion.
      await input.key.withKey(
        binding.keyReference,
        binding.generation,
        async (bytes) => {
          insist(
            privateKeyToAccount(bytesToHex(bytes)).address.toLowerCase() ===
              binding.publisher,
            "publisher_key_address_changed",
            409,
          );
        },
      );
      await check();
      return { address: binding.publisher, custodyBindingDigest };
    },
    async signEnrollment(value) {
      const owned = structuredClone(value),
        e = parseEnrollment(owned.prepared.enrollment);
      const original = checkedHostedPreparation(
        {
          schema: owned.prepared.schema,
          enrollmentId: owned.prepared.enrollmentId,
          expiresAt: owned.prepared.expiresAt,
          typedData: owned.prepared.typedData,
        },
        e.plan,
        policy,
        input.now(),
      );
      insist(
        canonical(original) === canonical(owned.prepared) &&
          e.policyHash === policyHash(policy) &&
          e.plan.config.publisher === binding.publisher &&
          owned.operationId ===
            hashJson({
              enrollmentId: e.id,
              purpose: "publisher-enrollment-proof",
              custodyBindingDigest,
            }),
        "publisher_enrollment_binding_changed",
        409,
      );
      assertDeployment(policy, e.plan);
      const live = () =>
        insist(
          Number.isSafeInteger(input.now()) && input.now() < e.expiresAt,
          "enrollment_challenge_expired",
          409,
        );
      await check();
      live();
      const signature = await input.key.withKey(
        binding.keyReference,
        binding.generation,
        async (bytes) => {
          const account = privateKeyToAccount(bytesToHex(bytes));
          insist(
            account.address.toLowerCase() === binding.publisher,
            "publisher_key_address_changed",
            409,
          );
          await check();
          live();
          // Reconstruct exactly the retained enrollment; no arbitrary signing API.
          const proof = await account.signTypedData(enrollmentTypedData(e));
          await check();
          live();
          return proof;
        },
      );
      await check();
      live();
      return { recipient: binding.publisher, signature: signature as Hex };
    },
  };
}
