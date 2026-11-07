import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire, syncBuiltinESMExports } from "node:module";

// No missed injection may launch a process or forward a request from this suite.
const cp = createRequire(import.meta.url)("node:child_process");
let forbiddenChildren = 0;
for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
])
  cp[name] = () => {
    forbiddenChildren++;
    throw Error("real_child_forbidden");
  };
syncBuiltinESMExports();
globalThis.fetch = async () => {
  throw Error("live_fetch_forbidden");
};

const { fixture } = await import("./study-operator-fixture.ts");
const { qualifyOperatorRuntime } = await import(
  "../harness/study-operator-runtime-admission.ts"
);
const { inspectExistingJournalReadOnly } = await import(
  "../harness/study-operator-readonly-adapter.ts"
);
const { operatorScope } = await import("../harness/study-operator-private.ts");
const { hashJson } = await import("../packages/community/common.ts");
const { digest } = await import("../harness/private-json.ts");
const { retainedLearningController, retainedLearningOperator } = await import(
  "../harness/study-release-profile.ts"
);
const { keccak256 } = await import("viem");
const publicTx = JSON.parse(
  await readFile(
    new URL("./fixtures/study-controller-public-raw.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.parse("2026-11-07T08:00:00Z"),
  blockHash = "0x" + "a".repeat(64);
const own = () => ({
  profileHash: "0x" + "1".repeat(64),
  nonce: publicTx.nonce,
  gasPriceWei: "1000000",
  maximumFeeWei: "1000000000000",
  raw: publicTx.raw,
  hash: publicTx.hash,
});
const ordinary = () => ({ ...own(), mined: { status: "success", block: 89 } });
const scalarMetadata = () => [
  { key: "op:nonce", value: 21 },
  { key: "run:profile", value: "0x" + "5".repeat(64) },
];
type Row = { key: string; value: unknown };

async function scenario(
  rows: Row[],
  options: {
    receipt?: "missing" | "reorganized" | "young" | "bad-status" | "reverted";
    controllerNonce?: number;
  } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "pirate-operator-sqlite-case-"),
  );
  const file = async (name: string, value: unknown) => {
    const path = join(directory, name);
    await writeFile(
      path,
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
    return { path, sha256: digest(await readFile(path)) };
  };
  const p = fixture();
  p.custody.record = join(directory, "custody.json");
  p.execution.runtimeEvidencePath = join(directory, "runtime.json");
  const scope = operatorScope(p),
    report = await file("report.txt", "Synthetic retention review fixture."),
    local = await file(
      "local-proof.txt",
      "Synthetic local retention proof fixture.",
    );
  const review = await file("review.json", {
    schema: "pirate.study-operator-preservation-review/1",
    decision: "accept-preservation-basis",
    ownerRole: "independent_reviewer",
    scopeHash: scope,
    oldModuleSha256: p.predecessor.moduleSha256,
    newModuleSha256: p.artifact.sha256,
    namespaces: p.objects,
    sourceHashes: p.artifact.sourceHashes,
    noStorageMigration: true,
    liveCounterValuesObserved: false,
    reportPath: report.path,
    reportSha256: report.sha256,
    localProofPath: local.path,
    localProofSha256: local.sha256,
  });
  const journal = join(directory, "journal.sqlite"),
    db = new DatabaseSync(journal);
  db.exec("CREATE TABLE records(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for (const row of rows)
    db.prepare("INSERT INTO records VALUES(?,?)").run(
      row.key,
      JSON.stringify(row.value),
    );
  db.close();
  await chmod(journal, 0o600);
  const journalSha256 = digest(await readFile(journal));
  const ticket = {
    ticketId: "synthetic-expired-published",
    sessionId: "0x" + "3".repeat(64),
    commitment: "0x" + "4".repeat(64),
    revision: 1,
  };
  const admission = await file("runtime.json", {
    schema: "pirate.study-operator-runtime-admission/1",
    scopeHash: scope,
    observedAt: new Date(now).toISOString(),
    counterEvidence: {
      kind: "reviewed-persistence-proof",
      reviewPath: review.path,
      reviewSha256: review.sha256,
    },
    opaqueOperatorState:
      "preserved-by-unchanged-namespace-and-reviewed-retention-proof",
    wallets: {
      expectedRows: 0,
      expectedStateSha256: hashJson([]),
      knownPublished: [ticket],
    },
    native: {
      operatorNonce: 190,
      controllerNonce: options.controllerNonce ?? 30,
    },
    journals: [
      {
        path: journal,
        sha256: journalSha256,
        format: "activation-journal",
        signer: retainedLearningController,
      },
    ],
  });
  p.retained.runtimeEvidenceSha256 = admission.sha256;
  const custody = await file("custody.json", {
    schema: "pirate.study-operator-custody/1",
    scopeHash: scope,
    ownerRole: "workspace_coordinator",
    inventoryCompleteForWindow: true,
    quiescentWriters: ["synthetic-only"],
    exclusions: p.custody.exclusions,
    expiresAt: p.window.deadline,
  });
  p.custody.sha256 = custody.sha256;
  const calls: string[] = [],
    receipts: string[] = [];
  const run = async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("/d1/database/"))
        return Response.json({
          success: true,
          result: [{ success: true, results: [] }],
        });
      if (String(url) === p.worker.origin + "/record")
        return Response.json({
          publication: { state: "published", confirmed: true, revision: 1 },
        });
      throw Error("live_fetch_forbidden");
    };
    const client = {
      getChainId: async () => 6343,
      getBlockNumber: async () => 100n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash:
          options.receipt === "reorganized" && blockNumber === 89n
            ? "0x" + "b".repeat(64)
            : blockHash,
      }),
      readContract: async () => ticket.commitment,
      getTransactionCount: async ({ address }: { address: string }) =>
        address === retainedLearningOperator.publisher
          ? 190
          : (options.controllerNonce ?? 30),
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        receipts.push(hash);
        if (options.receipt === "missing") {
          const error = Error("fixture_missing_receipt");
          error.name = "TransactionReceiptNotFoundError";
          throw error;
        }
        return {
          transactionHash: hash,
          blockNumber: options.receipt === "young" ? 90n : 89n,
          blockHash,
          status:
            options.receipt === "bad-status"
              ? "invented"
              : options.receipt === "reverted"
                ? "reverted"
                : "success",
        };
      },
    };
    try {
      return await qualifyOperatorRuntime(
        p,
        "synthetic-cloud-token",
        client as any,
        now,
      );
    } finally {
      globalThis.fetch = async () => {
        throw Error("live_fetch_forbidden");
      };
    }
  };
  return {
    run,
    calls,
    receipts,
    journal,
    journalSha256,
    unchanged: async () =>
      assert.equal(digest(await readFile(journal)), journalSha256),
  };
}

