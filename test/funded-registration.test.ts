import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import {
  keccak256,
  TransactionReceiptNotFoundError,
  type PublicClient,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  fundedRegistration,
  type RegistrationGrant,
} from "../packages/release/registration-operations.ts";
import {
  rootRegistrationAbi,
  rootRegistrationData,
  storyTestnet,
} from "../packages/community/registration-chain.ts";

import { registrationLogs } from "./fixtures/registration-receipt.ts";

test("a lost root-mint response reuses its captured hash, creator, nonce and bounded fee without another mint", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const path of [
      "apps/managed-moderation/migrations/0001_managed.sql",
      "packages/release/registration-schema.sql",
    ]) {
      const sql = await readFile(path, "utf8");
      await db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    const signer = privateKeyToAccount(`0x${"0".repeat(63)}1`),
      recipient = "0x2222222222222222222222222222222222222222",
      asset = "0x3333333333333333333333333333333333333333",
      id = `0x${"1".repeat(64)}` as Hex,
      blockHash = `0x${"3".repeat(64)}` as Hex;
    const code = "0x6000",
      codeHash = keccak256(code),
      uri =
        "ipfs://bafkreiabsnyic5vcde6vn37d3ljdpwqyxbyaqgjrkwqmbw4o545i6hpqfy";
    const grant: RegistrationGrant = {
      sha256: `0x${"2".repeat(64)}`,
      period: "fixture-v1",
      operator: signer.address.toLowerCase() as Hex,
      recipient,
      contentSha256: id,
      maximumGas: "2000000",
      maximumGasPrice: "2000000000",
      maximumTotalFee: "4000000000000000",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      codeHashes: { workflow: codeHash, nft: codeHash, registry: codeHash },
    };
    const input = {
      recipient,
      contentSha256: id,
      metadata: { uri, sha256: id },
      nftMetadata: { uri, sha256: id },
    } as const;
    let mined = false,
      raw: Hex | undefined,
      broadcasts = 0;
    const client = {
      getChainId: async () => 1315,
      getBlockNumber: async () => 101n,
      getCode: async () => code,
      getTransactionCount: async () => 3,
      getGasPrice: async () => 1000000000n,
      getBalance: async () => 10000000000000000n,
      estimateGas: async () => 1000000n,
      sendRawTransaction: async ({
        serializedTransaction,
      }: {
        serializedTransaction: Hex;
      }) => {
        broadcasts++;
        assert.ok(!raw || raw === serializedTransaction);
        raw = serializedTransaction;
        throw new Error("fixture response lost after broadcast");
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (!mined) throw new TransactionReceiptNotFoundError({ hash });
        assert.equal(hash, keccak256(raw!));
        return {
          status: "success",
          transactionHash: hash,
          blockNumber: 100n,
          blockHash,
          gasUsed: 500000n,
          effectiveGasPrice: 1000000000n,
          logs: registrationLogs(hash, blockHash, recipient, uri),
        };
      },
      getTransaction: async () => ({
        hash: keccak256(raw!),
        chainId: 1315,
        from: signer.address,
        to: storyTestnet.workflow,
        value: 0n,
        input: rootRegistrationData(input),
        blockNumber: 100n,
        blockHash,
      }),
      getBlock: async () => ({ hash: blockHash }),
      readContract: async () => {
        throw Error("historical state is unavailable");
      },
    } as unknown as PublicClient;
    assert.deepEqual(
      await fundedRegistration(
        db,
        id,
        grant,
        input,
        client,
        signer,
        "reconcile",
      ),
      { state: "absent" },
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS n FROM spending_budgets").first())!
        .n,
      0,
    );
    assert.equal(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM funded_registrations")
        .first())!.n,
      0,
    );
    const pending = await fundedRegistration(
      db,
      id,
      grant,
      input,
      client,
      signer,
    );
    assert.equal(pending.state, "uncertain");
    assert.equal(broadcasts, 1);
    assert.deepEqual(
      await fundedRegistration(
        db,
        id,
        grant,
        input,
        client,
        signer,
        "reconcile",
      ),
      pending,
    );
    assert.equal(broadcasts, 1);

    const saved = await db
      .prepare("SELECT prepared_json FROM funded_registrations")
      .first();
    mined = true;
    const result = await fundedRegistration(
      db,
      id,
      grant,
      input,
      client,
      signer,
    );
    assert.equal(result.state, "confirmed");
    assert.equal(broadcasts, 1);
    assert.deepEqual(
      await fundedRegistration(db, id, grant, input, client, signer),
      result,
    );
    assert.deepEqual(
      await db
        .prepare("SELECT prepared_json FROM funded_registrations")
        .first(),
      saved,
    );
    const fee = await db
      .prepare(
        "SELECT reserved,spent FROM spending_budgets WHERE asset='native_wei'",
      )
      .first();
    assert.deepEqual(fee, { reserved: "0", spent: "500000000000000" });
    await assert.rejects(
      fundedRegistration(
        db,
        `0x${"4".repeat(64)}`,
        grant,
        input,
        client,
        signer,
      ),
      /funding_cap_exhausted/,
    );
    await assert.rejects(
      fundedRegistration(
        db,
        id,
        grant,
        { ...input, recipient: asset },
        client,
        signer,
      ),
      /registration_grant_mismatch/,
    );
  } finally {
    await runtime.dispose();
  }
});

