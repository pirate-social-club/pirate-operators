// Exercise the actual entrypoint with real private journals and simulated RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Hex, type PublicClient } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { studyDeploymentFixture } from "./study-deployment-fixture.ts";
import { studyDeploymentMain } from "../harness/megaeth/study-deployment.ts";
import { studyDeploymentPlan } from "../harness/megaeth/study-deployment-plan.ts";
import { ActivationJournal } from "../harness/megaeth/activation-journal.ts";
import type { CorrectionTransaction } from "../harness/megaeth/study-correction-runner.ts";
type Fixture = Awaited<ReturnType<typeof studyDeploymentFixture>>;
async function prefix() {
  const f = await studyDeploymentFixture();
  let step = await f.open(0);
  try {
    assert.equal((await step.run()).state, "confirmed");
  } finally {
    step.close();
  }
  f.state.landed = false;
  f.state.lostResponse = true;
  step = await f.open(1);
  try {
    assert.equal((await step.run()).state, "unknown");
    return {
      f,
      operation: step.operation,
      path: step.path,
      stored: step.journal.get<CorrectionTransaction>("deployment")!,
    };
  } finally {
    step.close();
  }
}
const counts = (f: Fixture) => ({
  keys: f.state.keyReads,
  sends: f.state.sends.length,
});
const privatePath = "/key-must-not-be-read-on-recovery";
async function invoke(
  f: Fixture,
  mode: "execute" | "status" | "observe",
  client = f.client,
) {
  const path = join(f.directory, "public-profile.json");
  writeFileSync(path, JSON.stringify(f.profile));
  const result = await studyDeploymentMain(
    [
      "--profile",
      path,
      "--" + mode,
      ...(mode === "execute"
        ? [
            "--expect-profile",
            studyDeploymentPlan(f.profile, f.artifact).profileHash,
            "--key-file",
            privatePath,
          ]
        : []),
    ],
    {
      artifact: f.artifact,
      client: () => client,
      stateDirectory: f.directory,
      transport: f.transport,
    },
  );
  assert("status" in result);
  return result;
}
async function addUnrelated(f: Fixture) {
  const profileHash = digest("unrelated-controller-profile"),
    nonce = 40;
  const raw = await f.account.signTransaction({
    type: "legacy",
    chainId: 6343,
    nonce,
    to: f.profile.grader,
    data: "0x",
    gas: 21000n,
    gasPrice: 2n,
    value: 0n,
  });
  const path = join(f.directory, profileHash.slice(2) + ".sqlite");
  const journal = new ActivationJournal(path);
  try {
    journal.set("correction", {
      profileHash,
      nonce,
      gasPriceWei: "2",
      maximumFeeWei: "42000",
      raw,
      hash: keccak256(raw),
    });
  } finally {
    journal.close();
  }
  const lease = new ActivationJournal(
    join(f.directory, "dispatch-custody.sqlite"),
  );
  try {
    lease.set("controller:profiles", [
      ...lease.get<unknown[]>("controller:profiles")!,
      {
        profileHash,
        nonce,
        journalPath: path,
        stage: "prepared",
        journalKey: "correction",
      },
    ]);
  } finally {
    lease.close();
  }
}
test("actual CLI skips its confirmed prefix to recover a matching later pending operation without keys or another send", async () => {
  const { f, operation } = await prefix();
  f.state.pending = true;
  const before = counts(f);
  const result = await invoke(f, "execute");
  assert.equal(result.mode, "execute");
  assert.equal(result.complete, false);
  assert.equal(result.status?.at(-1)?.step, operation.step);
  assert.equal(result.status?.at(-1)?.state, "pending");
  assert.deepEqual(counts(f), before);
  const status = await invoke(f, "status");
  assert.deepEqual(
    status.status?.map((row) => row.state),
    ["confirmed", "unknown", "unallocated", "unallocated", "unallocated"],
  );
  const observation = await invoke(f, "observe");
  assert("next" in observation);
  assert.equal(observation.next, "karaoke_grader");
  assert.deepEqual(counts(f), before);
});
test("actual CLI retransmits exactly a dropped later operation and stops at confirming before any new allocation", async () => {
  const { f, stored } = await prefix();
  f.state.pending = false;
  const before = counts(f);
  let replayed = false;
  const client = {
    ...f.client,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      assert.equal(serializedTransaction, stored.raw);
      f.state.sends.push(serializedTransaction);
      replayed = true;
      f.state.stage = 2;
      f.state.consumed = 2;
      return stored.hash!;
    },
    getTransactionReceipt: async (args: { hash: Hex }) =>
      args.hash === stored.hash && replayed
        ? {
            transactionHash: stored.hash!,
            blockNumber: 190n,
            blockHash: digest("block-190"),
            status: "success",
            contractAddress: null,
          }
        : f.client.getTransactionReceipt(args),
  } as unknown as PublicClient;
  const result = await invoke(f, "execute", client);
  assert.equal(result.status?.at(-1)?.step, "karaoke_grader");
  assert.equal(result.status?.at(-1)?.state, "confirming");
  assert.deepEqual(counts(f), { keys: before.keys, sends: before.sends + 1 });
  const future = studyDeploymentPlan(f.profile, f.artifact).operations[2];
  assert.equal(
    existsSync(join(f.directory, future.profileHash.slice(2) + ".sqlite")),
    false,
  );
});
test("actual CLI frontier recovery still refuses an unrelated unresolved controller profile", async () => {
  const { f } = await prefix();
  f.state.pending = true;
  await addUnrelated(f);
  const before = counts(f);
  await assert.rejects(invoke(f, "execute"), /missing/);
  assert.deepEqual(counts(f), before);
});
test("actual CLI final boundary still refuses unrelated unresolved state after all five own operations confirmed", async () => {
  const f = await studyDeploymentFixture();
  for (let i = 0; i < 5; i++) {
    const step = await f.open(i);
    try {
      assert.equal((await step.run()).state, "confirmed");
    } finally {
      step.close();
    }
  }
  await addUnrelated(f);
  const before = counts(f);
  await assert.rejects(invoke(f, "execute"), /missing/);
  assert.deepEqual(counts(f), before);
});
test("actual CLI recovery retains orphan, prepared-journal and prior-canonical refusals", async () => {
  for (const failure of [
    "orphan",
    "missing-prepared",
    "prior-reorg",
  ] as const) {
    const { f, operation, path } = await prefix();
    f.state.pending = true;
    if (failure === "orphan") {
      const lease = new ActivationJournal(
        join(f.directory, "dispatch-custody.sqlite"),
      );
      try {
        lease.set(
          "controller:profiles",
          lease
            .get<{ profileHash: string }[]>("controller:profiles")!
            .filter((entry) => entry.profileHash !== operation.profileHash),
        );
      } finally {
        lease.close();
      }
    }
    if (failure === "missing-prepared") {
      const preserved = join(f.directory, "preserved");
      mkdirSync(preserved, { mode: 0o700 });
      renameSync(path, join(preserved, "pending.sqlite"));
    }
    if (failure === "prior-reorg") f.state.canonical = false;
    const before = counts(f);
    await assert.rejects(invoke(f, "execute"));
    assert.deepEqual(counts(f), before);
  }
});
