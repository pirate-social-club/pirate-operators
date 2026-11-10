import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeFunctionData, keccak256, parseTransaction } from "viem";
import { studyDeploymentFixture } from "./study-deployment-fixture.ts";
import { studyDeploymentPlan } from "../harness/megaeth/study-deployment-plan.ts";
import { studyDeploymentMain } from "../harness/megaeth/study-deployment.ts";
import { studyDeploymentStatus } from "../harness/megaeth/study-deployment-runner.ts";
import { registerControllerOperation } from "../harness/megaeth/controller-dispatch-catalog.ts";
import { ActivationJournal } from "../harness/megaeth/activation-journal.ts";
import type { CorrectionTransaction } from "../harness/megaeth/study-correction-runner.ts";
import {
  sha256File,
  readControllerInventory,
} from "../harness/megaeth/controller-inventory.ts";

const hash = `0x${"1".repeat(64)}` as const;
test("public deployment planning binds five fixed operations without RPC, private files or execution state", async () => {
  const f = await studyDeploymentFixture();
  const profile = structuredClone(f.profile);
  profile.inventory[0].path = "/unread-private-inventory";
  profile.custody.record = "/unread-private-custody";
  const path = join(f.directory, "public-profile.json");
  writeFileSync(path, JSON.stringify(profile));
  const before = f.files(),
    snapshots = before.map((p) => sha256File(join(f.directory, p)));
  let clients = 0;
  const result = await studyDeploymentMain(["--profile", path], {
    artifact: f.artifact,
    client: () => {
      clients++;
      throw Error("network_must_not_start");
    },
    stateDirectory: join(f.directory, "must-not-exist"),
  });
  assert.equal(result.mode, "plan");
  assert.equal(clients, 0);
  assert.deepEqual(f.files(), before);
  assert.deepEqual(
    before.map((p) => sha256File(join(f.directory, p))),
    snapshots,
  );
  assert.equal(existsSync(join(f.directory, "must-not-exist")), false);
  const plan = studyDeploymentPlan(profile, f.artifact);
  assert.deepEqual(
    plan.operations.map((row) => row.nonce),
    [25, 26, 27, 28, 29],
  );
  assert.equal(plan.operations[0].to, undefined);
  assert(plan.operations.slice(1).every((row) => row.to === profile.contract));
  assert.deepEqual(
    plan.operations
      .slice(1)
      .map(
        (row) =>
          decodeFunctionData({ abi: f.artifact.abi, data: row.data })
            .functionName,
      ),
    ["setGrader", "setGrader", "activatePolicy", "activatePolicy"],
  );
  assert.equal(plan.maximumFeeWei, "120000500");
  assert.deepEqual(plan.effects, {
    networkRequests: 0,
    keysRead: 0,
    stateWrites: 0,
    transactions: 0,
  });
});

test("deployment planning rejects source, identity, policy, nonce, scope and finite-bound substitutions", async () => {
  const f = await studyDeploymentFixture();
  const invalid = [
    (p: typeof f.profile) => {
      p.chainId = 1 as 6343;
    },
    (p: typeof f.profile) => {
      p.publicityPolicy = hash;
    },
    (p: typeof f.profile) => {
      p.sourceHash = hash;
    },
    (p: typeof f.profile) => {
      p.artifactHash = hash;
    },
    (p: typeof f.profile) => {
      p.contract = p.resultsV2.contract;
    },
    (p: typeof f.profile) => {
      p.nonce++;
    },
    (p: typeof f.profile) => {
      p.maximumTotalWei = "1";
    },
    (p: typeof f.profile) => {
      p.gas.deploy = "0";
    },
    (p: typeof f.profile) => {
      p.deadline = new Date(Date.parse(p.notBefore) + 900001).toISOString();
    },
    (p: typeof f.profile) => {
      p.policies.study.sha256 = hash;
    },
    (p: typeof f.profile) => {
      p.policies.karaoke.uri += "x";
    },
    (p: typeof f.profile) => {
      p.policies.study.effectivePeriod = "0";
    },
    (p: typeof f.profile) => {
      p.inventory.push(p.inventory[0]);
    },
    (p: typeof f.profile) => {
      p.custody.exclusions = [];
    },
    (p: typeof f.profile) => {
      Object.assign(p, { unknown: true });
    },
  ];
  for (const change of invalid) {
    const p = structuredClone(f.profile);
    change(p);
    assert.throws(() => studyDeploymentPlan(p, f.artifact));
  }
  const file = join(f.directory, "expired.json"),
    p = structuredClone(f.profile);
  p.notBefore = new Date(Date.now() - 60000).toISOString();
  p.deadline = new Date(Date.now() - 1).toISOString();
  writeFileSync(file, JSON.stringify(p));
  let clients = 0;
  await assert.rejects(
    studyDeploymentMain(
      [
        "--profile",
        file,
        "--execute",
        "--expect-profile",
        studyDeploymentPlan(p, f.artifact).profileHash,
        "--key-file",
        "/not-read",
      ],
      {
        artifact: f.artifact,
        client: () => {
          clients++;
          throw Error("network_must_not_start");
        },
      },
    ),
    /window_closed/,
  );
  assert.equal(clients, 0);
});