test("expiry during the awaited running claim cannot start a broadcast", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  const realNow = Date.now;
  try {
    const db = await runtime.getD1Database("DB");
    for (const path of [
      "apps/managed-moderation/migrations/0001_managed.sql",
      "packages/release/registration-schema.sql",
    ]) {
      const sql = await readFile(path, "utf8");
      await db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    const signer = privateKeyToAccount(`0x${"0".repeat(63)}1`),
      id = `0x${"1".repeat(64)}` as Hex,
      recipient = "0x2222222222222222222222222222222222222222",
      code = "0x6000",
      digest = keccak256(code),
      uri =
        "ipfs://bafkreiabsnyic5vcde6vn37d3ljdpwqyxbyaqgjrkwqmbw4o545i6hpqfy";
    const grant: RegistrationGrant = {
      sha256: `0x${"2".repeat(64)}`,
      period: "fixture-expiry",
      operator: signer.address.toLowerCase() as Hex,
      recipient,
      contentSha256: id,
      maximumGas: "2000000",
      maximumGasPrice: "2000000000",
      maximumTotalFee: "4000000000000000",
      expiresAt: Math.floor(realNow() / 1000) + 3600,
      codeHashes: { workflow: digest, nft: digest, registry: digest },
    };
    const input = {
      recipient,
      contentSha256: id,
      metadata: { uri, sha256: id },
      nftMetadata: { uri, sha256: id },
    } as const;
    let broadcasts = 0;
    const client = {
      getChainId: async () => 1315,
      getBlockNumber: async () => 101n,
      getCode: async () => code,
      getTransactionCount: async () => 3,
      getGasPrice: async () => 1000000000n,
      getBalance: async () => 10000000000000000n,
      estimateGas: async () => 1000000n,
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        throw new TransactionReceiptNotFoundError({ hash });
      },
      sendRawTransaction: async () => {
        broadcasts++;
        throw new Error("unexpected expired broadcast");
      },
    } as unknown as PublicClient;
    const { afterD1First } = await import("./fixtures/d1-after-first.ts");
    const paused = afterD1First(
      db,
      (sql) =>
        sql.startsWith("UPDATE funded_registrations SET state='running'"),
      () => {
        Date.now = () => grant.expiresAt * 1000 + 1;
      },
    );
    const result = await fundedRegistration(
      paused.db,
      id,
      grant,
      input,
      client,
      signer,
    );
    assert.equal(paused.seen(), 1);
    assert.equal(result.state, "uncertain");
    assert.equal(broadcasts, 0);
    assert.ok(
      (await db
        .prepare("SELECT prepared_json FROM funded_registrations")
        .first())!.prepared_json,
    );
  } finally {
    Date.now = realNow;
    await runtime.dispose();
  }
});
