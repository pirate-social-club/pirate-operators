// Narrow recovery: adopt reviewed remaining-step gas bounds after the sole
// confirmed registry clone. Never signs, broadcasts, changes or drops a tx.
import {
  access,
  open,
  readFile,
  rename,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseTransaction,
} from "viem";
import {
  canonical,
  CommunityError,
  hashJson,
  hashText,
  insist,
} from "../../packages/community/common.ts";
import {
  factoryAbi,
  registryProfile,
  verifyFactory,
  verifyNewRegistry,
} from "./verify-community.ts";

const priorPublicHash =
  "0x93e0511d88fdb5f8d37091706191cfda2e46a290c488350587a9c485f069a5ee";
const priorFile =
  "docs/deployments/first-song-managed-20261105.contract-plan-v1.json";
const nextFile =
  "docs/deployments/first-song-managed-20261105.contract-plan.json";
const bounds = (profile: Record<string, unknown>) => ({
  chainId: 6343,
  maximumGasPrice: profile.maximumGasPrice,
  maximumTotalFee: profile.maximumTotalFee,
  maximumExecutionMs: Number(profile.executionWindowSeconds) * 1000,
});
async function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      execute: { type: "boolean" },
      "expect-next": { type: "string" },
      "expect-journal": { type: "string" },
      "expect-adopted-journal": { type: "string" },
    },
  });
  const prior = JSON.parse(await readFile(priorFile, "utf8")),
    next = JSON.parse(await readFile(nextFile, "utf8"));
  insist(
    prior.profileHash === priorPublicHash &&
      hashJson(prior.profile) === priorPublicHash,
    "unapproved_predecessor_profile",
  );
  insist(
    next.profileHash === hashJson(next.profile) &&
      next.profile.supersedesPublicProfile === priorPublicHash,
    "invalid_successor_profile",
  );
  const {
    gas: oldGas,
    sourceDigests: oldSources,
    maximumGasPrice: priorMaximumGasPrice,
    ...oldImmutable
  } = prior.profile;
  const {
    gas: newGas,
    sourceDigests: newSources,
    supersedesPublicProfile,
    maximumGasPrice,
    ...newImmutable
  } = next.profile;
  insist(
    hashJson(oldImmutable) === hashJson(newImmutable),
    "immutable_deployment_profile_changed",
  );
  insist(
    prior.profile.maximumGasPrice === "1000000000" &&
      maximumGasPrice === "30000000" &&
      prior.profile.maximumTotalFee === "10000000000000000" &&
      next.profile.maximumTotalFee === prior.profile.maximumTotalFee,
    "deployment_fee_bound_changed",
  );
  insist(
    oldGas.registry === newGas.registry &&
      oldGas.registry === "1000000" &&
      oldGas.authority === "100000" &&
      newGas.authority === "300000" &&
      oldGas.directory === "4000000" &&
      newGas.directory === "150000000" &&
      oldGas.posts === "2000000" &&
      newGas.posts === "80000000",
    "unapproved_gas_profile_change",
  );
  for (const [path, hash] of Object.entries(oldSources))
    if (path !== "harness/megaeth/setup-community.ts")
      insist(newSources[path] === hash, "deployment_helper_changed");
  const added = Object.keys(newSources).filter((path) => !(path in oldSources));
  insist(
    canonical(added.sort()) ===
      canonical(
        [
          "harness/megaeth/adopt-profile.ts",
          "harness/megaeth/community-plan.ts",
          priorFile,
        ].sort(),
      ),
    "unapproved_profile_source_change",
  );
  for (const [path, hash] of Object.entries(newSources))
    insist(
      hashText(await readFile(path, "utf8")) === hash,
      "successor_source_digest_mismatch",
    );
  const setup = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.setup.json",
      "utf8",
    ),
  );
  const directory = join(setup.launcher.privateState, "contracts");
  insist((await realpath(directory)) === directory, "journal_path_changed");
  const info = await stat(directory);
  insist(
    (info.mode & 0o077) === 0 &&
      (!process.getuid || info.uid === process.getuid()),
    "journal_not_private",
  );
  const lockPath = join(directory, "deployment.lock");
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  if (values.execute) {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(String(process.pid));
  } else
    insist(
      !(await access(lockPath).then(
        () => true,
        () => false,
      )),
      "deployment_writer_active",
    );
  try {
    const path = join(directory, "transactions.json"),
      original = await readFile(path, "utf8"),
      originalHash = hashText(original),
      state = JSON.parse(original);
    insist(
      values["expect-journal"] === originalHash &&
        values["expect-next"] === next.profileHash,
      "reviewed_adoption_digests_required",
    );
    const oldCombined = hashJson({
        profile: prior.profile,
        limits: bounds(prior.profile),
      }),
      newCombined = hashJson({
        profile: next.profile,
        limits: bounds(next.profile),
      });
    insist(
      state.schema === "pirate.testnet-deployment-journal/1" &&
        state.profileHash === oldCombined &&
        state.chainId === 6343 &&
        state.signer.toLowerCase() === prior.profile.operator &&
        Object.keys(state.transactions).length === 1,
      "unexpected_deployment_history",
    );
    const protectedTransactions = canonical(state.transactions),
      tx = state.transactions.registry_clone;
    insist(
      tx?.receipt?.status === "success" &&
        tx.nonce === 12 &&
        keccak256(tx.raw) === tx.hash &&
        tx.hash ===
          "0x20d0cbfe3ccb44fa95ceb00c37115abe26c9d008eb72e72764f0e904f809e493",
      "unconfirmed_or_changed_registry_transaction",
    );
    const decoded = parseTransaction(tx.raw),
      operator = state.signer;
    insist(
      decoded.type === "legacy" &&
        decoded.chainId === 6343 &&
        decoded.nonce === 12 &&
        decoded.to?.toLowerCase() === registryProfile.factory &&
        (decoded.value ?? 0n) === 0n &&
        decoded.gasPrice !== undefined &&
        decoded.gasPrice <= BigInt(maximumGasPrice) &&
        decoded.gas === 1000000n &&
        decoded.data ===
          encodeFunctionData({
            abi: factoryAbi,
            functionName: "deployRegistry",
            args: [prior.profile.tld, operator, operator, 0n],
          }),
      "registry_signed_intent_changed",
    );
    const client = createPublicClient({
      transport: http("https://carrot.megaeth.com/rpc", {
        retryCount: 0,
        timeout: 20000,
      }),
    });
    await verifyFactory(client);
    const [receipt, height, pending, latest] = await Promise.all([
      client.getTransactionReceipt({ hash: tx.hash }),
      client.getBlockNumber(),
      client.getTransactionCount({ address: operator, blockTag: "pending" }),
      client.getTransactionCount({ address: operator, blockTag: "latest" }),
    ]);
    insist(
      receipt.status === "success" &&
        height >= receipt.blockNumber + 1n &&
        receipt.blockHash === tx.receipt.blockHash &&
        pending === 13 &&
        latest === 13,
      "registry_or_signer_not_quiescent",
    );
    insist(
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
        receipt.blockHash,
      "registry_receipt_not_canonical",
    );
    const registry = await verifyNewRegistry(
      client,
      receipt,
      prior.profile.tld,
      operator,
    );
    state.profileAdoptions ??= [];
    state.profileAdoptions.push({
      adoptionId: hashJson({
        from: oldCombined,
        to: newCombined,
        priorJournalHash: originalHash,
      }),
      ownerRole: "workspace_coordinator",
      from: oldCombined,
      to: newCombined,
      priorPublicProfile: priorPublicHash,
      nextPublicProfile: next.profileHash,
      priorJournalHash: originalHash,
      reason:
        "MegaETH measured deployment compute gas; retain confirmed registry and tighten gas-price ceiling",
    });
    state.profileHash = newCombined;
    insist(
      canonical(state.transactions) === protectedTransactions,
      "transaction_history_changed",
    );
    const candidate = canonical(state) + "\n";
    if (values.execute) {
      insist(
        values["expect-adopted-journal"] === hashText(candidate),
        "reviewed_candidate_journal_required",
      );
      const backup = join(
        directory,
        `transactions.pre-adoption-${originalHash.slice(2)}.json`,
      );
      async function preserve(filePath: string, contents: string) {
        const existing = await readFile(filePath, "utf8").catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return null;
        });
        if (existing !== null) {
          insist(existing === contents, "adoption_preservation_conflict");
          return;
        }
        const file = await open(filePath, "wx", 0o600);
        try {
          await file.writeFile(contents);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      await preserve(backup, original);
      const temporary = join(directory, "transactions.adopting.json");
      await preserve(temporary, candidate);
      insist(
        hashText(await readFile(path, "utf8")) === originalHash,
        "journal_changed_during_adoption",
      );
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    console.log(
      JSON.stringify({
        mode: values.execute ? "adopted" : "dry_run",
        priorJournalHash: originalHash,
        nextJournalHash: hashText(candidate),
        nextPublicProfile: next.profileHash,
        retainedTransactionHash: tx.hash,
        retainedNonce: tx.nonce,
        retainedRegistry: registry.address,
        transactionsUnchanged: true,
        transactionCount: 1,
      }),
    );
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: "profile_adoption_refused_preserve_journal",
        code:
          error instanceof CommunityError
            ? error.code
            : "runtime_or_rpc_unavailable",
      }),
    );
    process.exitCode = 1;
  });
