import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts, keys } from "../harness/runtime.ts";
import { attesterRuntime } from "../harness/very/attester-runtime.ts";
import {
  prepareReward,
  registerReward,
} from "../harness/very/reward-fixture.ts";
import {
  authentication,
  context,
  type AttesterConfig,
  type Challenge,
  type Permit,
} from "../services/very-attester/policy.ts";
import { proofFixture } from "./very-fixture.ts";

test(
  "real Worker SQLite survives restart, refuses app drift, and issues a contract-accepted permit",
  { timeout: 120000 },
  async () => {
    const evm = await chain();
    let runtime: Awaited<ReturnType<typeof attesterRuntime>> | undefined;
    const persist = mkdtempSync(join(tmpdir(), "pirate-very-attester-test-"));
    let verifies = 0;
    try {
      const adapter = {
        ...evm,
        timestamp: async () =>
          Number((await evm.publicClient.getBlock()).timestamp),
        advanceTo: async (now: number) => {
          await evm.rpc("evm_setNextBlockTimestamp", [now]);
          await evm.rpc("evm_mine", []);
        },
      };
      const reward = await prepareReward(adapter, accounts, 31337, 600);
      const config: AttesterConfig = {
        chainId: 31337,
        pool: reward.pool,
        drawingId: "1",
        attester: accounts[4].address,
        poolCodeHash: keccak256(
          (await evm.publicClient.getCode({ address: reward.pool }))!,
        ),
        appId: "11111111-1111-4111-8111-111111111111",
      };
      const now = await adapter.timestamp();
      const outbound = async (request: Request) => {
        if (request.url === "https://verify.very.org/api/v1/verify") {
          verifies++;
          return Response.json({ status: "valid" }); // Explicit fake external cryptography.
        }
        assert.equal(new URL(request.url).origin, "http://127.0.0.1:18545");
        return fetch(request.url, {
          method: request.method,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: await request.arrayBuffer(),
        });
      };
      const start = async (configuration = config) => {
        runtime = await attesterRuntime(configuration, keys[4], persist, {
          now,
          outbound,
        });
      };
      const post = async (path: string, body: unknown) => {
        const response = await runtime!.dispatchFetch(
          `http://attester${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        return {
          status: response.status,
          value: (await response.json()) as Record<string, unknown>,
        };
      };
      await start();
      const begun = await post("/challenge", { claimant: accounts[5].address });
      assert.equal(begun.status, 200, JSON.stringify(begun.value));
      const challenge = begun.value as unknown as Challenge;
      const input = {
        id: challenge.id,
        authorization: await accounts[5].signTypedData(
          authentication(config, challenge),
        ),
        proof: proofFixture(
          context(config).externalNullifier,
          challenge.binding,
        ),
      };
      assert.equal((await post("/__state", {})).status, 400);
      assert.equal(
        (await post("/issue", { ...input, appId: config.appId })).status,
        400,
      );
      assert.equal(
        (
          await post("/issue", {
            ...input,
            proof: proofFixture("1000001", challenge.binding),
          })
        ).status,
        400,
      );
      assert.equal(verifies, 0);
      const issued = await post("/issue", input);
      assert.equal(issued.status, 200, JSON.stringify(issued.value));
      assert.equal(verifies, 1);
      await runtime!.dispose();
      await start({ ...config, appId: "22222222-2222-4222-8222-222222222222" });
      const refused = await post("/issue", input);
      assert.equal(refused.value.error, "immutable_pool_configuration_changed");
      assert.equal(verifies, 1);
      await runtime!.dispose();
      await start();
      const replay = await post("/issue", input);
      assert.deepEqual(replay, issued);
      assert.equal(verifies, 1);
      assert.equal(
        (await post("/challenge", { claimant: evm.token })).value.error,
        "unsupported_wallet",
      );
      await evm.rpc("anvil_setCode", [
        accounts[6].address,
        `0xef0100${evm.token.slice(2)}`,
      ]);
      assert.equal(
        (await post("/challenge", { claimant: accounts[6].address })).status,
        200,
      );
      await registerReward(
        adapter,
        reward,
        accounts[5],
        issued.value as unknown as Permit,
      );
      assert.equal(
        await evm.read(reward.pool, "RewardPool", "payoutRecipient", [
          accounts[5].address,
        ]),
        accounts[5].address,
      );
      assert.equal(
        await evm.read(reward.pool, "RewardPool", "usedNullifiers", [
          issued.value.nullifier,
        ]),
        true,
      );
      await adapter.advanceTo(reward.deadline);
      await evm.write(reward.pool, "RewardPool", "finalize");
      assert.equal(
        (await post("/challenge", { claimant: accounts[5].address })).value
          .error,
        "registration_closed",
      );
      await evm.write(
        reward.pool,
        "RewardPool",
        "withdrawFor",
        [accounts[5].address],
        1,
      );
      assert.equal(
        await evm.read(evm.token, "TestUSDC", "balanceOf", [
          accounts[5].address,
        ]),
        10000001n,
      );
    } finally {
      await runtime?.dispose();
      evm.child.kill();
      await new Promise<void>((resolve) => {
        if (evm.child.exitCode !== null) resolve();
        else evm.child.once("exit", () => resolve());
      });
    }
  },
);
