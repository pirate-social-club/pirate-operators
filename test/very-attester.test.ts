import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RewardAttester,
  type Dependencies,
} from "../services/very-attester/core.ts";
import {
  authentication,
  context,
  type AttesterConfig,
} from "../services/very-attester/policy.ts";
import { attestationTypes } from "../packages/protocol/index.ts";
import { proofFixture, deferred } from "./very-fixture.ts";

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const claimant = privateKeyToAccount(key(6));
const other = privateKeyToAccount(key(7));
const config: AttesterConfig = {
  chainId: 31337,
  pool: "0x1111111111111111111111111111111111111111",
  drawingId: "7",
  poolCodeHash: `0x${"11".repeat(32)}`,
  attester: privateKeyToAccount(key(5)).address,
  appId: "11111111-1111-4111-8111-111111111111",
};
function fixture() {
  const rows = new Map<string, unknown>();
  let now = 1800000000,
    sequence = 20,
    verifies = 0;
  let verify = async (_raw: string) => {
    verifies++;
  };
  const deps: Dependencies = {
    store: {
      get: <T>(k: string) => structuredClone(rows.get(k)) as T | undefined,
      set: (k, v) => {
        rows.set(k, structuredClone(v));
      },
    },
    now: () => now,
    random: (size) => `0x${(++sequence).toString(16).padStart(size * 2, "0")}`,
    inspect: async () => ({ deadline: 1800001000, timestamp: now }),
    verify: (raw) => verify(raw),
    privateKey: key(5),
  };
  const core = new RewardAttester(config, deps);
  return {
    rows,
    deps,
    core,
    advance: (seconds: number) => {
      now += seconds;
    },
    setVerify: (fn: typeof verify) => {
      verify = fn;
    },
    get verifies() {
      return verifies;
    },
  };
}
async function request(
  f: ReturnType<typeof fixture>,
  wallet = claimant,
  subject = "12345",
) {
  const challenge = await f.core.challenge({ claimant: wallet.address });
  return {
    challenge,
    input: {
      id: challenge.id,
      authorization: await wallet.signTypedData(
        authentication(config, challenge),
      ),
      proof: proofFixture(
        context(config).externalNullifier,
        challenge.binding,
        subject,
      ),
    },
  };
}

test("attester signs the exact claimant and pool; a lost response survives restart", async () => {
  const f = fixture();
  const { challenge, input } = await request(f);
  const permit = await f.core.issue(input);
  const signer = await recoverTypedDataAddress({
    domain: {
      name: "Pirate Reward Pool",
      version: "1",
      chainId: 31337,
      verifyingContract: config.pool,
    },
    types: attestationTypes,
    primaryType: "RewardAttestation",
    message: {
      scope: challenge.scope,
      claimant: claimant.address,
      nullifier: permit.nullifier,
      expiresAt: BigInt(permit.expiresAt),
    },
    signature: permit.signature,
  });
  assert.equal(signer, config.attester);
  assert.equal(Number(permit.expiresAt), challenge.expiresAt);
  const restarted = new RewardAttester(config, f.deps);
  assert.deepEqual(await restarted.issue(input), permit);
  assert.equal(f.verifies, 1);
  const saved = JSON.stringify([...f.rows]);
  for (const secret of [
    input.proof,
    input.authorization,
    "publicSignals",
    '"subject"',
  ])
    assert.ok(!saved.includes(secret));
});

test("one app ID is pinned across restarts and cannot be overridden per request", async () => {
  const f = fixture();
  for (const changed of [
    { ...config, appId: "22222222-2222-4222-8222-222222222222" },
    { ...config, drawingId: "8" },
    { ...config, poolCodeHash: `0x${"22".repeat(32)}` },
  ])
    assert.throws(
      () => new RewardAttester(changed, f.deps),
      /immutable_pool_configuration_changed/,
    );
  await assert.rejects(
    f.core.challenge({ claimant: claimant.address, appId: config.appId }),
    /invalid_input/,
  );
  assert.equal(f.verifies, 0);
});

test("mainnet, fixture testnet keys and an incorrect signing key are refused", () => {
  const f = fixture();
  assert.throws(
    () => new RewardAttester({ ...config, chainId: 8453 }, f.deps),
    /testnet_only/,
  );
  assert.throws(
    () => new RewardAttester({ ...config, chainId: 84532 }, f.deps),
    /public_fixture_key_refused/,
  );
  assert.throws(
    () => new RewardAttester(config, { ...f.deps, privateKey: key(7) }),
    /wrong_attester_key/,
  );
});

