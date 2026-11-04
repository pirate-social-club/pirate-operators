// Manual, bounded MegaETH6343 action. Default mode is read-only planning.
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashJson, hashText, insist } from "../../packages/community/common.ts";
import { communityId } from "../../packages/community/manifest-core.ts";
import { compileCommunity } from "../compile-community.ts";
import { deploymentJournal } from "./deployment-journal.ts";
import {
  factoryAbi,
  registryProfile,
  verifyDeployment,
  verifyFactory,
  verifyNewRegistry,
} from "./verify-community.ts";

const setupFile = "docs/deployments/first-song-managed-20261105.setup.json";
const chain = defineChain({
  id: 6343,
  name: "MegaETH testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://carrot.megaeth.com/rpc"] } },
});
const gas = {
  registry: 1000000n,
  authority: 100000n,
  directory: 4000000n,
  posts: 2000000n,
};
const limits = {
  chainId: 6343 as const,
  maximumGasPrice: 1000000000n,
  maximumTotalFee: 10000000000000000n,
  maximumExecutionMs: 600000,
};
async function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      execute: { type: "boolean" },
      "expect-profile": { type: "string" },
      "journal-dir": { type: "string" },
      "artifacts-out": { type: "string" },
    },
  });
  const setup = JSON.parse(await readFile(setupFile, "utf8"));
  insist(
    setup.health.infrastructure === "provisioned" &&
      setup.origin ===
        "https://pirate-first-song-20261105.piratesocialclub.workers.dev",
    "new_managed_setup_not_qualified",
  );
  const saved = JSON.parse(
    await readFile(join(setup.launcher.privateState, "setup.json"), "utf8"),
  );
  insist(
    saved.settings.moderationMode === "pirate" &&
      saved.settings.tld === "firstsong-20261105" &&
      saved.settings.slug === "first-song-20261105" &&
      saved.deployment === "provisioned" &&
      saved.plan.id === setup.health.planId,
    "managed_setup_identity_changed",
  );
  const keyPath = join(
      homedir(),
      ".config/pirate-registry/megaeth-testnet-operator.json",
    ),
    keyInfo = await stat(keyPath);
  insist(
    keyInfo.isFile() &&
      (keyInfo.mode & 0o077) === 0 &&
      (!process.getuid || keyInfo.uid === process.getuid()),
    "dedicated_test_key_not_private",
  );
  const key = JSON.parse(await readFile(keyPath, "utf8"));
  insist(key.chainId === 6343, "test_key_wrong_chain");
  const operator = privateKeyToAccount(key.privateKey as Hex);
  insist(
    operator.address.toLowerCase() ===
      "0x274f223809f00cbdd51d05de3abc8fd3368fde16",
    "unexpected_test_operator",
  );
  const compiled = compileCommunity();
  insist(
    compiled.compiler.startsWith("0.8.30+"),
    "unexpected_contract_compiler",
  );
  const artifacts = Object.fromEntries(
    [
      "DisabledDiscoveryAuthority",
      "CommunityDirectoryV1",
      "CommunityPostsV1",
    ].map((name) => [name, compiled.artifacts[name]!]),
  );
  const sourceFiles = [
    "harness/compile-community.ts",
    "harness/megaeth/deployment-journal.ts",
    "harness/megaeth/verify-community.ts",
    "harness/megaeth/setup-community.ts",
    "package-lock.json",
  ];
  const sourceDigests = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        hashText(await readFile(file, "utf8")),
      ]),
    ),
  );
  const profile = {
    schema: "pirate.disposable-contract-plan/1",
    chainId: 6343,
    tld: saved.settings.tld,
    origin: setup.origin,
    planId: saved.plan.id,
    operator: operator.address.toLowerCase(),
    factory: registryProfile,
    compiler: compiled.compiler,
    compilerSettings: compiled.settings,
    contractSources: compiled.sources,
    artifactDigest: hashJson(artifacts),
    sourceDigests,
    gas: Object.fromEntries(
      Object.entries(gas).map(([name, value]) => [name, value.toString()]),
    ),
    maximumGasPrice: limits.maximumGasPrice.toString(),
    maximumTotalFee: limits.maximumTotalFee.toString(),
    executionWindowSeconds: 600,
    executionOwnerRole: "workspace_coordinator",
    signerCustody:
      "exclusive for this bounded run; no other implementation agents or signing workflows use this operator",
    recovery:
      "retain signed-transaction journal and reconcile hashes/nonces before retry; no replacement deployment or new nonce for uncertain steps",
    profile: "two-distinct-disabled-authorities-permanently-unlisted",
    registryAnnualPrice: "0",
    maximumVerificationAge: "86400",
  };
  const profileHash = hashJson(profile),
    client = createPublicClient({
      chain,
      transport: http(chain.rpcUrls.default.http[0], {
        timeout: 20000,
        retryCount: 0,
      }),
    });
  await verifyFactory(client);
  const balance = await client.getBalance({ address: operator.address });
  insist(
    balance >= limits.maximumTotalFee,
    "test_operator_needs_bounded_funding",
  );
  if (values["artifacts-out"])
    await writeFile(
      resolve(values["artifacts-out"]),
      JSON.stringify({ profileHash, profile, artifacts }, null, 2) + "\n",
    );
  if (!values.execute) {
    console.log(
      JSON.stringify({
        mode: "plan",
        profileHash,
        profile,
        remainingBalanceWei: balance.toString(),
        steps: [
          "registry_clone",
          "disabled_namespace",
          "disabled_listing",
          "directory",
          "posts",
        ],
      }),
    );
    return;
  }
  insist(
    values["expect-profile"] === profileHash &&
      values["journal-dir"] &&
      resolve(values["journal-dir"]) ===
        join(setup.launcher.privateState, "contracts"),
    "reviewed_profile_and_private_journal_required",
  );
  const journal = await deploymentJournal(
    values["journal-dir"],
    profile,
    client,
    operator,
    limits,
  );
  try {
    const registryReceipt = await journal.send("registry_clone", {
      to: registryProfile.factory,
      data: encodeFunctionData({
        abi: factoryAbi,
        functionName: "deployRegistry",
        args: [saved.settings.tld, operator.address, operator.address, 0n],
      }),
      gas: gas.registry,
    });
    const registry = await verifyNewRegistry(
      client,
      registryReceipt,
      saved.settings.tld,
      operator.address,
    );
    const deploy = async (
      step: string,
      name: string,
      args: readonly unknown[],
      maximumGas: bigint,
    ) => {
      const artifact = artifacts[name]!;
      const receipt = await journal.send(step, {
        data: encodeDeployData({
          abi: artifact.abi,
          bytecode: artifact.bytecode,
          args,
        }),
        gas: maximumGas,
      });
      return verifyDeployment(
        client,
        receipt,
        artifact,
        operator.address,
        journal.snapshot().transactions[step]!.nonce,
      );
    };
    const namespace = await deploy(
      "disabled_namespace",
      "DisabledDiscoveryAuthority",
      [],
      gas.authority,
    );
    const listing = await deploy(
      "disabled_listing",
      "DisabledDiscoveryAuthority",
      [],
      gas.authority,
    );
    insist(
      namespace.address !== listing.address,
      "disabled_authorities_must_be_distinct",
    );
    const directory = await deploy(
      "directory",
      "CommunityDirectoryV1",
      [[registryProfile.factory], namespace.address, listing.address, 86400n],
      gas.directory,
    );
    const posts = await deploy(
      "posts",
      "CommunityPostsV1",
      [directory.address],
      gas.posts,
    );
    const readDirectory = (
      functionName: string,
      args: readonly unknown[] = [],
    ) =>
      client.readContract({
        address: directory.address,
        abi: artifacts.CommunityDirectoryV1!.abi,
        functionName,
        args,
      });
    const id = communityId(6343, registry.address);
    const [
      verifier,
      listingAuthority,
      maximumAge,
      factories,
      postsDirectory,
      discoverable,
    ] = await Promise.all([
      readDirectory("namespaceVerifier"),
      readDirectory("listingAuthority"),
      readDirectory("maxVerificationAge"),
      readDirectory("factoryProfiles", [registryProfile.factory]),
      client.readContract({
        address: posts.address,
        abi: artifacts.CommunityPostsV1!.abi,
        functionName: "directory",
      }),
      readDirectory("isDiscoverable", [id]),
    ]);
    insist(
      String(verifier).toLowerCase() === namespace.address &&
        String(listingAuthority).toLowerCase() === listing.address &&
        maximumAge === 86400n &&
        String(postsDirectory).toLowerCase() === directory.address &&
        discoverable === false,
      "disposable_profile_configuration_mismatch",
    );
    const factoryState = factories as [Address, Hex, Hex, Hex];
    insist(
      factoryState[0].toLowerCase() === registryProfile.implementation &&
        factoryState[1] === registryProfile.factoryCodeHash &&
        factoryState[2] === registryProfile.implementationCodeHash &&
        factoryState[3] === registry.runtimeCodeHash,
      "directory_factory_profile_mismatch",
    );
    const manifest = {
      schema: "pirate.disposable-contract-deployment/1",
      at: new Date().toISOString(),
      profileHash,
      profile,
      communityId: id,
      registry,
      registryTransaction: {
        hash: registryReceipt.transactionHash,
        block: registryReceipt.blockNumber.toString(),
        blockHash: registryReceipt.blockHash,
      },
      namespace,
      listing,
      directory,
      posts,
      discovery:
        "permanently disabled; no authority owners, forwarding or upgrade path",
      configurationRegistration:
        "pending retained public configuration manifest",
      abis: artifacts,
      journal: journal.snapshot(),
    };
    // Evidence contains public signed transactions/ABIs, never private keys.
    await mkdir("docs/deployments", { recursive: true });
    await writeFile(
      "docs/deployments/first-song-managed-20261105.contracts.json",
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await writeFile(
      join(setup.launcher.privateState, "application-contracts.json"),
      JSON.stringify(
        {
          communityId: id,
          registry: registry.address,
          directory: directory.address,
          posts: posts.address,
          profileHash,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        profileHash,
        communityId: id,
        registry: registry.address,
        directory: directory.address,
        posts: posts.address,
        permanentlyUnlisted: true,
      }),
    );
  } finally {
    await journal.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      JSON.stringify({
        error: "testnet_setup_incomplete_preserve_journal_and_reconcile",
      }),
    );
    process.exitCode = 1;
  });
