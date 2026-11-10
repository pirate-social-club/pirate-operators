import test from "node:test";
import assert from "node:assert/strict";
import { accounts } from "../harness/runtime.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import {
  acceptEnrollment,
  enrollmentForPractice,
} from "../services/learning-enrollment.ts";
import {
  contractDomain,
  pendingEnrollmentKey,
} from "../services/learning-contract.ts";
import { enrollmentTypes } from "../packages/protocol/learning-results.ts";

test(
  "Study requests fresh V3 authority and renews short grants without reusing V2 or Karaoke-only consent",
  { timeout: 60000 },
  async () => {
    const f = await learningBindingFixture(19867);
    try {
      f.env.RESULTS_V3_CONTRACT = f.v3;
      const old = await f.enrollment(2);
      await acceptEnrollment(f.env, f.store, old.e, old.signature, old.target);
      const v3 = await f.enrollment(3);
      const requested = await enrollmentForPractice(
        f.env,
        f.store,
        old.e.learner,
        v3.target,
        2,
      );
      assert.ok("primaryType" in requested);
      assert.equal(requested.target.version, 3);
      assert.equal(requested.message.activities, "3");
      await assert.rejects(
        enrollmentForPractice(f.env, f.store, old.e.learner, old.target, 2),
        /unsupported_activity/,
      );

      const sign = (e: typeof v3.e) =>
        accounts[5].signTypedData({
          domain: contractDomain(v3.target),
          types: enrollmentTypes,
          primaryType: "Enrollment",
          message: e,
        });
      const short = {
        ...v3.e,
        expiresAt: BigInt(f.store.now() + 1800),
        activities: 1n,
      };
      await acceptEnrollment(
        f.env,
        f.store,
        short,
        await sign(short),
        v3.target,
      );
      const karaoke = await enrollmentForPractice(
        f.env,
        f.store,
        short.learner,
        v3.target,
      );
      assert.ok("active" in karaoke && karaoke.active);
      const study = await enrollmentForPractice(
        f.env,
        f.store,
        short.learner,
        v3.target,
        2,
      );
      assert.ok("message" in study);
      assert.equal(study.message.nonce, "1");

      const shortStudy = { ...short, activities: 3n, nonce: 1n };
      await acceptEnrollment(
        f.env,
        f.store,
        shortStudy,
        await sign(shortStudy),
        v3.target,
      );
      const renewal = await enrollmentForPractice(
        f.env,
        f.store,
        short.learner,
        v3.target,
        2,
      );
      assert.ok("message" in renewal);
      assert.equal(renewal.message.nonce, "2");
      const renewed = {
        ...shortStudy,
        nonce: 2n,
        expiresAt: BigInt(renewal.message.expiresAt),
      };
      await acceptEnrollment(
        f.env,
        f.store,
        renewed,
        await sign(renewed),
        v3.target,
      );
      const ready = await enrollmentForPractice(
        f.env,
        f.store,
        short.learner,
        v3.target,
        2,
      );
      assert.ok("active" in ready && ready.active);
      assert.equal(ready.activities, 3);
      assert.ok(ready.expiresAt >= f.store.now() + 3660);
      assert.equal(ready.target.contract.toLowerCase(), f.v3.toLowerCase());
      const pendingKey = pendingEnrollmentKey(v3.target, short.learner);
      f.store.set(pendingKey, { pending: true });
      const pending = await enrollmentForPractice(
        f.env,
        f.store,
        short.learner,
        v3.target,
        2,
      );
      assert.ok("pending" in pending && pending.pending);
      f.store.delete(pendingKey);

      const boundary = await f.enrollment(3, 6);
      boundary.e.expiresAt = BigInt(f.store.now() + 3660);
      const boundarySignature = await accounts[6].signTypedData({
        domain: contractDomain(v3.target),
        types: enrollmentTypes,
        primaryType: "Enrollment",
        message: boundary.e,
      });
      await acceptEnrollment(
        f.env,
        f.store,
        boundary.e,
        boundarySignature,
        v3.target,
      );
      const headroom = await enrollmentForPractice(
        f.env,
        f.store,
        boundary.e.learner,
        v3.target,
        2,
      );
      assert.ok(
        "message" in headroom,
        "An exact one-hour-plus-grace grant leaves no time for the start request",
      );
    } finally {
      await f.stop();
    }
  },
);
