import { exact, insist, object } from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import { directoryV3Abi } from "../packages/community/web2-directory.ts";
import {
  safeView,
  signature,
  verifyEnrollmentProof,
  policyHash,
  assertFreshBlock,
} from "../packages/community/hosted-enrollment.ts";
import {
  allOperations,
  requireActive,
} from "../packages/community/hosted-enrollment-store.ts";
import {
  executeHostedOperation,
  initialRecipients,
  reconcileHostedOperation,
  type HostedRuntime,
} from "../packages/community/hosted-topup-chain.ts";
import {
  authenticateHostedRequest,
  hostedError,
  hostedResponse,
  ownHostedRuntime,
  publicHostedStatus,
  readHostedRequest,
} from "./hosted-community-enrollment.ts";

export function createHostedFundingService(input: HostedRuntime) {
  const r = ownHostedRuntime(input);
  return async function fetch(request: Request): Promise<Response> {
    try {
      insist(
        new URL(request.url).pathname === "/initial-topup",
        "not_found",
        404,
      );
      const body = await readHostedRequest(r, request);
      exact(body, ["enrollmentId", "controllerSignature", "recipientProofs"]);
      const e = await authenticateHostedRequest(r, body);
      insist(
        e.policyHash === policyHash(r.policy),
        "hosted_policy_changed",
        409,
      );
      insist(
        e.inviteId !== null && e.allowanceId !== null,
        "hosted_topup_allowance_required",
        409,
      );
      insist(Array.isArray(body.recipientProofs), "recipient_proofs_required");
      // Reconstruct proofs before any further await; no caller object is reused.
      const proofs = body.recipientProofs.map((value) => {
        const p = object(value);
        exact(p, ["recipient", "signature"]);
        return {
          recipient: address(p.recipient),
          signature: signature(p.signature),
        };
      });
      const recipients = initialRecipients(e, r.policy).filter(
        (x) => x.value > 0n,
      );
      insist(
        proofs.length === recipients.length &&
          new Set(proofs.map((x) => x.recipient)).size === proofs.length &&
          recipients.every((x) =>
            proofs.some((p) => p.recipient === x.address),
          ),
        "recipient_proof_set_mismatch",
        403,
      );
      const operations = await allOperations(r.db, e.id),
        registration = operations.find((x) => x.kind === "registration");
      insist(
        registration &&
          (await reconcileHostedOperation(r, e, registration)).state ===
            "consumed",
        "safe_registration_required",
        409,
      );
      // Previously broadcast operations settle even when revoked/expired. New
      // effects below require current roles and active enrollment.
      for (const op of operations.filter((x) => x.kind === "topup"))
        await reconcileHostedOperation(r, e, op);
      await requireActive(r.db, e, r.now());
      const safe = await safeView(r.client, r.policy, r.now);
      const community = await r.client.readContract({
        address: e.plan.profile.directory,
        abi: directoryV3Abi,
        functionName: "getCommunity",
        args: [e.plan.profile.communityId],
        blockNumber: safe.number,
      });
      insist(
        community.configuration.controller.toLowerCase() ===
          e.plan.config.controller &&
          community.configuration.publisher.toLowerCase() ===
            e.plan.config.publisher,
        "funding_roles_changed",
        409,
      );
      insist(
        (await r.client.getBlock({ blockNumber: safe.number })).hash ===
          safe.hash,
        "hosted_chain_reorganized",
        503,
      );
      for (const recipient of recipients) {
        const proof = proofs.find((x) => x.recipient === recipient.address)!;
        await verifyEnrollmentProof(
          r.client,
          r.policy,
          e,
          recipient.address,
          proof.signature,
          r.now,
        );
      }
      assertFreshBlock(safe, r.policy, r.now());
      for (const recipient of recipients)
        await executeHostedOperation(r, e, "topup", recipient.address);
      return hostedResponse(await publicHostedStatus(r, e));
    } catch (error) {
      return hostedError(error);
    }
  };
}
