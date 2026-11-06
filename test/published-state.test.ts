import test from "node:test";
import assert from "node:assert/strict";
import { hashJson } from "../packages/community/common.ts";
import { assertRetainedPublishedState } from "../harness/published-state.ts";

test("learner account additions preserve the original published account and all other retained data", () => {
  const original = {
    account_id: "original",
    author_id: "original-author",
    created_at: 1,
  };
  const added = {
    account_id: "test-learner",
    author_id: "test-author",
    created_at: 2,
  };
  const spending = [{ scope: "publication", spent: "5", reserved: "2" }];
  const binding = {
    binding_id: "original-binding",
    account_id: "original",
    wallet: "original-wallet",
  };
  const extraBinding = {
    binding_id: "test-binding",
    account_id: "test-learner",
    wallet: "test-wallet",
  };
  const snapshot = (
    accounts: (typeof original)[],
    budgets = spending,
    bindings = [binding],
  ) => ({
    rows: {
      community_accounts: accounts,
      credential_bindings: bindings,
      spending_budgets: budgets,
    },
    summary: {
      community_accounts: {
        count: accounts.length,
        sha256: hashJson(accounts),
      },
      credential_bindings: {
        count: bindings.length,
        sha256: hashJson(bindings),
      },
      spending_budgets: { count: budgets.length, sha256: hashJson(budgets) },
    },
  });
  const baseline = snapshot([original]).summary;
  assertRetainedPublishedState(
    snapshot([original, added], spending, [binding, extraBinding]),
    baseline,
    "application",
  );
  assert.throws(
    () =>
      assertRetainedPublishedState(
        snapshot([original, added], spending, [
          { ...binding, wallet: "changed" },
          extraBinding,
        ]),
        baseline,
        "application",
      ),
    /published_state_changed/,
  );
  assertRetainedPublishedState(snapshot([original]), baseline, "application");
  assertRetainedPublishedState(
    snapshot([original, added]),
    baseline,
    "application",
  );
  assert.throws(
    () =>
      assertRetainedPublishedState(snapshot([added]), baseline, "application"),
    /published_state_changed/,
  );
  assert.throws(
    () =>
      assertRetainedPublishedState(
        snapshot([{ ...original, author_id: "changed" }, added]),
        baseline,
        "application",
      ),
    /published_state_changed/,
  );
  assert.throws(
    () =>
      assertRetainedPublishedState(
        snapshot([original, added], [{ ...spending[0]!, spent: "0" }]),
        baseline,
        "application",
      ),
    /published_state_changed/,
  );
  assert.throws(
    () =>
      assertRetainedPublishedState(
        snapshot([original, added]),
        baseline,
        "managed",
      ),
    /published_state_changed/,
  );
});
