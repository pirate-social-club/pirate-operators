// Real D1 and signed operator HTTP. Historical tx/event facts are scripted,
// matching the existing app fixture; this module never broadcasts a sender.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { canonical, digest } from "../../packages/protocol/index.ts";
import { hashText } from "../../packages/community/common.ts";
import { parsePublicationWithdrawal } from "../../packages/protocol/publication-consent.ts";
import { publicationConsentAbi } from "../../packages/protocol/generated/publication-consent-v1.ts";
import { parseCommand } from "../../services/publication-command-contract.ts";
import { beginCommand } from "../../services/publication-command-store.ts";
import { publicationSelectionSource } from "../../services/publication-app-selection.ts";
import { propagatePublicationFence } from "../../services/publication-app-outbox.ts";
import { readPublicationJob } from "../../services/publication-command-operator.ts";
import { intentOf, type TxRow } from "../../services/operator-tx.ts";
import {
  publicationAppFixture,
  learner,
  other,
  payer,
} from "./publication-app.ts";

export type SubjectFixture = Awaited<ReturnType<typeof publicationAppFixture>>;
const q = (n: bigint) => ("0x" + n.toString(16)) as Hex;
export async function currentLearner(f: SubjectFixture, wallet: Address) {
  // Explicit disposable credential-binding fixture transition. It is not a
  // qualification claim for the product's account-linking user flow.
  await f.db
    .prepare(
      "UPDATE credential_bindings SET subject=? WHERE binding_id='binding'",
    )
    .bind(wallet.toLowerCase())
    .run();
}
export async function terminalWithdrawalA(f: SubjectFixture) {
  await currentLearner(f, learner.address);
  const parent = await f.prepare("A-reference");
  assert.equal(parent.status, 200, JSON.stringify(parent.value));
  const reference = parseCommand(parent.value.command);
  const prepared = await f.withdraw({
    purpose: "study-results",
    requestId: "A-terminal",
    sourceCommandId: reference.commandId,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  const command = parseCommand(prepared.value.command);
  assert.equal(command.action, "withdraw");
  const signature = await f.sign(command),
    accepted = await f.submit({ commandId: command.commandId, signature });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
  const job = readPublicationJob(f.store(), command.commandId);
  assert.ok(job);
  const intent = intentOf(f.store(), job.kind, job.ref);
  assert.ok(intent);
  const nonce = f.store().get<number>("op:nonce") ?? 0;
  const raw = await payer.signTransaction({
      type: "legacy",
      chainId: 31337,
      nonce,
      to: command.source.registry,
      data: job.data,
      value: 0n,
      gas: BigInt(job.fee.gas),
      gasPrice: BigInt(job.fee.gasPrice),
    }),
    hash = keccak256(raw);
  f.store().transaction(() => {
    f.store().set(`intent:${job.kind}:${job.ref}`, { ...intent, nonce });
    f.store().set("tx:" + String(nonce).padStart(10, "0"), {
      nonce,
      kind: job.kind,
      ref: job.ref,
      chainId: 31337,
      to: command.source.registry,
      data: job.data,
      gas: job.fee.gas,
      gasPrice: job.fee.gasPrice,
      raw,
      hash,
      broadcast: "attempted",
      mined: null,
      publicationV1: job.fee,
    } satisfies TxRow);
    f.store().set("op:nonce", nonce + 1);
  });
  const number = 999n,
    blockHash = digest("subject-sync-original-withdrawal"),
    timestamp = f.authority.state.safe.timestamp,
    w = parsePublicationWithdrawal(command.message),
    event = publicationConsentAbi.find(
      (e) => e.type === "event" && e.name === "PublicationWithdrawn",
    )!;
  f.authority.state.blocks.set(
    number,
    f.authority.block(number, blockHash, timestamp, [hash]),
  );
  f.authority.state.transactions.set(hash, {
    hash,
    from: payer.address.toLowerCase(),
    to: command.source.registry,
    input: job.data,
    nonce: q(BigInt(nonce)),
    value: "0x0",
    blockHash,
    blockNumber: q(number),
    transactionIndex: "0x0",
  });
  f.authority.state.receipts.set(hash, {
    transactionHash: hash,
    from: payer.address.toLowerCase(),
    to: command.source.registry,
    blockHash,
    blockNumber: q(number),
    transactionIndex: "0x0",
    status: "0x1",
    logs: [
      {
        address: command.source.registry,
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash,
        blockNumber: q(number),
        topics: encodeEventTopics({
          abi: publicationConsentAbi,
          eventName: "PublicationWithdrawn",
          args: {
            learner: w.learner,
            purposeHash: keccak256(stringToHex(w.purpose)),
          },
        }),
        data: encodeAbiParameters(
          event.inputs.filter((i) => !i.indexed),
          [w.expectedEpoch, w.expectedEpoch + 1n, command.digest],
        ),
      },
    ],
  });
  const observed = await f.call("commands/" + command.commandId);
  assert.equal(observed.status, 200, JSON.stringify(observed.value));
  assert.equal((observed.value.receipt as { state: string }).state, "recorded");
  const row = (await f.rows()).find((r) => r.command_id === command.commandId)!;
  assert.equal(row.result_state, "recorded");
  assert.equal(row.fence_generation, 1);
  assert.ok(row.fence_ack_json);
  return { command, row, signature, raw, hash, nonce };
}
export async function prepareB(f: SubjectFixture, requestId = "B-fresh") {
  await currentLearner(f, other.address);
  const response = await f.prepare(requestId);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const command = parseCommand(response.value.command);
  assert.equal(command.message.learner, other.address.toLowerCase());
  return { command, signature: await f.sign(command, other) };
}
/** Independent historical account used only to create an actual higher B
 * inhibition through durable original rows and authenticated operator HTTP. */
export async function higherRemoteB(f: SubjectFixture, generation: number) {
  const source = publicationSelectionSource(f.authority.release),
    accountId = "historical-account";
  await f.db
    .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
    .bind(accountId, digest("historical-author"), Number(f.now() * 1000n))
    .run();
  await f.db
    .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
    .bind(
      "historical-binding",
      accountId,
      "moss",
      6343,
      other.address.toLowerCase(),
      Number(f.now() * 1000n),
    )
    .run();
  const capture = {
    schema: "pirate.publication-app-original/1",
    accountId,
    bindingId: "historical-binding",
    authorId: digest("historical-author"),
    learner: other.address.toLowerCase(),
    origin: f.context.origin,
    releaseSelectionSha256: source.releaseSelectionSha256,
    sourceCommandId: null,
  };
  const parent = await beginCommand(f.ports.db, {
    source,
    accountId,
    requestId: "historical-reference",
    purpose: "study-results",
    action: "grant",
    nonce: digest("historical-reference-nonce"),
    nowMs: Number(f.now() * 1000n),
    capture,
  });
  for (let i = 1; i <= generation; i++) {
    const row = await beginCommand(f.ports.db, {
      source,
      accountId,
      requestId: "historical-stop-" + i,
      purpose: "study-results",
      action: "withdraw",
      nonce: digest("historical-stop-nonce-" + i),
      nowMs: Number(f.now() * 1000n),
      capture: { ...capture, sourceCommandId: parent.command_id },
    });
    await propagatePublicationFence(f.ports, row);
  }
  await f.db
    .prepare(
      "DELETE FROM credential_bindings WHERE binding_id='historical-binding'",
    )
    .run();
}
export function accountFenceKeys(f: SubjectFixture) {
  return f
    .store()
    .entries("publicationV1AccountFence:")
    .map((r) => r.key);
}
export async function artifact(f: SubjectFixture, label: string) {
  await f.artifact(label);
  const value = {
      schema: "pirate.publication-subject-sync/1",
      accountFences: f.store().entries("publicationV1AccountFence:"),
      learnerHeads: f.store().entries("publicationV1Head:"),
    },
    path = ".local/publication-app-integration/" + label + "-subject.json",
    bytes = canonical(value) + "\n";
  await writeFile(path, bytes);
  return { artifact: path, fileSha256: hashText(bytes) };
}