test("real SQLite null-prototype rows hash after explicit column normalization", async () => {
  const s = await scenario([{ key: "deployment", value: own() }]);
  const result = await inspectExistingJournalReadOnly(
    s.journal,
    s.journalSha256,
  );
  assert.equal(result.rowCount, 1);
  assert.match(result.recordsSha256, /^0x[0-9a-f]{64}$/);
  await s.unchanged();
});
for (const key of ["tx:0000000020", "deployment", "correction"]) {
  test(`actual qualification reads canonical signed ${key} even without a saved controller receipt`, async () => {
    const s = await scenario([
      { key, value: key.startsWith("tx:") ? ordinary() : own() },
      ...scalarMetadata(),
    ]);
    const result = await s.run();
    assert.equal(result.controllerNonce, 30);
    assert.deepEqual(s.receipts, [publicTx.hash]);
    assert.equal(s.calls.length, 2);
    assert.equal(forbiddenChildren, 0);
    await s.unchanged();
  });
}
test("deployment and correction allocations are both checked instead of disappearing behind tx prefix selection", async () => {
  const s = await scenario([
    { key: "deployment", value: own() },
    { key: "correction", value: own() },
  ]);
  await s.run();
  assert.equal(s.receipts.length, 2);
  await s.unchanged();
});
for (const key of ["deployment", "correction"]) {
  test(`actual qualification refuses prepared ${key} without signed bytes before receipt reads`, async () => {
    const value: any = own();
    delete value.raw;
    delete value.hash;
    const s = await scenario([{ key, value }]);
    await assert.rejects(s.run(), /native_transaction_missing/);
    assert.equal(s.receipts.length, 0);
    await s.unchanged();
  });
  test(`actual qualification refuses signed but unknown ${key} at the current native nonce`, async () => {
    const s = await scenario([{ key, value: own() }, ...scalarMetadata()], {
      receipt: "missing",
      controllerNonce: 20,
    });
    await assert.rejects(s.run(), /fixture_missing_receipt/);
    assert.equal(s.receipts.length, 1);
    await s.unchanged();
  });
  test(`actual qualification refuses malformed signed ${key} rather than omitting it`, async () => {
    const s = await scenario([
      { key, value: { ...own(), raw: "0x01", hash: keccak256("0x01") } },
    ]);
    await assert.rejects(s.run());
    assert.equal(s.receipts.length, 0);
    await s.unchanged();
  });
}
for (const receipt of ["reorganized", "young", "bad-status"] as const) {
  test(`actual qualification refuses ${receipt} receipt evidence for controller allocation`, async () => {
    const s = await scenario(
      [
        {
          key: "deployment",
          value: { ...own(), receipt: { status: "success" } },
        },
      ],
      { receipt },
    );
    await assert.rejects(s.run(), /native_not_canonical/);
    assert.equal(s.receipts.length, 1);
    await s.unchanged();
  });
}
test("canonical reverted controller transaction is settled and keeps its consumed nonce", async () => {
  const s = await scenario([{ key: "correction", value: own() }], {
    receipt: "reverted",
  });
  await s.run();
  assert.equal(s.receipts.length, 1);
  await s.unchanged();
});
test("unknown journal keys and metadata-only native inventories fail explicitly", async () => {
  for (const [rows, expected] of [
    [
      [{ key: "future-controller-operation", value: own() }],
      /journal_key_unsupported/,
    ],
    [
      [{ key: "run:profile", value: "0x" + "5".repeat(64) }],
      /native_inventory_empty/,
    ],
  ] as const) {
    const s = await scenario([...rows]);
    await assert.rejects(s.run(), expected);
    assert.equal(s.receipts.length, 0);
  }
});
test("run profile metadata requires its retained nonzero scalar hash shape", async () => {
  for (const value of [{}, 1, "0x" + "0".repeat(64), "not-a-profile-hash"]) {
    const s = await scenario([
      { key: "correction", value: own() },
      { key: "run:profile", value },
    ]);
    await assert.rejects(s.run(), /journal_run_profile_invalid/);
    assert.equal(s.receipts.length, 0);
    await s.unchanged();
  }
});
test("pending ordinary tx and allocated intents lacking a transaction fail closed", async () => {
  const a = await scenario([
    { key: "tx:0000000020", value: { ...ordinary(), mined: null } },
  ]);
  await assert.rejects(a.run(), /journal_pending_transaction/);
  assert.equal(a.receipts.length, 0);
  const b = await scenario([
    { key: "intent:record_result:fixture", value: { nonce: 20 } },
  ]);
  await assert.rejects(b.run(), /intent_transaction_missing/);
  assert.equal(b.receipts.length, 0);
  assert.equal(forbiddenChildren, 0);
});
