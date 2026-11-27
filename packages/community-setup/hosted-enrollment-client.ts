import type { Hex } from "viem";
import {
  canonical,
  CommunityError,
  exact,
  hashText,
  insist,
  integer,
  object,
} from "../community/common.ts";
import { sharedBytes32 } from "../community/shared-identity.ts";
import { web2ProfileDocument } from "../community/web2-directory.ts";
import {
  assertDeployment,
  enrollmentDocument,
  enrollmentTypedData,
  HOSTED_NO_INVITE_ID,
  ownPolicy,
  parseEnrollment,
  parsePlan,
  planDocument,
  policyHash,
  signature,
  type HostedPolicy,
} from "../community/hosted-enrollment.ts";
import type { Web2RegistrationPlan } from "../community/web2-registration-chain.ts";
import {
  hostedEnrollmentStatusFrom,
  type HostedEnrollmentStatus,
} from "./linux-web2-profile.ts";

export interface PreparedHostedEnrollment {
  schema: "pirate.hosted-enrollment/1";
  enrollmentId: Hex;
  expiresAt: number;
  typedData: unknown;
  enrollment: unknown;
}
const wire = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  );
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Compare the entire requested EIP-712 message with the locally intended plan. */
export function checkedHostedPreparation(
  value: unknown,
  plan: Web2RegistrationPlan,
  policy: HostedPolicy,
  now: number,
): PreparedHostedEnrollment {
  const v = object(value);
  exact(v, ["schema", "enrollmentId", "expiresAt", "typedData"]);
  const typed = object(v.typedData),
    message = object(typed.message);
  const id = sharedBytes32(v.enrollmentId),
    wireInviteId = sharedBytes32(message.inviteId),
    wireAllowanceId = sharedBytes32(message.allowanceId);
  const inviteId = wireInviteId === HOSTED_NO_INVITE_ID ? null : wireInviteId,
    allowanceId =
      wireAllowanceId === HOSTED_NO_INVITE_ID ? null : wireAllowanceId;
  const expiresAt = integer(v.expiresAt, 1, Number.MAX_SAFE_INTEGER);
  insist(
    (inviteId === null) === (allowanceId === null) &&
      v.schema === "pirate.hosted-enrollment/1" &&
      id ===
        hashText(
          inviteId
            ? `hosted-enrollment:${inviteId}`
            : `hosted-enrollment:${plan.commitment}`,
        ) &&
      expiresAt > now &&
      expiresAt <= now + policy.challengeSeconds,
    "hosted_signing_request_changed",
    409,
  );
  const enrollment = {
    schema: "pirate.hosted-enrollment/1" as const,
    id,
    inviteId,
    allowanceId,
    expiresAt,
    policyHash: policyHash(policy),
    noticeSha256: policy.noticeSha256,
    plan,
  };
  const expected = wire(enrollmentTypedData(enrollment));
  insist(
    canonical(expected) === canonical(typed),
    "hosted_signing_request_changed",
    409,
  );
  return {
    schema: enrollment.schema,
    enrollmentId: id,
    expiresAt,
    typedData: expected,
    enrollment: wire(enrollmentDocument(enrollment)),
  };
}

export function createHostedEnrollmentClient(
  input: HostedPolicy,
  transport: typeof fetch = (...args) => globalThis.fetch(...args),
  clock = () => Math.floor(Date.now() / 1000),
) {
  const policy = ownPolicy(input);
  async function post(path: string, body: unknown) {
    let response: Response;
    const deadline = AbortSignal.timeout(15_000);
    try {
      response = await bounded(
        transport(policy.serviceOrigin + path, {
          method: "POST",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(wire(body)),
          signal: deadline,
        }),
        deadline,
      );
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw Error("missing response");
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await bounded(reader.read(), deadline);
          if (next.done) break;
          size += next.value.length;
          if (size > 131_072) {
            await reader.cancel();
            throw Error("response limit");
          }
          chunks.push(next.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      // Never reflect arbitrary provider strings (which can contain secrets).
      if (!response.ok) {
        const code =
          value && typeof value === "object" && "error" in value
            ? value.error
            : null;
        if (
          path === "/prepare" &&
          (code === "invite_unavailable" ||
            code === "invite_preparation_conflict") &&
          [403, 409].includes(response.status)
        )
          throw new CommunityError("hosted_invitation_refused", 409);
        if (
          response.status === 403 &&
          [
            "enrollment_authentication_failed",
            "controller_proof_invalid",
            "recipient_proof_set_mismatch",
          ].includes(String(code))
        )
          throw new CommunityError("hosted_authorization_refused", 409);
        throw new CommunityError(
          "hosted_request_refused",
          response.status === 429 ? 429 : response.status >= 500 ? 503 : 409,
        );
      }
      return value;
    } catch (error) {
      if (error instanceof CommunityError) throw error;
      throw new CommunityError("hosted_acknowledgement_unknown", 503);
    }
  }
  function original(prepared: PreparedHostedEnrollment) {
    const e = parseEnrollment(prepared.enrollment);
    const checked = checkedHostedPreparation(
      {
        schema: prepared.schema,
        enrollmentId: prepared.enrollmentId,
        expiresAt: prepared.expiresAt,
        typedData: prepared.typedData,
      },
      e.plan,
      policy,
      Math.min(clock(), e.expiresAt - 1),
    );
    insist(
      canonical(checked.enrollment) === canonical(prepared.enrollment),
      "hosted_original_changed",
      409,
    );
    return e;
  }
  async function action(
    path: string,
    prepared: PreparedHostedEnrollment,
    controllerSignature: unknown,
    proofs?: unknown,
  ): Promise<HostedEnrollmentStatus> {
    const e = original(prepared),
      auth = {
        enrollmentId: e.id,
        controllerSignature: signature(controllerSignature),
      };
    const value = await post(
      path,
      proofs === undefined ? auth : { ...auth, recipientProofs: proofs },
    );
    const status = hostedEnrollmentStatusFrom(value);
    insist(
      status.enrollmentId === e.id &&
        status.configurationUri === e.plan.uri &&
        canonical(status.profile) ===
          canonical(web2ProfileDocument(e.plan.profile)),
      "hosted_status_context_changed",
      409,
    );
    return status;
  }
  return {
    async prepare(planInput: Web2RegistrationPlan, inviteToken?: string) {
      const plan = parsePlan(planDocument(planInput));
      assertDeployment(policy, plan);
      if (inviteToken !== undefined)
        insist(
          typeof inviteToken === "string" && /^[a-f0-9]{64}$/.test(inviteToken),
          "invalid_invite",
        );
      const value = await post("/prepare", {
        ...(inviteToken === undefined ? {} : { inviteToken }),
        profile: web2ProfileDocument(plan.profile),
        config: plan.config,
        uri: plan.uri,
        noticeSha256: policy.noticeSha256,
      });
      return checkedHostedPreparation(value, plan, policy, clock());
    },
    redeem: (prepared: PreparedHostedEnrollment, proof: unknown) =>
      action("/redeem", prepared, proof),
    status: (prepared: PreparedHostedEnrollment, proof: unknown) =>
      action("/status", prepared, proof),
    topup: (
      prepared: PreparedHostedEnrollment,
      proof: unknown,
      proofs: unknown,
    ) => action("/initial-topup", prepared, proof, proofs),
  };
}
