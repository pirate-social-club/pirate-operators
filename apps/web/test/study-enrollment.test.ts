import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureStudyEnrollment,
  type StudyEnrollmentView,
} from "../src/live/study-enrollment.ts";

const target = {
  version: 3 as const,
  chainId: 6343,
  contract: `0x${"1".repeat(40)}`,
};
const request: StudyEnrollmentView = {
  target,
  domain: { chainId: 6343, verifyingContract: target.contract },
  types: {},
  primaryType: "Enrollment",
  message: { activities: "3" },
};
function fixture(view: StudyEnrollmentView = request) {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      request: async () => view,
      confirm: async () => {
        calls.push("confirm");
        return true;
      },
      wallet: {
        signConsent: async () => {
          calls.push("sign");
          return "fixture signature";
        },
      },
      submit: async () => {
        calls.push("submit");
        return { state: "success" };
      },
    },
  };
}
test("Study signs only after disclosure and accepts existing successor authority without a signature", async () => {
  const fresh = fixture();
  await ensureStudyEnrollment(fresh.ports);
  assert.deepEqual(fresh.calls, ["confirm", "sign", "submit"]);
  const active = fixture({ target, active: true, activities: 3 });
  await ensureStudyEnrollment(active.ports);
  assert.deepEqual(active.calls, []);
});
test("Study cancellation, pending consent and wrong generation never sign or submit", async () => {
  const cancelled = fixture();
  cancelled.ports.confirm = async () => false;
  await assert.rejects(ensureStudyEnrollment(cancelled.ports), /cancelled/);
  assert.deepEqual(cancelled.calls, []);
  for (const view of [
    { target, pending: true },
    { target: { ...target, version: 2 as const }, active: true, activities: 1 },
    { target, active: true, activities: 1 },
    { ...request, domain: { ...request.domain, chainId: 1 } },
    { ...request, message: { activities: "1" } },
  ]) {
    const f = fixture(view);
    await assert.rejects(ensureStudyEnrollment(f.ports));
    assert.deepEqual(f.calls, []);
  }
});
test("an unconfirmed submission leaves Study blocked until the same enrollment confirms", async () => {
  const f = fixture();
  f.ports.submit = async () => ({ state: "pending" });
  await assert.rejects(ensureStudyEnrollment(f.ports), /confirming/);
  assert.deepEqual(f.calls, ["confirm", "sign"]);
});

test("closing Study while the wallet signs prevents submission; already dispatched enrollment is not undone", async () => {
  let active = true;
  const f = fixture();
  const ports = { ...f.ports, active: () => active };
  ports.wallet = {
    signConsent: async () => {
      f.calls.push("sign");
      active = false;
      return "late signature";
    },
  };
  await assert.rejects(ensureStudyEnrollment(ports), /closed/);
  assert.deepEqual(f.calls, ["confirm", "sign"]);
  active = true;
  const dispatched = fixture();
  await assert.rejects(
    ensureStudyEnrollment({
      ...dispatched.ports,
      active: () => active,
      submit: async () => {
        dispatched.calls.push("submit");
        active = false;
        return { state: "success" };
      },
    }),
    /closed/,
  );
  assert.deepEqual(dispatched.calls, ["confirm", "sign", "submit"]);
});
