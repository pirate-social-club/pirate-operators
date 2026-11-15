// Actual entrypoint, SQLite, cryptography and pin codecs; simulated RPC and IPFS.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
  type Hex,
  type PublicClient,
} from "viem";
import { directoryAbi } from "../packages/community/directory-wire.ts";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import {
  OWNER_POLICY_VERSION,
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../packages/community/owner-policy.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  custodyScope,
  sha256File,
} from "../harness/megaeth/controller-inventory.ts";
import { readControllerTransaction } from "../harness/megaeth/controller-dispatch-catalog.ts";
import { configureAbi } from "../harness/megaeth/curated-configuration-plan.ts";
import {
  ownerActivationReadinessScope,
  ownerPolicySuccessor,
  type OwnerPolicyActivationProfile,
} from "../harness/megaeth/owner-policy-activation-plan.ts";
import {
  ownerActivationChecks,
  ownerActivationEvidenceKinds,
  ownerActivationMigrations,
} from "../harness/megaeth/owner-policy-activation-checks.ts";
import {
  ownerPolicyActivationMain,
  ownerPolicyActivationSourceHash,
  type OwnerPolicyActivationPorts,
} from "../harness/megaeth/owner-policy-activation.ts";
import { activationDirectoryCode } from "./study-activation-contract-fixture.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sourceHash = ownerPolicyActivationSourceHash();

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "owner-policy-activation-")),
    stateDirectory = join(directory, "controller"),
    pinDirectory = join(directory, "pins");
  const key = `0x${"c".padStart(64, "0")}` as Hex,
    account = privateKeyToAccount(key),
    controller = account.address.toLowerCase() as Hex;
  const state = {
    now: Date.now(),
    active: false,
    nonce: 31,
    pending: false,
    landed: true,
    lostSend: false,
    lostPin: false,
    pinRetained: false,
    alteredPredecessor: false,
    keys: 0,
    secrets: 0,
    adds: 0,
    sends: [] as Hex[],
  };
  const oldRaw = await account.signTransaction({
      type: "legacy",
      chainId: 6343,
      nonce: 30,
      to: controller,
      gas: 21000n,
      gasPrice: 1n,
      value: 0n,
    }),
    oldHash = keccak256(oldRaw);
  const inventoryPath = join(directory, "legacy.json"),
    custodyPath = join(directory, "custody.json"),
    readyPath = join(directory, "ready.json"),
    profilePath = join(directory, "profile.json");
  // Revisions one to three are the committed public manifests; four is the
  // Study activation shape (a new learning records contract).
  const three = [
    read("docs/deployments/first-song-managed-20261105.configuration.json")
      .configuration,
    read(
      "docs/deployments/first-song-managed-20261105.curated-configuration-plan.json",
    ).profile.manifest,
    read(
      "docs/deployments/learning-results-testnet-20261106.configuration.json",
    ).manifest,
  ].map((x) => ({ ...x, controller }));
  const history = [
    ...three,
    {
      ...three[2],
      configurationRevision: 4,
      learningRecords: `0x${"1".repeat(40)}`,
    },
  ];
  const manifest = ownerPolicySuccessor(history[3]),
    pin = await preparePin(
      new TextEncoder().encode(canonical(manifest)),
      "application/json",
    );
  writeFileSync(
    inventoryPath,
    JSON.stringify({
      controller,
      communityId: firstSong.directoryProfile.communityId,
      intents: { old: { nonce: 30, raw: oldRaw, hash: oldHash } },
    }),
    { mode: 0o600 },
  );
  const p: OwnerPolicyActivationProfile = {
    schema: "pirate.owner-policy-activation/1",
    chainId: 6343,
    communityId: firstSong.directoryProfile.communityId,
    controller,
    nonce: 31,
    history,
    historyHashes: history.map(hashJson),
    manifestSha256: hashJson(manifest),
    pin,
    sourceHash,
    release: {
      applicationProfile: hashText("application-profile"),
      applicationModule: hashText("application-module"),
      managedProfile: hashText("managed-profile"),
      managedModule: hashText("managed-module"),
      selectionSha256: hashText("selection"),
    },
    readiness: { record: readyPath, sha256: "0".repeat(64) },
    inventory: [
      {
        path: inventoryPath,
        sha256: sha256File(inventoryPath),
        format: "deploy-results-v2-custom",
      },
    ],
    custody: {
      record: custodyPath,
      sha256: "0".repeat(64),
      ownerRole: "workspace_coordinator",
      exclusions: ["synthetic legacy writers quiescent"],
    },
    gas: "1000000",
    maximumGasPriceWei: "10",
    dataFeeReserveWei: "100",
    maximumTotalWei: "10000100",
    notBefore: new Date(state.now - 1000).toISOString(),
    deadline: new Date(state.now + 60000).toISOString(),
  };
  const evidence = Object.fromEntries(
    ownerActivationEvidenceKinds.map((kind) => {
      const path = join(directory, kind + "-evidence.json");
      writeFileSync(path, JSON.stringify({ kind }), { mode: 0o600 });
      return [kind, { path, sha256: sha256File(path) }];
    }),
  );
  const refresh = () => {
    writeFileSync(
      readyPath,
      JSON.stringify({
        schema: "pirate.owner-policy-activation-readiness/1",
        scopeHash: ownerActivationReadinessScope(p),
        decision: "accept-activation",
        reviewedBy: "independent_reviewer",
        observedAt: new Date(state.now).toISOString(),
        validUntil: p.deadline,
        release: p.release,
        migrations: ownerActivationMigrations,
        checks: Object.fromEntries(ownerActivationChecks.map((k) => [k, true])),
        evidence,
      }),
      { mode: 0o600 },
    );
    p.readiness.sha256 = sha256File(readyPath);
    writeFileSync(
      custodyPath,
      JSON.stringify({
        schema: "pirate.controller-custody/1",
        scopeHash: custodyScope(p),
        ownerRole: "workspace_coordinator",
        inventoryCompleteForWindow: true,
        quiescentWriters: ["fixture"],
        exclusions: p.custody.exclusions,
        expiresAt: p.deadline,
      }),
      { mode: 0o600 },
    );
    p.custody.sha256 = sha256File(custodyPath);
    writeFileSync(profilePath, JSON.stringify(p), { mode: 0o600 });
  };
  refresh();
  const documents = new Map<string, string>(),
    logs = [] as any[],
    base = BigInt(firstSong.directoryProfile.deploymentBlock);
  // An unexpected predecessor: same revision number, different content.
  const altered = { ...history[3], learningRecords: `0x${"2".repeat(40)}` };
  for (const [i, c] of [...history, manifest, altered].entries()) {
    const bytes = canonical(c),
      ipfs = await preparePin(
        new TextEncoder().encode(bytes),
        "application/json",
      );
    documents.set(ipfs.uri.slice(7), bytes);
    logs.push({
      args: {
        communityId: p.communityId,
        revision: BigInt(i === 5 ? 4 : i + 1),
        controller,
        publisher: c.publisher,
        operatorPayments: c.operatorPayments,
        learningRecords: c.learningRecords,
        sha256Digest: ipfs.sha256,
        uri: ipfs.uri,
      },
      blockNumber: base + 10n + BigInt(i === 5 ? 3 : i),
      logIndex: i === 5 ? 3 : i,
      blockHash: hashText("block" + (base + 10n + BigInt(i === 5 ? 3 : i))),
      transactionHash: hashText("tx" + i),
    });
  }
  const visible = () =>
    [
      logs[0],
      logs[1],
      logs[2],
      state.alteredPredecessor ? logs[5] : logs[3],
      ...(state.active ? [logs[4]] : []),
    ] as any[];
  const transactions = new Map<
    Hex,
    { raw: Hex; landed: boolean }
  >();
  const blockHash = (block: bigint) => hashText("block" + block);
  const client = {
    getChainId: async () => 6343,
    getBlockNumber: async () => base + 100n,
    getBlock: async ({ blockNumber = base + 100n }: any = {}) => ({
      number: blockNumber,
      hash: blockHash(blockNumber),
      timestamp: 1794042000n,
    }),
    getCode: async () => activationDirectoryCode,
    getLogs: async ({ fromBlock, toBlock }: any) =>
      visible().filter(
        (x) => x.blockNumber >= fromBlock && x.blockNumber <= toBlock,
      ),
    readContract: async ({ functionName }: any) => {
      if (functionName !== "getCommunity") throw Error("unexpected read");
      const shown = visible(),
        log = shown.at(-1);
      return {
        registry: history[3].registry,
        tldHash: hashText(history[3].tld),
        configurationRevision: BigInt(shown.length),
        configuration: { ...log.args },
      };
    },
    getGasPrice: async () => 2n,
    getTransactionCount: async ({ blockTag }: any) =>
      state.nonce + (blockTag === "pending" && state.pending ? 1 : 0),
    getBalance: async () => 100000000000n,
    estimateGas: async () => 100000n,
    call: async () => ({
      data: encodeAbiParameters([{ type: "uint256" }], [1n]),
    }),
    getTransactionReceipt: async ({ hash }: any) => {
      if (hash === oldHash)
        return {
          transactionHash: hash,
          blockNumber: base + 50n,
          blockHash: blockHash(base + 50n),
          status: "success",
        };
      const configurationLog = visible().find(log => log.transactionHash === hash);
      if (configurationLog)
        return {
          transactionHash: hash,
          blockNumber: configurationLog.blockNumber,
          blockHash: configurationLog.blockHash,
          status: "success",
          logs: [{
            address: history[0].directory,
            blockNumber: configurationLog.blockNumber,
            blockHash: configurationLog.blockHash,
            transactionHash: hash,
            logIndex: configurationLog.logIndex,
            removed: false,
            topics: encodeEventTopics({ abi: directoryAbi, eventName: "ConfigurationPublished", args: {
              communityId: configurationLog.args.communityId,
            } }),
            data: encodeAbiParameters(directoryAbi[1].inputs.filter(input => !("indexed" in input && input.indexed)), [
              configurationLog.args.revision, configurationLog.args.controller,
              configurationLog.args.publisher, configurationLog.args.operatorPayments,
              configurationLog.args.learningRecords, configurationLog.args.sha256Digest, configurationLog.args.uri,
            ]),
          }],
        };
      const tx = transactions.get(hash);
      if (!tx?.landed) {
        const e = Error("missing");
        e.name = "TransactionReceiptNotFoundError";
        throw e;
      }
      return {
        transactionHash: hash,
        blockNumber: base + 80n,
        blockHash: blockHash(base + 80n),
        status: "success",
      };
    },
    getTransaction: async ({ hash }: any) => {
      const row = transactions.get(hash);
      if (!row) throw Error("missing");
      const tx = parseTransaction(row.raw);
      return {
        hash,
        from: controller,
        nonce: tx.nonce,
        chainId: 6343,
        to: tx.to,
        input: tx.data,
        gas: tx.gas,
        gasPrice: tx.gasPrice,
        value: 0n,
        blockHash: null,
      };
    },
    sendRawTransaction: async ({ serializedTransaction: raw }: any) => {
      state.sends.push(raw);
      const hash = keccak256(raw),
        known = transactions.get(hash);
      // A dropped transaction may land when the same signed bytes are resent.
      if (!known?.landed) {
        transactions.set(hash, { raw, landed: state.landed });
        if (state.landed) {
          state.nonce++;
          state.active = true;
        }
      }
      if (state.lostSend) throw Error("lost response");
      return hash;
    },
  } as unknown as PublicClient;
  const transport = async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === "https://rpc.filebase.io") {
      if (url.pathname === "/api/v0/add") {
        state.adds++;
        state.pinRetained = true;
        if (state.lostPin) throw Error("lost pin response");
        return Response.json({ Hash: p.pin.uri.slice(7) });
      }
      if (url.pathname === "/api/v0/pin/ls")
        return Response.json({
          Keys: state.pinRetained
            ? { [p.pin.uri.slice(7)]: { Type: "recursive" } }
            : {},
        });
      throw Error("unexpected provider path");
    }
    const cid = url.pathname.slice("/ipfs/".length),
      body = documents.get(cid);
    return body && !(cid === p.pin.uri.slice(7) && !state.pinRetained)
      ? new Response(body)
      : new Response("unavailable", { status: 503 });
  };
  const ports: OwnerPolicyActivationPorts = {
    client: () => client,
    stateDirectory,
    pinDirectory,
    transport,
    now: () => state.now,
    loadPinSecret: async () => {
      state.secrets++;
      return "synthetic-pin-token";
    },
    loadKey: () => {
      state.keys++;
      const row = readControllerTransaction(
        join(stateDirectory, hashJson(p).slice(2) + ".sqlite"),
        "deployment",
      );
      if (!row || row.raw) throw Error("key before durable unsigned intent");
      return key;
    },
  };
  const run = (extra: string[] = []) =>
    ownerPolicyActivationMain(
      ["--profile", profilePath, ...extra],
      ports,
    ) as Promise<any>;
  const execute = () =>
    run([
      "--execute",
      "--expect-profile",
      hashJson(p),
      "--key-file",
      "/synthetic/never-read",
    ]);
  return {
    directory,
    stateDirectory,
    pinDirectory,
    profile: p,
    profilePath,
    state,
    ports,
    refresh,
    run,
    execute,
  };
}