test("wallet signatures bind nonce, pool, scope, configuration and expiry", async () => {
  const f = fixture();
  const { challenge, input } = await request(f);
  const mutations = [
    { ...challenge, id: key(91) },
    { ...challenge, scope: key(92) },
    { ...challenge, configHash: key(93) },
    { ...challenge, expiresAt: challenge.expiresAt + 1 },
    { ...challenge, binding: "77" },
    { ...challenge, claimant: other.address },
  ];
  for (const changed of mutations) {
    const authorization = await claimant.signTypedData(
      authentication(config, changed),
    );
    await assert.rejects(
      f.core.issue({ ...input, authorization }),
      /invalid_authorization/,
    );
  }
  const wrongPool = {
    ...config,
    pool: "0x2222222222222222222222222222222222222222" as const,
  };
  await assert.rejects(
    f.core.issue({
      ...input,
      authorization: await claimant.signTypedData(
        authentication(wrongPool, challenge),
      ),
    }),
    /invalid_authorization/,
  );
  await assert.rejects(
    f.core.issue({
      ...input,
      authorization: await other.signTypedData(
        authentication(config, challenge),
      ),
    }),
    /invalid_authorization/,
  );
  assert.equal(f.verifies, 0);
});

test("wrong proof binding and provider rejection never create an attestation", async () => {
  const f = fixture();
  const { input } = await request(f);
  await assert.rejects(
    f.core.issue({ ...input, proof: proofFixture("1000001", "17") }),
    /invalid_proof_binding/,
  );
  f.setVerify(async () => {
    throw new Error("hosted_rejection");
  });
  await assert.rejects(f.core.issue(input), /hosted_rejection/);
  assert.ok(!JSON.stringify([...f.rows]).includes('"permit"'));
  f.setVerify(async () => {});
  assert.ok((await f.core.issue(input)).signature);
});

test("concurrent requests verify once and return the saved result afterwards", async () => {
  const f = fixture();
  const { input } = await request(f);
  const entered = deferred<void>(),
    release = deferred<void>();
  f.setVerify(async () => {
    entered.resolve();
    await release.promise;
  });
  const first = f.core.issue(input);
  await entered.promise;
  await assert.rejects(f.core.issue(input), /verification_in_progress/);
  release.resolve();
  const permit = await first;
  assert.deepEqual(
    await f.core.issue({
      ...input,
      proof: "a replacement proof cannot replace the consumed result",
    }),
    permit,
  );
});

test("an expired verification lease permits restart recovery but not a late old write", async () => {
  const f = fixture();
  const { input } = await request(f);
  const entered = deferred<void>(),
    release = deferred<void>();
  f.setVerify(async () => {
    entered.resolve();
    await release.promise;
  });
  const old = f.core.issue(input);
  const oldRejected = assert.rejects(old, /verification_superseded/);
  await entered.promise;
  f.advance(60);
  f.setVerify(async () => {});
  const restarted = new RewardAttester(config, f.deps);
  const permit = await restarted.issue(input);
  release.resolve();
  await oldRejected;
  assert.deepEqual(await restarted.issue(input), permit);
});

test("expiry is strict before and after hosted verification", async () => {
  const f = fixture();
  const { input } = await request(f);
  f.advance(300);
  await assert.rejects(f.core.issue(input), /challenge_expired/);
  assert.equal(f.verifies, 0);
  const g = fixture();
  const next = await request(g);
  g.setVerify(async () => {
    g.advance(300);
  });
  await assert.rejects(g.core.issue(next.input), /challenge_expired/);
  assert.ok(!JSON.stringify([...g.rows]).includes('"permit"'));
});

test("the same verified subject on two authenticated wallets has one reward identifier", async () => {
  const f = fixture();
  const a = await request(f, claimant),
    b = await request(f, other);
  assert.notEqual(a.challenge.binding, b.challenge.binding);
  const pa = await f.core.issue(a.input),
    pb = await f.core.issue(b.input);
  assert.equal(pa.nullifier, pb.nullifier);
  assert.notEqual(pa.signature, pb.signature);
});

test("chain failures, closed registration and clock skew fail without a permit", async () => {
  const f = fixture();
  f.deps.inspect = async () => {
    throw new Error("pool_changed");
  };
  await assert.rejects(
    f.core.challenge({ claimant: claimant.address }),
    /pool_changed/,
  );
  f.deps.inspect = async () => ({
    deadline: 1800000000,
    timestamp: 1800000000,
  });
  await assert.rejects(
    f.core.challenge({ claimant: claimant.address }),
    /registration_closed/,
  );
  f.deps.inspect = async () => ({
    deadline: 1800001000,
    timestamp: 1800000100,
  });
  await assert.rejects(
    f.core.challenge({ claimant: claimant.address }),
    /chain_clock_skew/,
  );
});
