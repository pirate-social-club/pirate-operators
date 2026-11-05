import { address } from "../packages/community/manifest-core.ts";
import { qualifyPublishedRegistration } from "./published-registration.ts";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { keccak256, sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { insist, object, bytes32 } from "../packages/community/common.ts";
import {
  storyReadClient,
  storyTestnet,
  rootRegistrationData,
} from "../packages/community/registration-chain.ts";
import type { communityPackage } from "./community-package.ts";
import type { managedPackage } from "./managed-package.ts";

/** Read-only qualification before idle-service functional enablement. */
export async function qualifyRegistrationFunding(
  profile: Awaited<ReturnType<typeof managedPackage>>["profile"],
) {
  const path = join(
      homedir(),
      ".config/pirate-operators/megaeth-testnet/keys.json",
    ),
    metadata = await lstat(path);
  insist(
    metadata.isFile() &&
      !(metadata.mode & 0o077) &&
      metadata.uid === process.getuid!(),
    "registration_source_file_not_private",
    409,
  );
  const bytes = await readFile(path);
  insist(
    sha256(new Uint8Array(bytes)) === profile.registrationCredential.sha256,
    "registration_source_file_changed",
    409,
  );
  const keys = JSON.parse(bytes.toString("utf8")),
    operator = privateKeyToAccount(keys.keys.communityAdmin).address,
    grant = profile.releaseGrant,
    client = storyReadClient();
  insist(
    keys.chainId === 6343 &&
      operator.toLowerCase() === grant.registration.operator &&
      grant.expiresAt > Math.floor(Date.now() / 1000),
    "registration_key_scope_changed",
    409,
  );
  const [chain, balance, latest, pending, gasPrice, ...codes] =
    await Promise.all([
      client.getChainId(),
      client.getBalance({ address: operator }),
      client.getTransactionCount({ address: operator, blockTag: "latest" }),
      client.getTransactionCount({ address: operator, blockTag: "pending" }),
      client.getGasPrice(),
      ...[storyTestnet.workflow, storyTestnet.nft, storyTestnet.registry].map(
        (address) => client.getCode({ address }),
      ),
    ]);
  const published =
    profile.curatedState.schema === "pirate.published-first-song-state/1";
  insist(
    chain === 1315 &&
      latest ===
        (published
          ? profile.curatedState.registration.operatorNonceAfter
          : 0) &&
      pending === latest &&
      (published ||
        (balance >= BigInt(grant.registration.maximumTotalFee) &&
          gasPrice <= BigInt(grant.registration.maximumGasPrice))),
    "registration_funding_or_nonce_not_qualified",
    409,
  );
  const expected = [
    grant.registration.codeHashes.workflow,
    grant.registration.codeHashes.nft,
    grant.registration.codeHashes.registry,
  ];
  insist(
    codes.every((code, i) => code && keccak256(code) === expected[i]),
    "registration_contract_code_changed",
    409,
  );
  if (published)
    return {
      ...(await qualifyPublishedRegistration(
        client,
        profile.curatedState,
        grant.registration.operator,
      )),
      chainId: chain,
      operator,
      balance: balance.toString(),
      latest,
      pending,
    };
  // The existing public configuration CID is synthetic metadata for this eth_call
  // only; actual metadata must be server-derived and pinned after admission.
  const uri =
      "ipfs://bafkreiabsnyic5vcde6vn37d3ljdpwqyxbyaqgjrkwqmbw4o545i6hpqfy",
    data = rootRegistrationData({
      recipient: address(grant.recipient),
      contentSha256: bytes32(grant.contentSha256),
      metadata: { uri, sha256: bytes32(grant.contentSha256) },
      nftMetadata: { uri, sha256: bytes32(grant.contentSha256) },
    }),
    gas = await client.estimateGas({
      account: operator,
      to: storyTestnet.workflow,
      data,
      value: 0n,
    });
  insist(
    gas <= BigInt(grant.registration.maximumGas) &&
      gas * gasPrice <= BigInt(grant.registration.maximumTotalFee),
    "registration_simulated_fee_exceeds_grant",
    409,
  );
  return {
    mode: "read_only_simulated_metadata",
    chainId: chain,
    operator,
    balance: balance.toString(),
    latest,
    pending,
    estimatedGas: gas.toString(),
    gasPrice: gasPrice.toString(),
    transactionsSent: 0,
  };
}
export async function qualifyApplicationPeers(
  profile: Awaited<ReturnType<typeof communityPackage>>["profile"],
) {
  const get = async (url: string) => {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    insist(response.ok, "application_release_peer_unavailable", 503);
    return object(await response.json());
  };
  const [native, managed] = await Promise.all([
      get("https://pirate-wallet-test.piratesocialclub.workers.dev/api/health"),
      get(
        "https://pirate-managed-firstsong-20261105.piratesocialclub.workers.dev/health",
      ),
    ]),
    release = object(managed.release);
  insist(
    native.profileHash === profile.creatorProfileHash &&
      native.testnet === true &&
      managed.profileHash === profile.managedProfileHash &&
      release.configured === true &&
      release.grantSha256 === profile.releaseGrant.sha256 &&
      release.registrationOperator ===
        profile.releaseGrant.registration.operator &&
      profile.releaseGrant.expiresAt > Math.floor(Date.now() / 1000),
    "application_release_peer_unqualified",
    503,
  );
}