test("the default plan is one revision 4 to 5 configure changing only the revision and the admission policy", async () => {
  const f = await fixture();
  f.ports.client = () => {
    throw Error("default created client");
  };
  const result = await f.run();
  assert.equal(result.mode, "plan");
  const before = f.profile.history[3]!;
  assert.equal(result.manifest.configurationRevision, 5);
  assert.deepEqual(result.manifest.policies.admission, {
    version: UNREGISTERED_OWNER_POLICY_VERSION,
    sha256: UNREGISTERED_OWNER_POLICY_HASH,
  });
  assert.equal(before.policies.admission.version, OWNER_POLICY_VERSION);
  assert.equal(
    canonical({
      ...result.manifest,
      configurationRevision: 4,
      policies: {
        ...result.manifest.policies,
        admission: before.policies.admission,
      },
    }),
    canonical(before),
  );
  const call = decodeFunctionData({
    abi: configureAbi,
    data: result.operation.data,
  });
  assert.equal(call.args[1], 4n);
  for (const field of ["controller", "publisher", "learningRecords"] as const)
    assert.equal(
      call.args[2][field].toLowerCase(),
      before[field].toLowerCase(),
      field,
    );
  assert.equal(call.args[2].sha256Digest, f.profile.pin.sha256);
  assert.equal(result.operation.to, before.directory);
  assert.deepEqual(result.effects, {
    networkRequests: 0,
    keysRead: 0,
    stateWrites: 0,
    pinAdds: 0,
    transactions: 0,
  });
  assert.equal(existsSync(f.stateDirectory), false);
  assert.equal(f.state.keys + f.state.secrets + f.state.adds, 0);
});

