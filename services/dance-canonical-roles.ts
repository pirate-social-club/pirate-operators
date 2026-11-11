import type { Address, PublicClient } from "viem";
import { bytes32, insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/abi.ts";
import { directoryAbi } from "../packages/community/directory-reader.ts";
import { address } from "../packages/community/manifest-core.ts";
import {
  verifyDanceSourceAt,
  type DanceCanonicalSource,
} from "../packages/dance-chain/reader.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { danceAccountCommitment } from "../packages/dance-chain/wire.ts";
import { danceId } from "../packages/dance/validation.ts";

const count = (n: bigint) => {
  insist(
    n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER),
    "dance_authority_epoch_unavailable",
    503,
  );
  return Number(n);
};

export interface DanceRoleIdentity {
  accountId: string;
  wallet: Address;
}

/** Pin the role and both known identities to the same safe block. Local
 * account/consent and final durable revocation guards remain separate. */
export async function observeCanonicalDanceRole(input: {
  client: PublicClient;
  source: DanceCanonicalSource;
  config: CommunityConfig;
  actor: DanceRoleIdentity;
  learner: DanceRoleIdentity;
}) {
  const { client, source, config } = input,
    { pin, domain } = source;
  const rpc = danceReadPort(client);
  insist(
    domain.chainId === 6343n &&
      (await rpc.chainId()) === 6343 &&
      config.chainId === 6343 &&
      config.communityId === domain.communityId &&
      config.directory === pin.directory &&
      config.postsContract === pin.posts &&
      config.publisher === pin.fixedPublisher &&
      config.learningRecords === pin.v4,
    "dance_canonical_source_changed",
    503,
  );
  const safe = await rpc.safe();
  insist(
    BigInt(safe.hash) > 0n && safe.timestamp > 0n,
    "dance_authority_anchor_changed",
    503,
  );
  const block = { blockHash: safe.hash, requireCanonical: true } as const;
  // EIP-1898 pins both code and contract state to this exact block. A node
  // that cannot perform hash-addressed canonical reads cannot supply roles.
  await verifyDanceSourceAt(danceReadPort(client, safe), source, safe.number);
  const params = {
    address: domain.verifier,
    abi: danceVerdictsAbi,
    ...block,
  } as const;
  const [directory, owner, rules, role] = await Promise.all([
    client.readContract({
      address: pin.directory,
      abi: directoryAbi,
      functionName: "getCommunity",
      args: [domain.communityId],
      ...block,
    }),
    client.readContract({ ...params, functionName: "ownerContext" }),
    client.readContract({ ...params, functionName: "rulesEpoch" }),
    client.readContract({
      ...params,
      functionName: "reviewerRoles",
      args: [address(input.actor.wallet)],
    }),
  ]);
  const [ownerEpoch, revision, controller, ownerWallet, validFrom, expiresAt] =
    owner;
  insist(
    revision === directory.configurationRevision &&
      revision === BigInt(config.configurationRevision) &&
      directory.registry.toLowerCase() === config.registry &&
      directory.configuration.operatorPayments.toLowerCase() ===
        config.operatorPayments &&
      controller.toLowerCase() === config.controller &&
      directory.configuration.controller.toLowerCase() === config.controller &&
      directory.configuration.publisher.toLowerCase() === pin.fixedPublisher &&
      directory.configuration.learningRecords.toLowerCase() === pin.v4 &&
      ownerEpoch > 0n &&
      BigInt(ownerWallet) > 0n &&
      safe.timestamp >= validFrom &&
      safe.timestamp < expiresAt &&
      rules === 0n,
    "dance_canonical_authority_changed",
    409,
  );
  const identity = async (subject: DanceRoleIdentity) => {
    const wallet = address(subject.wallet),
      accountId = danceId(subject.accountId);
    const commitment = danceAccountCommitment(domain, accountId, wallet);
    const [owner, epoch, groupId, groupEpoch, active] =
      await client.readContract({
        ...params,
        functionName: "identities",
        args: [commitment],
      });
    insist(
      active &&
        BigInt(wallet) > 0n &&
        owner.toLowerCase() === wallet &&
        epoch > 0n &&
        BigInt(groupId) > 0n &&
        groupEpoch > 0n,
      "dance_canonical_identity_changed",
      403,
    );
    const [current, members, , , live] = await client.readContract({
      ...params,
      functionName: "groups",
      args: [bytes32(groupId)],
    });
    insist(
      live && current === groupEpoch && members > 0n,
      "dance_canonical_group_changed",
      403,
    );
    return {
      accountId,
      wallet,
      accountCommitment: commitment,
      groupId,
      identityEpoch: count(epoch),
      groupEpoch: count(groupEpoch),
    };
  };
  const [actor, learner] = await Promise.all([
    identity(input.actor),
    identity(input.learner),
  ]);
  const [roleEpoch, roleOwner, roleExpiresAt, roleActive] = role;
  const reread = await rpc.block(safe.number);
  insist(
    reread.number === safe.number &&
      reread.hash === safe.hash &&
      reread.timestamp === safe.timestamp,
    "dance_authority_anchor_changed",
    503,
  );
  return {
    actor,
    learner,
    anchor: { number: safe.number, hash: safe.hash },
    owner: {
      wallet: address(ownerWallet.toLowerCase()),
      controller: address(controller.toLowerCase()),
      epoch: count(ownerEpoch),
      configurationRevision: count(revision),
      validFromMs: count(validFrom * 1000n),
      expiresAtMs: count(expiresAt * 1000n),
    },
    reviewer:
      roleActive &&
      roleEpoch > 0n &&
      roleOwner === ownerEpoch &&
      roleExpiresAt > safe.timestamp
        ? {
            roleEpoch: count(roleEpoch),
            ownerEpoch: count(roleOwner),
            expiresAtMs: count(roleExpiresAt * 1000n),
          }
        : null,
    rulesEpoch: 0,
  };
}
