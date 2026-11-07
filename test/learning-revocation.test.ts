import test from "node:test";
import assert from "node:assert/strict";
import { accounts } from "../harness/runtime.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import {
  acceptEnrollment,
  acceptRevocation,
  learningEnrollments,
  resumeEnrollments,
  revocationRequest,
} from "../services/learning-enrollment.ts";
import { revocationTypes } from "../packages/protocol/learning-results.ts";
import {
  contractDomain,
  type ResultsTarget,
} from "../services/learning-contract.ts";
import { stopPublicEnrollment } from "../apps/web/src/live/learning-revocation.ts";
import type { Hex } from "viem";

test(
  "stop public enrollment handles both live grants and resumes after a cancelled second signature",
  { timeout: 60000 },
  async () => {
    const f = await learningBindingFixture(19847);
    try {
      f.env.RESULTS_V3_CONTRACT = f.v3;
      for (const version of [2, 3] as const) {
        const enrollment = await f.enrollment(version);
        await acceptEnrollment(
          f.env,
          f.store,
          enrollment.e,
          enrollment.signature,
          enrollment.target,
        );
      }
      const learner = accounts[5].address;
      const list = () =>
        learningEnrollments(f.env, f.store, learner).then((value) => ({
          ...value,
          grants: value.grants.map((grant) => ({
            ...grant,
            target: grant.target!,
          })),
        }));
      assert.deepEqual(
        (await list()).grants.map((g) => g.target.version),
        [2, 3],
      );
      const requested: number[] = [],
        signed: number[] = [];
      let cancelled = false;
      const ports: Parameters<typeof stopPublicEnrollment>[0] = {
        list,
        status() {},
        request: async (target) => {
          requested.push(target.version);
          return revocationRequest(f.env, learner, target as ResultsTarget);
        },
        wallet: {
          async signConsent(request) {
            const target = request.target as ResultsTarget;
            if (target.version === 3 && !cancelled) {
              cancelled = true;
              throw new Error("MOSS signature cancelled");
            }
            signed.push(target.version);
            return accounts[5].signTypedData({
              domain: contractDomain(target),
              types: revocationTypes,
              primaryType: "Revocation",
              message: {
                learner,
                nonce: BigInt(String(request.message.nonce)),
              },
            });
          },
        },
        submit: async (request, signature) => {
          const result = await acceptRevocation(
            f.env,
            f.store,
            learner,
            BigInt(String(request.message.nonce)),
            signature as Hex,
            request.target as ResultsTarget,
          );
          return { state: result?.mined?.status ?? "pending" };
        },
      };
      await assert.rejects(
        stopPublicEnrollment(ports),
        /MOSS signature cancelled/,
      );
      assert.deepEqual(
        (await list()).grants.map((g) => g.target.version),
        [3],
      );
      assert.equal(
        await stopPublicEnrollment(ports),
        "Public enrollment stopped. Earlier publications remain public.",
      );
      assert.deepEqual(requested, [2, 3, 3]);
      assert.deepEqual(signed, [2, 3]);
      assert.deepEqual((await list()).grants, []);
      assert.equal(
        await stopPublicEnrollment(ports),
        "Public learning results are not enabled for this wallet.",
      );
    } finally {
      await f.stop();
    }
  },
);

test(
  "queued enrollment and revocation stay visible until their original transactions settle",
  { timeout: 60000 },
  async () => {
    const f = await learningBindingFixture(19848);
    try {
      f.env.RESULTS_V3_CONTRACT = f.v3;
      const e = await f.enrollment(3);
      f.store.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        acceptEnrollment(f.env, f.store, e.e, e.signature),
        /simulated_crash/,
      );
      let observed = await learningEnrollments(f.env, f.store, e.e.learner);
      assert.equal(observed.pendingEnrollment, true);
      assert.equal(observed.grants.length, 0);
      let approvals = 0;
      const ports: Parameters<typeof stopPublicEnrollment>[0] = {
        list: async () => ({
          ...observed,
          grants: observed.grants.map((g) => ({ ...g, target: g.target! })),
        }),
        request: async () => {
          throw new Error("should not request another signature");
        },
        submit: async () => {
          throw new Error("should not dispatch another transaction");
        },
        wallet: {
          async signConsent() {
            approvals++;
            return "0x";
          },
        },
        status() {},
      };
      assert.match(
        await stopPublicEnrollment(ports),
        /enrollment is still confirming/,
      );
      await resumeEnrollments(f.env, f.store);
      const revoke = await revocationRequest(f.env, e.e.learner);
      const signature = await accounts[5].signTypedData({
        domain: revoke.domain,
        types: revocationTypes,
        primaryType: "Revocation",
        message: { learner: e.e.learner, nonce: BigInt(revoke.message.nonce) },
      });
      f.store.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        acceptRevocation(
          f.env,
          f.store,
          e.e.learner,
          BigInt(revoke.message.nonce),
          signature,
        ),
        /simulated_crash/,
      );
      observed = await learningEnrollments(f.env, f.store, e.e.learner);
      assert.equal(observed.pendingEnrollment, false);
      assert.equal(observed.grants[0].revocationPending, true);
      assert.match(
        await stopPublicEnrollment(ports),
        /still active or confirming/,
      );
      assert.equal(approvals, 0);
      f.restartJournal();
      await resumeEnrollments(f.env, f.store);
      observed = await learningEnrollments(f.env, f.store, e.e.learner);
      assert.equal(observed.grants.length, 0);
      // An inaccessible generation must never look like a successful stop.
      await assert.rejects(
        learningEnrollments(
          { ...f.env, RPC_URL: "http://127.0.0.1:1" },
          f.store,
          e.e.learner,
        ),
      );
    } finally {
      await f.stop();
    }
  },
);