test("an unexpected predecessor is refused before any secret, key, pin or send", async () => {
  // A profile whose revision four already names another policy.
  const f = await fixture();
  f.profile.history[3] = {
    ...f.profile.history[3]!,
    policies: {
      ...f.profile.history[3]!.policies,
      admission: {
        version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH,
      },
    },
  };
  f.profile.historyHashes[3] = hashJson(f.profile.history[3]);
  writeFileSync(f.profilePath, JSON.stringify(f.profile));
  await assert.rejects(f.run(), /owner_policy_activation_wrong_predecessor/);
  // A live directory whose revision four differs from the reviewed one.
  const g = await fixture();
  g.state.alteredPredecessor = true;
  await assert.rejects(g.execute(), /owner_policy_activation_directory_changed/);
  await assert.rejects(
    g.run(["--observe"]),
    /owner_policy_activation_directory_changed/,
  );
  // A live directory already past revision four.
  const h = await fixture();
  h.state.active = true;
  h.state.pinRetained = true;
  await assert.rejects(h.execute(), /owner_policy_activation_directory_changed/);
  for (const x of [g, h])
    assert.equal(
      x.state.keys + x.state.secrets + x.state.adds + x.state.sends.length,
      0,
    );
});

test("execute pins once, journals before signing, configures once and reports success only after revision five reads back", async () => {
  const f = await fixture();
  const result = await f.execute();
  assert.equal(result.state, "confirmed");
  assert.equal(result.complete, true);
  assert.equal(result.readback.latestNonce, 32);
  assert.deepEqual(
    [f.state.adds, f.state.secrets, f.state.keys, f.state.sends.length],
    [1, 1, 1, 1],
  );
  const tx = parseTransaction(f.state.sends[0]!);
  assert.equal(tx.nonce, 31);
  // A repeated run only reads the settled result back.
  const again = await f.execute();
  assert.equal(again.complete, true);
  assert.deepEqual(
    [f.state.adds, f.state.secrets, f.state.keys, f.state.sends.length],
    [1, 1, 1, 1],
  );
  const status = await f.run(["--status"]);
  assert.equal(status.complete, true);
  assert.equal(status.readback.latestNonce, 32);
});