test("all five operations use durable unsigned preparation before keys and preserve exact confirmed bytes", async () => {
  const f = await studyDeploymentFixture();
  for (let index = 0; index < 5; index++) {
    const step = await f.open(index);
    try {
      const result = await step.run(() => {
        const entries = step.lease.get<
          { profileHash: string; stage: string }[]
        >("controller:profiles")!;
        assert.equal(
          entries.find((row) => row.profileHash === step.operation.profileHash)
            ?.stage,
          "prepared",
        );
        assert.equal(
          step.journal.get<CorrectionTransaction>("deployment")!.nonce,
          25 + index,
        );
        return f.loadKey();
      });
      assert.equal(result.state, "confirmed");
      const original = step.journal.get<CorrectionTransaction>("deployment")!;
      assert.equal(parseTransaction(original.raw!).nonce, 25 + index);
      assert.equal(original.hash, keccak256(original.raw!));
      assert.equal(
        (
          await step.run(() => {
            throw Error("key_must_not_be_read");
          })
        ).state,
        "confirmed",
      );
      assert.equal(
        step.journal.get<CorrectionTransaction>("deployment")!.raw,
        original.raw,
      );
    } finally {
      step.close();
    }
  }
  assert.equal(f.state.stage, 5);
  assert.equal(f.state.keyReads, 5);
  assert.equal(f.state.sends.length, 5);
  const db = new DatabaseSync(join(f.directory, "dispatch-custody.sqlite"), {
    readOnly: true,
  });
  const catalog = JSON.parse(
    (
      db
        .prepare("SELECT value FROM records WHERE key='controller:profiles'")
        .get() as { value: string }
    ).value,
  ) as { journalKey: string; nonce: number }[];
  db.close();
  assert.deepEqual(
    catalog.map((row) => [row.journalKey, row.nonce]),
    [
      ["deployment", 25],
      ["deployment", 26],
      ["deployment", 27],
      ["deployment", 28],
      ["deployment", 29],
    ],
  );
});

test("lost response and matching pending transaction reuse one signed row and conservative charge", async () => {
  const f = await studyDeploymentFixture();
  f.state.landed = false;
  f.state.lostResponse = true;
  const step = await f.open();
  try {
    assert.equal((await step.run()).state, "unknown");
    const original = step.journal.get<CorrectionTransaction>("deployment")!;
    f.state.pending = true;
    assert.equal(
      (
        await step.run(() => {
          throw Error("no_new_key");
        })
      ).state,
      "pending",
    );
    f.state.wrongPending = true;
    await assert.rejects(step.run(), /pending_conflict/);
    f.state.wrongPending = false;
    f.state.pending = false;
    const tx = f.transactions.get(original.hash!)!;
    tx.landed = true;
    f.state.stage = 1;
    f.state.consumed = 1;
    assert.equal(
      (
        await step.run(() => {
          throw Error("no_new_key");
        })
      ).state,
      "confirmed",
    );
    assert.equal(
      step.journal.get<CorrectionTransaction>("deployment")!.maximumFeeWei,
      original.maximumFeeWei,
    );
    assert.equal(
      step.journal.get<CorrectionTransaction>("deployment")!.raw,
      original.raw,
    );
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.keyReads, 1);
  } finally {
    step.close();
  }
});

test("public and fee boundaries fail before key access", async () => {
  for (const change of [
    "chain",
    "code",
    "revision",
    "nonce",
    "gas",
    "price",
    "balance",
    "policy",
  ] as const) {
    const f = await studyDeploymentFixture(),
      step = await f.open();
    try {
      if (change === "chain") f.state.chain = 1;
      if (change === "code") f.state.predecessorCode = "0x6001";
      if (change === "revision") f.state.directoryRevision = 4n;
      if (change === "nonce") f.state.pending = true;
      if (change === "gas") f.state.gas = 10000001n;
      if (change === "price") f.state.price = 11n;
      if (change === "balance") f.state.balance = 1n;
      if (change === "policy") f.state.policyBytes = false;
      await assert.rejects(step.run());
      assert.equal(f.state.keyReads, 0, change);
      assert.equal(f.state.sends.length, 0, change);
    } finally {
      step.close();
    }
  }
});

