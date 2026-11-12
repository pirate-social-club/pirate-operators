import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { accounts } from "../harness/runtime.ts";
import { authorizationRoute } from "../services/learning-authorization.ts";
import { Store } from "../services/operator-store.ts";
import { bootstrap } from "../services/study-linked-withdrawal-contract.ts";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { telegramAuthorityStoreFixture } from "./telegram-authority-store-fixture.ts";

interface AuthorityStatus {
  since: number;
  revokedAt: number;
  pendingWithdrawal?: true;
  linkedWithdrawalPending?: true;
}
const wallet = accounts[5].address.toLowerCase();

// UNRUN. Actual local contract/sign-in/HTTP operator services, no replacement
// authority response or proof port. The old Map fixture is a negative witness.
test(
  "recorded sign-in without the required original-authority store still reports pending",
  { timeout: 90000 },
  async () => {
    const f = await studyCommunityFixture(20348, { v4: true });
    try {
      await f.login();
      await f.recordSignIns();
      const response = await f.env.KARAOKE_OPERATOR!.fetch(
        "http://service/authorization/" + wallet,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as AuthorityStatus;
      assert.ok(body.since > 0);
      assert.equal(body.revokedAt, 0);
      assert.equal(body.pendingWithdrawal, undefined);
      assert.equal(body.linkedWithdrawalPending, true);
      assert.equal(f.counts().calls, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "real Store/index/source/bootstrap serves original authorization and retains cold/missing-source/legacy holds",
  { timeout: 90000 },
  async () => {
    const f = await studyCommunityFixture(20349, {
      v4: true,
      linkedOperator: true,
    });
    const additional: ReturnType<typeof telegramAuthorityStoreFixture>[] = [];
    try {
      await f.login();
      await f.recordSignIns();
      assert.ok(f.linkedOperator);
      assert.ok(f.linkedOperator.store instanceof Store);
      assert.equal(bootstrap(f.linkedOperator.store)?.phase, "ready");
      assert.equal(
        f.linkedOperator.store.linkedStudyBindings.hasUnclassified(),
        false,
      );
      const runtime = await f.evm.publicClient.getCode({ address: f.v4 });
      assert.ok(runtime && runtime !== "0x");
      assert.equal(
        f.linkedOperator.sources[0].runtimeCodeHash,
        keccak256(runtime),
      );
      assert.equal(
        f.linkedOperator.sources[0].target.contract,
        f.v4.toLowerCase(),
      );
      const response = await f.env.KARAOKE_OPERATOR!.fetch(
        "http://service/authorization/" + wallet,
      );
      assert.equal(response.status, 200);
      const ready = (await response.json()) as AuthorityStatus;
      assert.ok(ready.since > 0);
      assert.equal(ready.revokedAt, 0);
      assert.equal(ready.pendingWithdrawal, undefined);
      assert.equal(ready.linkedWithdrawalPending, undefined);
      assert.ok(f.linkedOperator.alarm() !== null);

      const read = async (store: Store) => {
        const value = await authorizationRoute(
          new Request("http://service/authorization/" + wallet),
          f.operatorEnv,
          store,
        );
        assert.ok(value);
        assert.equal(value.status, 200);
        const body = (await value.json()) as AuthorityStatus;
        assert.equal(body.since, ready.since);
        assert.equal(body.pendingWithdrawal, undefined);
        return body;
      };
      const cold = telegramAuthorityStoreFixture({
        now: () => Math.floor(f.clock() / 1000),
        sources: f.linkedOperator.sources,
        rpcUrl: f.evm.rpcUrl,
      });
      additional.push(cold);
      assert.equal((await read(cold.store)).linkedWithdrawalPending, true);
      await cold.bootstrapPage();
      assert.equal(bootstrap(cold.store)?.phase, "bindings");
      assert.equal((await read(cold.store)).linkedWithdrawalPending, true);
      await cold.bootstrapPage();
      assert.equal(bootstrap(cold.store)?.phase, "ready");
      assert.equal((await read(cold.store)).linkedWithdrawalPending, undefined);

      const missingSource = telegramAuthorityStoreFixture({
        now: () => Math.floor(f.clock() / 1000),
        sources: [],
        rpcUrl: f.evm.rpcUrl,
      });
      additional.push(missingSource);
      await missingSource.initialize();
      assert.equal(bootstrap(missingSource.store)?.phase, "ready");
      assert.equal(
        (await read(missingSource.store)).linkedWithdrawalPending,
        true,
      );

      // A malformed retained original is unresolved evidence, never a green
      // reset. Keep it present and pending through the end of this negative.
      await cold.store.durableStudyWrite(() =>
        cold.store.set("legacyResultsWithheld:" + wallet, {
          at: Math.floor(f.clock() / 1000),
        }),
      );
      assert.equal(cold.store.hasUnclassifiedLegacyWithdrawal(), true);
      assert.equal((await read(cold.store)).linkedWithdrawalPending, true);
      assert.ok(cold.store.get("legacyResultsWithheld:" + wallet));
      assert.equal(f.counts().calls, 0);
    } finally {
      for (const fixture of additional) fixture.close();
      await f.dispose();
    }
  },
);