test("a lost configure response reconciles the landed transaction without another key, pin secret or send", async () => {
  const f = await fixture();
  f.state.lostSend = true;
  const first = await f.execute();
  assert.equal(first.state, "unknown");
  assert.equal(first.complete, false);
  f.state.lostSend = false;
  const second = await f.execute();
  assert.equal(second.state, "confirmed");
  assert.equal(second.complete, true);
  assert.deepEqual(
    [f.state.adds, f.state.secrets, f.state.keys, f.state.sends.length],
    [1, 1, 1, 1],
  );
  // The status readback needs no key.
  f.ports.loadKey = () => {
    throw Error("status loaded key");
  };
  assert.equal((await f.run(["--status"])).complete, true);
});

test("a dropped unknown send rebroadcasts the same signed bytes and never allocates again", async () => {
  const f = await fixture();
  f.state.lostSend = true;
  f.state.landed = false;
  assert.equal((await f.execute()).state, "unknown");
  f.state.lostSend = false;
  f.state.landed = true;
  const result = await f.execute();
  assert.equal(result.state, "confirmed");
  assert.equal(f.state.keys, 1);
  assert.equal(f.state.sends.length, 2);
  assert.equal(f.state.sends[0], f.state.sends[1]);
});

test("a lost pin response is reconciled by content and never adds twice", async () => {
  const f = await fixture();
  f.state.lostPin = true;
  await assert.rejects(f.execute());
  f.state.lostPin = false;
  const result = await f.execute();
  assert.equal(result.complete, true);
  assert.equal(f.state.adds, 1);
  assert.equal(f.state.sends.length, 1);
});