test("a changed boundary after signing retains signed bytes without broadcast, then recovers without key access", async () => {
  const f = await studyDeploymentFixture(),
    step = await f.open();
  try {
    await assert.rejects(
      step.run(() => {
        f.state.predecessorCode = "0x6001";
        return f.loadKey();
      }),
      /predecessor_code_changed/,
    );
    const stored = step.journal.get<CorrectionTransaction>("deployment")!;
    assert(stored.raw);
    assert.equal(f.state.sends.length, 0);
    f.state.predecessorCode = "0x6000";
    assert.equal(
      (
        await step.run(() => {
          throw Error("no_new_key");
        })
      ).state,
      "confirmed",
    );
    assert.equal(f.state.sends[0], stored.raw);
    assert.equal(f.state.keyReads, 1);
  } finally {
    step.close();
  }
});

test("reverted deployment is retained, does not advance the sequence and may clear only through canonical consumed nonce evidence", async () => {
  const f = await studyDeploymentFixture(),
    step = await f.open();
  f.state.receiptStatus = "reverted";
  try {
    assert.equal((await step.run()).state, "reverted");
    assert.equal((await step.run()).state, "reverted");
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.stage, 0);
  } finally {
    step.close();
  }
  const lease = new ActivationJournal(
    join(f.directory, "dispatch-custody.sqlite"),
  );
  try {
    const next = {
      profileHash: hash,
      nonce: 26,
      controller: f.profile.controller,
      journalKey: "correction" as const,
    };
    f.state.canonical = false;
    await assert.rejects(
      registerControllerOperation(
        f.client,
        next,
        lease,
        join(f.directory, hash.slice(2) + ".sqlite"),
      ),
      /unresolved/,
    );
    f.state.canonical = true;
    assert.equal(
      (
        await registerControllerOperation(
          f.client,
          next,
          lease,
          join(f.directory, hash.slice(2) + ".sqlite"),
        )
      ).registered,
      2,
    );
  } finally {
    lease.close();
  }
});

test("prepared deployment cannot be hidden from correction inventory or a lost signer catalog", async () => {
  const f = await studyDeploymentFixture(),
    step = await f.open();
  await assert.rejects(
    step.run(() => {
      throw Error("simulated_signing_crash");
    }),
    /simulated_signing_crash/,
  );
  const path = step.path;
  step.close();
  f.profile.inventory = [
    { path, sha256: sha256File(path), format: "activation-journal" },
  ];
  f.refreshCustody();
  await assert.rejects(
    readControllerInventory(f.client, f.profile, 199n),
    /unresolved_allocation/,
  );
  const db = new DatabaseSync(join(f.directory, "dispatch-custody.sqlite"));
  db.exec("DELETE FROM records");
  db.close();
  await assert.rejects(f.open(), /namespace_orphan/);
  assert.equal(f.state.sends.length, 0);
});

test("missing prepared journal refuses recovery after unsigned preparation", async () => {
  const f = await studyDeploymentFixture(),
    step = await f.open();
  try {
    await assert.rejects(
      step.run(() => {
        throw Error("simulated_signing_crash");
      }),
    );
  } finally {
    step.close();
  }
  renameSync(step.path, step.path + ".preserved");
  await assert.rejects(
    f.open(),
    /namespace_sidecar|ENOENT|prepared_journal_missing/,
  );
  assert.equal(f.state.sends.length, 0);
});

test("same-signer raw substitution and a stored gas price above the reviewed cap refuse status", async () => {
  const f = await studyDeploymentFixture();
  const operation = studyDeploymentPlan(f.profile, f.artifact).operations[0];
  for (const changed of ["recipient", "price"] as const) {
    const gasPrice = changed === "price" ? 11n : 2n;
    const raw = await f.account.signTransaction({
      type: "legacy",
      chainId: 6343,
      nonce: operation.nonce,
      ...(changed === "recipient" ? { to: f.profile.grader } : {}),
      data: operation.data,
      gas: BigInt(operation.gas),
      gasPrice,
      value: 0n,
    });
    await assert.rejects(
      studyDeploymentStatus(f.client, operation, {
        profileHash: operation.profileHash,
        nonce: operation.nonce,
        maximumFeeWei: operation.maximumFeeWei,
        gasPriceWei: gasPrice.toString(),
        raw,
        hash: keccak256(raw),
      }),
      changed === "price" ? /price_changed/ : /transaction_changed/,
    );
  }
  assert.equal(f.state.keyReads, 0);
  assert.equal(f.state.sends.length, 0);
});
