import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  realpath,
  access,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  canonical,
  hashJson,
  insist,
} from "../../packages/community/common.ts";

interface StoredTransaction {
  intentHash: string;
  raw: Hex;
  hash: Hex;
  nonce: number;
  maximumFee: string;
  receipt?: {
    hash: Hex;
    blockNumber: string;
    blockHash: Hex;
    contractAddress: Address | null;
    gasUsed: string;
    effectiveGasPrice: string;
    status: string;
  };
}
interface JournalState {
  schema: "pirate.testnet-deployment-journal/1";
  profileHash: string;
  chainId: number;
  signer: Address;
  transactions: Record<string, StoredTransaction>;
  executions?: {
    startedAt: string;
    deadlineAt: string;
    pid: number;
    ownerRole: string;
  }[];
}
export interface DeploymentIntent {
  to?: Address;
  data: Hex;
  gas: bigint;
}
export interface DeploymentLimits {
  chainId: 6343 | 31337;
  maximumGasPrice: bigint;
  maximumTotalFee: bigint;
  maximumExecutionMs?: number;
}
export function deploymentJournalProfileHash(
  profile: unknown,
  limits: DeploymentLimits,
) {
  return hashJson({
    profile,
    limits: {
      chainId: limits.chainId,
      maximumGasPrice: limits.maximumGasPrice.toString(),
      maximumTotalFee: limits.maximumTotalFee.toString(),
      maximumExecutionMs: limits.maximumExecutionMs ?? 600000,
    },
  });
}
export async function deploymentJournal(
  directory: string,
  profile: unknown,
  client: PublicClient,
  account: PrivateKeyAccount,
  limits: DeploymentLimits,
  executionDeadlineAt?: number,
) {
  const startedAt = Date.now(),
    executionMs = limits.maximumExecutionMs ?? 600000,
    deadline = Math.min(
      startedAt + executionMs,
      executionDeadlineAt ?? startedAt + executionMs,
    );
  insist(
    Number.isSafeInteger(executionMs) &&
      executionMs > 0 &&
      executionMs <= 900000 &&
      Number.isSafeInteger(deadline) &&
      deadline > startedAt,
    "invalid_deployment_execution_bound",
  );
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  insist(
    (await realpath(directory)) === directory,
    "deployment_state_symlink_forbidden",
  );
  const info = await stat(directory);
  insist(
    (info.mode & 0o077) === 0 &&
      (!process.getuid || info.uid === process.getuid()),
    "deployment_state_must_be_private",
  );
  for (let p = directory; ; p = dirname(p)) {
    insist(
      !(await access(join(p, ".git")).then(
        () => true,
        () => false,
      )),
      "deployment_state_inside_repository",
    );
    if (dirname(p) === p) break;
  }
  const lockPath = join(directory, "deployment.lock"),
    lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(String(process.pid));
  const path = join(directory, "transactions.json"),
    profileHash = deploymentJournalProfileHash(profile, limits);
  let state: JournalState;
  let sending = false;
  async function persist() {
    const temporary = path + ".pending",
      file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(canonical(state) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  try {
    insist(
      (await client.getChainId()) === limits.chainId,
      "refusing_wrong_deployment_chain",
    );
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      insist(
        (error as NodeJS.ErrnoException).code === "ENOENT",
        "deployment_journal_unreadable",
      );
      state = {
        schema: "pirate.testnet-deployment-journal/1",
        profileHash,
        chainId: limits.chainId,
        signer: account.address,
        transactions: {},
      };
      await persist();
    }
    insist(
      state.schema === "pirate.testnet-deployment-journal/1" &&
        state.profileHash === profileHash &&
        state.chainId === limits.chainId &&
        state.signer === account.address,
      "deployment_profile_changed",
    );
    state.executions ??= [];
    state.executions.push({
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
      pid: process.pid,
      ownerRole: "workspace_coordinator",
    });
    await persist();
    return {
      snapshot: () => structuredClone(state),
      async send(
        step: string,
        intent: DeploymentIntent,
        boundary?: (stage: "prepared" | "broadcast") => Promise<void>,
      ) {
        insist(!sending, "deployment_send_already_running", 409);
        sending = true;
        try {
          insist(
            Date.now() < deadline,
            "deployment_execution_deadline_reached",
          );
          insist(
            /^[a-z_]{1,64}$/.test(step) && intent.gas > 0n,
            "invalid_deployment_step",
          );
          const intentHash = hashJson({
            to: intent.to ?? null,
            data: intent.data,
            gas: intent.gas.toString(),
          });
          let stored = state.transactions[step];
          if (!stored) {
            const gasPrice = await client.getGasPrice();
            insist(
              gasPrice > 0n && gasPrice <= limits.maximumGasPrice,
              "deployment_gas_price_cap",
            );
            const prior = Object.values(state.transactions),
              maximumFee = intent.gas * gasPrice;
            const reserved = prior.reduce(
              (sum, tx) =>
                sum +
                BigInt(tx.receipt ? tx.receipt.gasUsed : "0") *
                  BigInt(tx.receipt ? tx.receipt.effectiveGasPrice : "0") +
                (tx.receipt ? 0n : BigInt(tx.maximumFee)),
              0n,
            );
            insist(
              reserved + maximumFee <= limits.maximumTotalFee,
              "deployment_total_fee_cap",
            );
            const nonce = await client.getTransactionCount({
              address: account.address,
              blockTag: "pending",
            });
            insist(
              !prior.some((tx) => tx.nonce === nonce),
              "unreconciled_deployment_nonce",
            );
            const estimate = await client.estimateGas({
              account,
              to: intent.to,
              data: intent.data,
            });
            insist(estimate <= intent.gas, "deployment_gas_limit_too_small");
            const raw = await account.signTransaction({
              type: "legacy",
              chainId: limits.chainId,
              nonce,
              to: intent.to,
              data: intent.data,
              gas: intent.gas,
              gasPrice,
              value: 0n,
            });
            stored = {
              intentHash,
              raw,
              hash: keccak256(raw),
              nonce,
              maximumFee: maximumFee.toString(),
            };
            state.transactions[step] = stored;
            await persist();
            await boundary?.("prepared");
          }
          insist(
            stored.intentHash === intentHash &&
              keccak256(stored.raw) === stored.hash,
            "deployment_step_changed",
          );
          let receipt = await client
            .getTransactionReceipt({ hash: stored.hash })
            .catch((error) => {
              if ((error as Error).name !== "TransactionReceiptNotFoundError")
                throw error;
              return null;
            });
          if (!receipt && !stored.receipt) {
            insist(
              Date.now() < deadline,
              "deployment_execution_deadline_reached",
            );
            // Reuse the signed bytes even if a previous send response was lost.
            // No replacement nonce, fee bump or separately signed deployment.
            await client
              .sendRawTransaction({ serializedTransaction: stored.raw })
              .catch(() => {});
            await boundary?.("broadcast");
            receipt = await client.waitForTransactionReceipt({
              hash: stored.hash,
              confirmations: 2,
              timeout: 60000,
              pollingInterval: 1000,
              checkReplacement: false,
            });
          }
          insist(receipt, "deployment_receipt_uncertain");
          // A recovered receipt has the same confirmation requirement as a
          // freshly broadcast transaction. Re-read after waiting for depth.
          const confirmed = await client.waitForTransactionReceipt({
            hash: stored.hash,
            confirmations: 2,
            timeout: 60000,
            pollingInterval: 1000,
            checkReplacement: false,
          });
          receipt = await client.getTransactionReceipt({ hash: stored.hash });
          insist(
            receipt.blockHash === confirmed.blockHash &&
              receipt.blockNumber === confirmed.blockNumber,
            "deployment_receipt_changed_during_confirmation",
          );
          const block = await client.getBlock({
            blockNumber: receipt.blockNumber,
          });
          insist(
            block.hash === receipt.blockHash &&
              receipt.transactionHash === stored.hash,
            "deployment_receipt_not_canonical",
          );
          stored.receipt = {
            hash: stored.hash,
            blockNumber: receipt.blockNumber.toString(),
            blockHash: receipt.blockHash,
            contractAddress: receipt.contractAddress ?? null,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.effectiveGasPrice.toString(),
            status: receipt.status,
          };
          await persist();
          insist(
            receipt.status === "success",
            "deployment_transaction_reverted",
          );
          return receipt;
        } finally {
          sending = false;
        }
      },
      async close() {
        await lock.close();
        await unlink(lockPath);
      },
    };
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
}