test("each readiness gate, including a re-bound record with one field wrong, stops before the pin secret or key", async () => {
  const notAccepted = "owner_policy_activation_readiness_not_accepted";
  const cases: [string, (r: any) => void, string][] = [
    ["decision", (r) => (r.decision = "hold"), notAccepted],
    ["reviewer", (r) => (r.reviewedBy = "self"), notAccepted],
    ["scope", (r) => (r.scopeHash = "0x" + "9".repeat(64)), notAccepted],
    [
      "release",
      (r) => (r.release.managedProfile = "0x" + "8".repeat(64)),
      notAccepted,
    ],
    [
      "migrations",
      (r) => (r.migrations = ["0012_owner_budget_windows.sql"]),
      notAccepted,
    ],
    [
      "check",
      (r) => (r.checks.historicalOperationsDisposed = false),
      "owner_policy_activation_release_gate_missing",
    ],
    [
      "stale",
      (r) => (r.validUntil = new Date(0).toISOString()),
      "owner_policy_activation_readiness_stale",
    ],
  ];
  for (const [name, mutate, code] of cases) {
    const f = await fixture();
    const record = JSON.parse(readFileSync(f.profile.readiness.record, "utf8"));
    mutate(record);
    writeFileSync(f.profile.readiness.record, JSON.stringify(record), {
      mode: 0o600,
    });
    // Re-bind the digest so the content check, not the digest, refuses.
    f.profile.readiness.sha256 = sha256File(f.profile.readiness.record);
    writeFileSync(f.profilePath, JSON.stringify(f.profile));
    await assert.rejects(f.execute(), new RegExp(`^Error: ${code}$`), name);
    assert.equal(
      f.state.secrets + f.state.keys + f.state.sends.length,
      0,
      name,
    );
  }
});

test("a confirmed configure whose directory does not read back revision five is never reported complete", async () => {
  const f = await fixture();
  f.state.lostSend = true;
  assert.equal((await f.execute()).state, "unknown");
  // The landed transaction is confirmed, but the directory shows another revision four.
  f.state.lostSend = false;
  f.state.alteredPredecessor = true;
  await assert.rejects(
    f.execute(),
    /owner_policy_activation_directory_changed/,
  );
  await assert.rejects(
    f.run(["--status"]),
    /owner_policy_activation_directory_changed/,
  );
  assert.equal(f.state.sends.length, 1);
});

test("a pending same-raw configure is observed without another send", async () => {
  const f = await fixture();
  f.state.lostSend = true;
  f.state.landed = false;
  assert.equal((await f.execute()).state, "unknown");
  f.state.lostSend = false;
  f.state.pending = true;
  const result = await f.execute();
  assert.equal(result.state, "pending");
  assert.equal(result.complete, false);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.keys, 1);
});

test("missing independent readiness stops before the pin secret or key", async () => {
  const f = await fixture();
  writeFileSync(
    f.profile.readiness.record,
    JSON.stringify({ decision: "hold" }),
    { mode: 0o600 },
  );
  await assert.rejects(f.execute(), /owner_policy_activation_readiness/);
  assert.equal(f.state.secrets + f.state.keys + f.state.sends.length, 0);
});
