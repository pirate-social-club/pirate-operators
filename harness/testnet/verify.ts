import { readFileSync } from "node:fs";
import {
  parseAbi,
  decodeEventLog,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { publicNetworks, PATH_USD, RESERVE } from "./config.ts";
import { compile } from "../compile.ts";
import { check } from "../../packages/protocol/index.ts";

export async function verifyEvidence(file: string) {
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    events: Record<string, unknown>[];
    expectedActors?: Record<string, Address>;
  };
  const { base, tempo } = await publicNetworks();
  const artifacts = compile();
  const actors = (data.events.find((e) => e.kind === "configuration")?.actors ??
    data.expectedActors) as Record<string, Address> | undefined;
  check(actors, "expected_actor_manifest_required");
  const last = data.events.find((e) => e.kind === "withdrawSponsor")!;
  const baseReceipt = await base.getTransactionReceipt({
    hash: last.transactionHash as Hex,
  });
  check(baseReceipt.status === "success", "base_terminal_receipt_failed");
  const blockNumber = baseReceipt.blockNumber;
  for (const contract of data.events.filter((e) => e.kind === "contract")) {
    const code = await base.getCode({
      address: contract.address as Address,
      blockNumber,
    });
    check(
      code && keccak256(code) === contract.codeHash,
      "recorded_contract_code_mismatch",
    );
  }
  const contracts = data.events.filter((e) => e.kind === "contract");
  const pool = contracts.find((e) => e.name === "RewardPool")!
    .address as Address;
  const token = contracts.find((e) => e.name === "TestUSDC")!
    .address as Address;
  const rows = data.events.find((e) => e.step === "karaoke_and_qualification")!
    .state as { participant: Address }[];
  const erc20 = parseAbi([
    "function balanceOf(address) view returns (uint256)",
  ]);
  check(
    (await base.readContract({
      address: token,
      abi: erc20,
      functionName: "balanceOf",
      args: [pool],
      blockNumber,
    })) === 0n,
    "pool_not_empty_in_fixture",
  );
  for (const row of rows)
    check(
      (await base.readContract({
        address: token,
        abi: erc20,
        functionName: "balanceOf",
        args: [row.participant],
        blockNumber,
      })) === 3333333n,
      "payout_mismatch",
    );
  check(
    (await base.readContract({
      address: pool,
      abi: artifacts.RewardPool.abi,
      functionName: "registeredCount",
      blockNumber,
    })) === 3n,
    "registration_count_mismatch",
  );
  const close = data.events.find((e) => e.kind === "close")!.receipt as {
    txHash: Hex;
    spent: string;
    acceptedCumulative: string;
    channelId: Hex;
  };
  const receipt = await tempo.getTransactionReceipt({ hash: close.txHash });
  check(
    receipt.status === "success" &&
      receipt.to?.toLowerCase() === RESERVE.toLowerCase(),
    "reserve_close_not_confirmed",
  );
  const transfer = parseAbi([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);
  const paid = data.events.filter((e) => e.kind === "paid_job");
  check(paid.length === 4 && close.spent === "8000", "paid_job_total_mismatch");
  const movements = receipt.logs
    .filter((l) => l.address.toLowerCase() === PATH_USD.toLowerCase())
    .flatMap((log) => {
      try {
        const decoded = decodeEventLog({
          abi: transfer,
          data: log.data,
          topics: log.topics,
        });
        return [decoded.args];
      } catch {
        return [];
      }
    });
  const operatorTransfer = movements.find(
    (t) =>
      t.from.toLowerCase() === RESERVE.toLowerCase() &&
      t.to.toLowerCase() === actors.operator.toLowerCase() &&
      t.value === 8000n,
  );
  const payerRefund = movements.find(
    (t) =>
      t.from.toLowerCase() === RESERVE.toLowerCase() &&
      t.to.toLowerCase() === actors.payer.toLowerCase() &&
      t.value === 2000n,
  );
  check(operatorTransfer && payerRefund, "reserve_transfers_missing");
  check(
    (await base.readContract({
      address: pool,
      abi: artifacts.RewardPool.abi,
      functionName: "sponsor",
      blockNumber,
    })) === actors.sponsor,
    "wrong_pool_sponsor",
  );
  check(
    (await base.readContract({
      address: token,
      abi: erc20,
      functionName: "balanceOf",
      args: [actors.sponsor],
      blockNumber,
    })) === 2n,
    "sponsor_dust_mismatch",
  );
  return {
    baseBlock: { number: blockNumber, hash: baseReceipt.blockHash },
    tempoBlock: { number: receipt.blockNumber, hash: receipt.blockHash },
    chainIds: [84532, 42431],
    pool,
    token,
    participants: rows.map((r) => r.participant),
    participantPayoutUnits: "3333333",
    channelId: close.channelId,
    closeTransaction: close.txHash,
    operator: operatorTransfer.to,
    operatorPaymentUnits: "8000",
    payer: payerRefund.to,
    unusedDepositReturnedUnits: "2000",
    verifiedAt: new Date().toISOString(),
    simulations: ["identification", "Very", "Jackpot", "test-USDC"],
    bridge: "not_exercised",
  };
}
