/** Raw ABI/receipt/runtime verifier with a named SIMULATED read port. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type AbiParameter,
  type Hex,
} from "viem";
import { danceVerdictsAbi } from "../packages/dance-chain/abi.ts";
import type {
  DanceBlock,
  DanceLog,
  DanceReadPort,
} from "../packages/dance-chain/reader.ts";
import {
  verifyCanonicalDanceControl,
  demoteDanceControl,
  type DanceControlReadPort,
} from "../packages/dance-chain/control-reader.ts";
import { danceControlSimulation } from "./dance-control-simulation.ts";
import { dh } from "./dance-fixture.ts";

async function simulatedRawControl() {
  const f = await danceControlSimulation();
  const intent = await f.revoke(5);
  const { binding } = await f.journal.binding(intent.commandId);
  const rawTransaction = "0x010203" as Hex,
    transactionHash = keccak256(rawTransaction);
  const attempt = {
    attemptId: "raw_attempt",
    commandId: intent.commandId,
    nonce: "1",
    rawTransaction,
    transactionHash,
    guardedBindingHash: binding.bindingHash,
  };
  const event = danceVerdictsAbi.find(
    (e) => e.type === "event" && e.name === "CommandApplied",
  )!;
  const params = event.inputs.filter(
    (e) => !e.indexed,
  ) as readonly AbiParameter[];
  const time = BigInt(Math.floor(Date.now() / 1000));
  const block: DanceBlock = {
    number: 48n,
    hash: dh(48) as Hex,
    timestamp: time,
    transactions: [transactionHash],
  };
  const safe: DanceBlock = {
    number: 50n,
    hash: dh(50) as Hex,
    timestamp: time + 2n,
    transactions: [],
  };
  const log: DanceLog = {
    address: f.source.domain.verifier,
    blockNumber: block.number,
    blockHash: block.hash,
    transactionHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: danceVerdictsAbi,
      eventName: "CommandApplied",
      args: {
        caller: binding.caller as Hex,
        commandId: binding.wireId as Hex,
        operation: 3,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(params, [
      binding.commandHash,
      `0x${binding.wallet.slice(2).padStart(64, "0")}`,
      6n,
      time,
    ]),
  };
  const faults = {
    code: false,
    source: false,
    missing: false,
    replaced: false,
    unstable: false,
    receiptLog: false,
  };
  let rereads = 0;
  const rpc: DanceControlReadPort = {
    chainId: async () => 6343,
    safe: async () => safe,
    block: async (n) =>
      n === safe.number
        ? safe
        : {
            ...block,
            hash:
              faults.replaced || (faults.unstable && ++rereads > 1)
                ? (dh(49) as Hex)
                : block.hash,
          },
    receipt: async () =>
      faults.missing
        ? null
        : {
            status: "success",
            blockNumber: block.number,
            blockHash: block.hash,
            transactionHash,
            transactionIndex: 0,
            logs: [faults.receiptLog ? { ...log, data: "0x" } : log],
          },
    code: async () => (faults.code ? "0x6001" : f.code),
    sourceView: async () => ({
      sourceHash: faults.source ? (dh(909) as Hex) : f.source.sourceHash,
      communityId: f.source.domain.communityId,
      version: 1,
      capturePolicy: f.source.capturePolicy,
      capturePolicyRuntimeHash: f.source.capturePolicyRuntimeHash,
    }),
    registration: async () => {
      throw Error("not a registration reader");
    },
    at(anchor) {
      return {
        ...rpc,
        code: async (address, number) => {
          assert.equal(number, anchor.number);
          return rpc.code(address, number);
        },
        sourceView: async (address, number) => {
          assert.equal(number, anchor.number);
          return rpc.sourceView(address, number);
        },
      } as DanceReadPort;
    },
  };
  return { ...f, intent, binding, attempt, log, rpc, faults };
}
test("verifier binds exact caller/source/command, receipt-owned bytes, transaction position and resulting epoch", async () => {
  const f = await simulatedRawControl();
  try {
    const e = await verifyCanonicalDanceControl(
      f.rpc,
      f.intent,
      f.binding,
      f.attempt,
      f.log,
    );
    assert.equal(e.resultEpoch, 6);
    assert.equal(e.commandId, f.intent.commandId);
    assert.equal(e.state, "canonical");
    assert.equal(e.bindingHash, f.binding.bindingHash);
  } finally {
    f.close();
  }
});
for (const fault of [
  "code",
  "source",
  "missing",
  "unstable",
  "receiptLog",
] as const) {
  test(`raw control proof refuses ${fault}`, async () => {
    const f = await simulatedRawControl();
    try {
      f.faults[fault] = true;
      await assert.rejects(
        verifyCanonicalDanceControl(
          f.rpc,
          f.intent,
          f.binding,
          f.attempt,
          f.log,
        ),
      );
    } finally {
      f.close();
    }
  });
}
test("changed command/caller/wallet resource/epoch/removed log and old grant log cannot prove this revoke", async () => {
  const f = await simulatedRawControl();
  try {
    for (const log of [
      {
        ...f.log,
        topics: [f.log.topics[0]!, dh(2) as Hex, ...f.log.topics.slice(2)] as [
          Hex,
          ...Hex[],
        ],
      },
      {
        ...f.log,
        topics: [
          f.log.topics[0]!,
          f.log.topics[1]!,
          dh(3) as Hex,
          f.log.topics[3]!,
        ] as [Hex, ...Hex[]],
      },
      { ...f.log, removed: true },
      { ...f.log, data: `0x${"00".repeat(128)}` as Hex },
    ])
      await assert.rejects(
        verifyCanonicalDanceControl(f.rpc, f.intent, f.binding, f.attempt, log),
      );
    await assert.rejects(
      verifyCanonicalDanceControl(
        f.rpc,
        f.intent,
        { ...f.binding, caller: f.model.principals.moderator.wallet },
        f.attempt,
        f.log,
      ),
    );
    await assert.rejects(
      verifyCanonicalDanceControl(
        f.rpc,
        f.intent,
        f.binding,
        { ...f.attempt, rawTransaction: "0x04" },
        f.log,
      ),
    );
  } finally {
    f.close();
  }
});
test("missing receipt is uncertainty, stable canonical replacement is orphaning, and original raw proof is retained", async () => {
  const f = await simulatedRawControl();
  try {
    const e = await verifyCanonicalDanceControl(
      f.rpc,
      f.intent,
      f.binding,
      f.attempt,
      f.log,
    );
    f.faults.missing = true;
    const unknown = await demoteDanceControl(f.rpc, f.intent, f.binding, e);
    assert.equal(unknown.state, "uncertain");
    assert.equal(unknown.rawLogJson, e.rawLogJson);
    f.faults.replaced = true;
    const orphan = await demoteDanceControl(f.rpc, f.intent, f.binding, e);
    assert.equal(orphan.state, "orphaned");
    assert.equal(orphan.transactionHash, e.transactionHash);
    assert.equal(orphan.rawLogJson, e.rawLogJson);
  } finally {
    f.close();
  }
});
for (const fault of [
  "wallet_resource",
  "result_epoch",
  "command_hash",
  "event_time",
  "old_grant_replay",
] as const) {
  test(`receipt-owned raw event still refuses semantic mismatch ${fault}`, async () => {
    const f = await simulatedRawControl();
    try {
      const event = danceVerdictsAbi.find(
        (e) => e.type === "event" && e.name === "CommandApplied",
      )!;
      const params = event.inputs.filter(
        (e) => !e.indexed,
      ) as readonly AbiParameter[];
      const block = await f.rpc.block(48n);
      if (fault === "old_grant_replay") f.log.topics[3] = dh(2) as Hex;
      else
        f.log.data = encodeAbiParameters(params, [
          fault === "command_hash" ? dh(99) : f.binding.commandHash,
          fault === "wallet_resource"
            ? dh(99)
            : `0x${f.binding.wallet.slice(2).padStart(64, "0")}`,
          fault === "result_epoch" ? 7n : 6n,
          fault === "event_time" ? block.timestamp + 1n : block.timestamp,
        ]);
      // The simulated receipt owns this same mutated log object: rejection must
      // reach exact command/resource/epoch checks, not just raw-log mismatch.
      await assert.rejects(
        verifyCanonicalDanceControl(
          f.rpc,
          f.intent,
          f.binding,
          f.attempt,
          f.log,
        ),
      );
    } finally {
      f.close();
    }
  });
}
