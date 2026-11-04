import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chain } from "../harness/chain.ts";
import { accounts } from "../harness/runtime.ts";
import {
  compileCommunity,
  runtimeMatches,
} from "../harness/compile-community.ts";
import { deploymentJournal } from "../harness/megaeth/deployment-journal.ts";
import { verifyDeployment } from "../harness/megaeth/verify-community.ts";

test("a locally signed deployment resumes after persistence or broadcast without a second contract", async () => {
  const evm = await chain(18845),
    directory = await mkdtemp(join(tmpdir(), "pirate-deployment-journal-"));
  const limits = {
    chainId: 31337 as const,
    maximumGasPrice: 10000000000n,
    maximumTotalFee: 10000000000000000n,
  };
  const artifact = compileCommunity().artifacts.DisabledDiscoveryAuthority!;
  const profile = {
    purpose: "local fixture only",
    contract: artifact.bytecode,
  };
  const operator = accounts[0]!;
  const mine = async () => {
    await evm.rpc("evm_mine", []);
  };
  try {
    let journal = await deploymentJournal(
      directory,
      profile,
      evm.publicClient,
      operator,
      limits,
    );
    const before = await evm.publicClient.getTransactionCount({
      address: operator.address,
    });
    await assert.rejects(
      journal.send(
        "authority",
        { data: artifact.bytecode, gas: 100000n },
        async (phase) => {
          if (phase === "prepared")
            throw new Error("fixture termination after durable signing");
        },
      ),
      /fixture termination/,
    );
    const captured = journal.snapshot().transactions.authority!;
    assert.equal(
      await evm.publicClient.getTransactionCount({ address: operator.address }),
      before,
    );
    await journal.close();
    journal = await deploymentJournal(
      directory,
      profile,
      evm.publicClient,
      operator,
      limits,
    );
    await assert.rejects(
      journal.send(
        "authority",
        { data: artifact.bytecode, gas: 100000n },
        async (phase) => {
          if (phase === "broadcast") {
            await mine();
            throw new Error("fixture termination after broadcast");
          }
        },
      ),
      /fixture termination/,
    );
    await journal.close();
    journal = await deploymentJournal(
      directory,
      profile,
      evm.publicClient,
      operator,
      limits,
    );
    const receipt = await journal.send("authority", {
      data: artifact.bytecode,
      gas: 100000n,
    });
    assert.equal(receipt.transactionHash, captured.hash);
    const verified = await verifyDeployment(
      evm.publicClient,
      receipt,
      artifact,
      operator.address,
      captured.nonce,
    );
    assert.ok(
      runtimeMatches(
        (await evm.publicClient.getCode({ address: verified.address }))!,
        artifact,
      ),
    );
    assert.equal(
      await evm.publicClient.getTransactionCount({ address: operator.address }),
      before + 1,
    );
    await journal.send("authority", { data: artifact.bytecode, gas: 100000n });
    assert.equal(
      await evm.publicClient.getTransactionCount({ address: operator.address }),
      before + 1,
    );
    await assert.rejects(
      journal.send("authority", { data: artifact.bytecode, gas: 110000n }),
      /deployment_step_changed/,
    );
    await assert.rejects(
      journal.send(
        "one_confirmation",
        { data: artifact.bytecode, gas: 100000n },
        async (phase) => {
          if (phase === "broadcast")
            throw new Error("fixture interruption at one confirmation");
        },
      ),
      /fixture interruption at one confirmation/,
    );
    await journal.close();
    journal = await deploymentJournal(
      directory,
      profile,
      evm.publicClient,
      operator,
      limits,
    );
    let finished = false;
    const recovering = journal
      .send("one_confirmation", { data: artifact.bytecode, gas: 100000n })
      .then((receipt) => {
        finished = true;
        return receipt;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      finished,
      false,
      "a recovered one-confirmation receipt must wait",
    );
    await mine();
    await recovering;
    await assert.rejects(
      deploymentJournal(directory, profile, evm.publicClient, operator, limits),
    );
    await journal.close();
    await assert.rejects(
      deploymentJournal(directory, profile, evm.publicClient, operator, {
        ...limits,
        maximumTotalFee: limits.maximumTotalFee + 1n,
      }),
      /deployment_profile_changed/,
    );
    await assert.rejects(
      deploymentJournal(directory, profile, evm.publicClient, operator, {
        ...limits,
        chainId: 6343,
      }),
      /refusing_wrong_deployment_chain/,
    );
  } finally {
    evm.child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
