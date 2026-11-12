/** Named simulations for actual SQLite guard tests. NOT real canonical proof,
 * provider, MOSS, or current production source acceptance. */
import { keccak256, type Address, type Hex } from "viem";
import { canonical } from "../packages/community/common.ts";
import { canonicalDanceControlBinding } from "../packages/dance-chain/control-command.ts";
import { danceSourceHash } from "../packages/dance-chain/wire.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { DanceControlStore } from "../packages/dance/control-store.ts";
import type {
  DanceControlEvidence,
  DanceRevokeContext,
  DanceRoleStamp,
} from "../packages/dance/control-contracts.ts";
import type { DanceControlIntent } from "../packages/dance/contracts.ts";
import { sqliteDanceFixture } from "./dance-sqlite-fixture.ts";
import { dh, dw } from "./dance-fixture.ts";

export async function danceControlSimulation() {
  const f = sqliteDanceFixture(),
    code = "0x6000" as Hex,
    codeHash = keccak256(code);
  const domain = {
    chainId: 6343n,
    verifier: dw(20) as Address,
    communityId: f.model.pin.communityId as Hex,
  };
  const pin = {
    directory: dw(30) as Address,
    directoryRuntimeHash: codeHash,
    v4: dw(31) as Address,
    v4RuntimeHash: codeHash,
    posts: dw(32) as Address,
    postsRuntimeHash: codeHash,
    fixedPublisher: dw(22) as Address,
    publicityPolicyHash: dh(23) as Hex,
    rulesSha256: dh(6) as Hex,
    termsSha256: dh(5) as Hex,
    rubricSha256: dh(8) as Hex,
    mediaPolicySha256: dh(4) as Hex,
    runtimeCodeHash: codeHash,
    deploymentBlock: 1n,
  };
  const source: DanceCanonicalSource = {
    schema: "pirate.dance-verdict/1",
    domain,
    pin,
    sourceHash: danceSourceHash(domain, pin),
    capturePolicy: dw(33) as Address,
    capturePolicyRuntimeHash: codeHash,
  };
  Object.assign(f.model.pin, {
    sourceHash: source.sourceHash,
    runtimeCodeHash: codeHash,
  });
  const journal = new DanceControlStore(f.store);
  let expected = 5,
    current = 5,
    owner = 1,
    head = 40;
  let stamp: DanceRoleStamp | undefined;
  const evidence = new Map<string, DanceControlEvidence>();
  f.ports.controlBinding = async (i, caller) =>
    canonicalDanceControlBinding(source, i, caller);
  f.ports.reviewerRoleEpoch = async () => expected;
  const authority = f.ports.authority;
  f.ports.authority = async (...args) => {
    const facts = await authority(...args);
    if (facts.reviewer) facts.reviewer.roleEpoch = current;
    if (stamp && facts.actor.accountId === "moderator")
      facts.canonicalRoleProjection = stamp;
    return facts;
  };
  const expiry = Math.ceil((Date.now() + 86400000) / 1000) * 1000;
  await f.service.permissions.delegate("owner", "initial_grant", {
    delegationId: "grant_moderator",
    accountId: "moderator",
    operation: "grant",
    expiresAtMs: expiry,
  });
  f.model.delegates.add("moderator"); // Explicit simulated accepted role, not D1 grant.
  let seq = 0;
  async function revoke(epoch = 5, command = "revoke_" + ++seq) {
    expected = epoch;
    return f.service.permissions.delegate("owner", command, {
      delegationId: "grant_moderator",
      accountId: "moderator",
      operation: "revoke",
      expiresAtMs: 0,
    });
  }
  async function simulatedVerifiedControl(
    i: DanceControlIntent,
    guarded = true,
  ) {
    const { binding } = await journal.binding(i.commandId);
    const rawTransaction =
      `0x${(100 + seq).toString(16).padStart(2, "0")}` as Hex;
    const transactionHash = keccak256(rawTransaction);
    if (!evidence.has(i.commandId)) {
      const attempt = {
        attemptId: "attempt_" + i.commandId,
        commandId: i.commandId,
        nonce: String(seq),
        rawTransaction,
        transactionHash,
      };
      if (guarded) {
        f.db.sqlite
          .prepare("UPDATE dance_outbox SET status='ready' WHERE command_id=?")
          .run(i.commandId);
        await f.store.attempt(attempt, [{ sql: "1", values: [] }]);
      } else await f.store.retainAttemptEvidence(attempt);
    }
    const old = evidence.get(i.commandId);
    const e: DanceControlEvidence = old
      ? { ...old, anchorNumber: head, anchorHash: dh(1000 + head) }
      : {
          version: "pirate.dance-control-evidence/1",
          commandId: i.commandId,
          bindingHash: binding.bindingHash,
          sourceHash: binding.sourceHash,
          wallet: binding.wallet,
          state: "canonical",
          resultEpoch: i.expectedReviewerEpoch + 1,
          blockNumber: head - 2,
          blockHash: dh(1000 + head - 2),
          transactionHash,
          transactionIndex: 0,
          logIndex: 0,
          anchorNumber: head,
          anchorHash: dh(1000 + head),
          rawLogJson: '{"simulation":"verified_control_port"}',
          reason: null,
        };
    evidence.set(i.commandId, e);
    await journal.record(e);
    return e;
  }
  async function project(
    epoch: number,
    options: {
      wallet?: string;
      sourceHash?: string;
      active?: boolean;
      ownerEpoch?: number;
      configurationRevision?: number;
    } = {},
  ) {
    head++;
    current = epoch;
    for (const [id, e] of evidence)
      if (e.state === "canonical") {
        const refreshed = {
          ...e,
          anchorNumber: head,
          anchorHash: dh(1000 + head),
        };
        evidence.set(id, refreshed);
        await journal.record(refreshed);
      }
    const wallet = (
        options.wallet ?? f.model.principals.moderator.wallet
      ).toLowerCase(),
      sourceHash = options.sourceHash ?? source.sourceHash;
    const previous = await journal.role(domain.communityId, sourceHash, wallet);
    const active = options.active !== false;
    const result = await journal.projectRole(
      {
        communityId: domain.communityId,
        sourceHash,
        wallet,
        anchorNumber: head,
        anchorHash: dh(1000 + head),
        ownerEpoch: options.ownerEpoch ?? owner,
        configurationRevision: options.configurationRevision ?? owner,
        ownerValidFromMs: Date.now() - 10000,
        ownerExpiresAtMs: Date.now() + 86400000,
        roleEpoch: active ? epoch : null,
        roleExpiresAtMs: active ? Date.now() + 86400000 : null,
        state: active ? "active" : "inactive",
        observationJson: canonical({
          simulation: "reviewed_role_port",
          head,
          epoch,
          active,
          owner,
        }),
      },
      previous?.revision ?? 0,
    );
    if (
      wallet === f.model.principals.moderator.wallet &&
      sourceHash === source.sourceHash
    )
      stamp = result;
    return result;
  }
  function context(epoch = current, observation = stamp): DanceRevokeContext {
    return {
      sourceHash: source.sourceHash,
      roleEpoch: epoch,
      ownerEpoch: owner,
      configurationRevision: owner,
      observation,
    };
  }
  const denied = (
    ctx = context(),
    account = "moderator",
    wallet = f.model.principals.moderator.wallet,
  ) => f.store.locallyRevoked(domain.communityId, account, wallet, ctx);
  function rotateOwner() {
    owner++;
    f.model.setOwner();
  }
  return {
    ...f,
    journal,
    source,
    code,
    evidence,
    revoke,
    simulatedVerifiedControl,
    project,
    context,
    denied,
    rotateOwner,
    setCurrent: (epoch: number) => {
      current = epoch;
    },
    advanceHead: () => {
      head++;
    },
    head: () => head,
  };
}
