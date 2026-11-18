import type { Hex } from "viem";
import {
  canonical,
  CommunityError,
  exact,
  hashText,
  insist,
  jsonBody,
  object,
} from "../packages/community/common.ts";
import { preparePin, readBounded } from "../packages/community/ipfs.ts";
import { sharedBytes32 } from "../packages/community/shared-identity.ts";
import {
  parseWeb2ProfileDocument,
  web2ProfileDocument,
} from "../packages/community/web2-directory.ts";
import { prepareWeb2Registration } from "../packages/community/web2-registration-chain.ts";
import {
  assertDeployment,
  enrollmentTypedData,
  ownPolicy,
  policyHash,
  signature,
  verifyEnrollmentProof,
  wei,
  type Enrollment,
} from "../packages/community/hosted-enrollment.ts";
import {
  allOperations,
  ownHostedSchemaContext,
  assertHostedSchema,
  assertBudgetNamespace,
  findInvite,
  loadEnrollment,
  loadOriginalPolicy,
  redeemEnrollment,
  savePreparation,
} from "../packages/community/hosted-enrollment-store.ts";
import {
  executeHostedOperation,
  reconcileHostedOperation,
  type HostedRuntime,
} from "../packages/community/hosted-topup-chain.ts";

export function ownHostedRuntime(input: HostedRuntime): HostedRuntime {
  const p = ownPolicy(input.policy);
  return Object.freeze({
    ...input,
    policy: p,
    schemaContext: input.schemaContext === undefined ? undefined : ownHostedSchemaContext(input.schemaContext),
    registrar: Object.freeze({ ...input.registrar }),
    funder: Object.freeze({ ...input.funder }),
  });
}
export async function readHostedRequest(r: HostedRuntime, request: Request) {
  insist(
    new URL(request.url).origin === r.policy.serviceOrigin,
    "wrong_host",
    403,
  );
  insist(request.method === "POST", "post_required", 405);
  // No cookies or ambient authority; proofs are required on every action.
  insist(!request.headers.has("cookie"), "cookie_authority_not_supported", 403);
  await assertHostedSchema(r.db, r.schemaContext);
  await assertBudgetNamespace(r.db, r.policy);
  return jsonBody(request, 128 * 1024);
}
export function hostedResponse(value: unknown, status = 200) {
  return new Response(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
export function hostedError(error: unknown) {
  if (error instanceof Error && !(error instanceof CommunityError)) console.error(JSON.stringify({
    event: "hosted_unavailable", errorClass: error.name, frame: error.stack?.split("\n")[1]?.trim(),
  }));
  return hostedResponse(
    {
      error:
        error instanceof CommunityError ? error.code : "hosted_unavailable",
    },
    error instanceof CommunityError ? error.status : 503,
  );
}
function assertStagingApplicationOrigin(r: HostedRuntime, origin: string) {
  insist(
    r.stagingApplicationOrigin === undefined || r.stagingApplicationOrigin === origin,
    "unaccepted_hosted_application_origin",
    403,
  );
}
export async function authenticateHostedRequest(
  r: HostedRuntime,
  body: Record<string, unknown>,
): Promise<Enrollment> {
  let id: Hex, sig: Hex;
  try {
    id = sharedBytes32(body.enrollmentId);
    sig = signature(body.controllerSignature);
  } catch {
    insist(false, "enrollment_authentication_failed", 403);
  }
  let e: Enrollment;
  try {
    e = await loadEnrollment(r.db, id);
    const p = await loadOriginalPolicy(r.db, e);
    assertDeployment(p, e.plan);
    await verifyEnrollmentProof(
      r.client,
      p,
      e,
      e.plan.config.controller,
      sig,
      r.now,
    );
  } catch (error) {
    // Missing IDs and invalid local proofs share one opaque refusal. Unavailable
    // chain/storage evidence is not a final denial of the controller's authority.
    if (
      error instanceof CommunityError &&
      (error.code === "enrollment_not_found" ||
        error.code === "controller_proof_invalid")
    )
      insist(false, "enrollment_authentication_failed", 403);
    insist(false, "enrollment_authentication_unavailable", 503);
  }
  assertStagingApplicationOrigin(r, e.plan.config.app.origin);
  return e;
}
export async function publicHostedStatus(r: HostedRuntime, e: Enrollment) {
  const originalRuntime = { ...r, policy: await loadOriginalPolicy(r.db, e) };
  const ops = await allOperations(r.db, e.id),
    states = [];
  for (const op of ops) {
    const current = await reconcileHostedOperation(originalRuntime, e, op);
    states.push({
      kind: current.kind,
      state: current.state,
      transactionHash: current.tx_hash,
      receipt: current.receipt ? JSON.parse(current.receipt) : null,
    });
  }
  return {
    schema: "pirate.hosted-enrollment-status/1",
    enrollmentId: e.id,
    communityId: e.plan.profile.communityId,
    installationId: e.plan.profile.installationId,
    profile: web2ProfileDocument(e.plan.profile),
    configurationUri: e.plan.uri,
    operations: states,
  };
}
export function createHostedEnrollmentService(input: HostedRuntime) {
  const r = ownHostedRuntime(input);
  return async function fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      insist(
        ["/prepare", "/redeem", "/status"].includes(path),
        "not_found",
        404,
      );
      const body = await readHostedRequest(r, request);
      if (path === "/prepare") {
        exact(body, [
          "inviteToken",
          "profile",
          "config",
          "uri",
          "noticeSha256",
        ]);
        insist(
          typeof body.inviteToken === "string" && typeof body.uri === "string",
          "invalid_prepare",
        );
        insist(
          body.noticeSha256 === r.policy.noticeSha256,
          "pilot_notice_required",
          403,
        );
        const now = r.now(),
          invite = await findInvite(r.db, body.inviteToken, r.policy, now);
        const plan = prepareWeb2Registration(
          parseWeb2ProfileDocument(body.profile),
          body.config,
          body.uri,
          r.policy.registrar,
          wei(r.policy.registrarRevision),
        );
        assertDeployment(r.policy, plan);
        assertStagingApplicationOrigin(r, plan.config.app.origin);
        const pin = await preparePin(
          new TextEncoder().encode(canonical(plan.config)),
          "application/json",
        );
        insist(pin.uri === plan.uri, "configuration_cid_mismatch");
        const stored = await readBounded(
          await r.readConfiguration(plan.uri),
          128 * 1024,
        );
        insist(
          stored.length === pin.byteLength &&
            hashText(
              new TextDecoder("utf-8", { fatal: true }).decode(stored),
            ) === pin.sha256,
          "configuration_pin_unavailable",
          503,
        );
        const ph = policyHash(r.policy),
          requestHash = hashText(
            canonical({
              plan: plan.commitment,
              policy: ph,
              notice: r.policy.noticeSha256,
            }),
          );
        const candidate: Enrollment = {
          schema: "pirate.hosted-enrollment/1",
          id: hashText(`hosted-enrollment:${invite.id}`),
          inviteId: invite.id,
          allowanceId: invite.allowance_id,
          expiresAt: Math.min(
            invite.expires_at,
            now + r.policy.challengeSeconds,
          ),
          policyHash: ph,
          noticeSha256: r.policy.noticeSha256,
          plan,
        };
        const e = await savePreparation(r.db, candidate, requestHash, r.policy);
        insist(e.expiresAt > r.now(), "enrollment_inactive", 409);
        return hostedResponse({
          schema: e.schema,
          enrollmentId: e.id,
          expiresAt: e.expiresAt,
          typedData: enrollmentTypedData(e),
        });
      }
      exact(body, ["enrollmentId", "controllerSignature"]);
      const e = await authenticateHostedRequest(r, body);
      if (path === "/redeem") {
        insist(
          e.policyHash === policyHash(r.policy),
          "hosted_policy_changed",
          409,
        );
        r.assertRegistrarArmed?.();
        await redeemEnrollment(r.db, e, r.now());
        await executeHostedOperation(r, e, "registration");
      }
      return hostedResponse(await publicHostedStatus(r, e));
    } catch (error) {
      return hostedError(error);
    }
  };
}
