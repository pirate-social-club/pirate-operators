// Wire facts independently checked against the exact Base Sepolia Sourcify ABI on November7.
// Runtime/source pins: docs/megapot-fork.md. No signer or financial execution is provided.
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";
import { hashJson, insist } from "../community/common.ts";
import type { RewardOfferInput, RewardsProfile } from "./contracts.ts";

const jackpot = "0x465da3c859f193a3807386387bee941b2a4c3279" as const;
const nft = "0x45084829ac63f9dc6a3d4981a46fa896f9180ecd" as const;
const token = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as const;
const codeHash =
  "0x8d3104deb8a3fb663c67f8d4a2da43a15aaf5ad8b0e1d303ceed09f582dd4bc9";
const abi = parseAbi([
  "function currentDrawingId() view returns (uint256)",
  "function usdc() view returns (address)",
  "function jackpotNFT() view returns (address)",
  "function getDrawingState(uint256) view returns ((uint256 prizePool,uint256 ticketPrice,uint256 edgePerTicket,uint256 referralWinShare,uint256 referralFee,uint256 globalTicketsBought,uint256 lpEarnings,uint256 drawingTime,uint256 winningTicket,uint8 ballMax,uint8 bonusballMax,address payoutCalculator,bool jackpotLock))",
  "function getDrawingTierPayouts(uint256) view returns (uint256[12])",
  "function getTicketTierIds(uint256[]) view returns (uint256[])",
  "function claimWinnings(uint256[])",
  "event TicketPurchased(address indexed recipient,uint256 indexed currentDrawingId,bytes32 indexed source,uint256 userTicketId,uint8[] normals,uint8 bonusball,bytes32 referralScheme)",
  "event TicketWinningsClaimed(address indexed userAddress,uint256 indexed drawingId,uint256 userTicketId,uint256 matchedNormals,bool bonusballMatch,uint256 winningsAmount)",
]);
const nftAbi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
const clientFor = () =>
  createPublicClient({
    transport: http("https://sepolia.base.org", {
      retryCount: 0,
      timeout: 15000,
      // workerd rejects "error". viem refuses the unfollowed 3xx as not ok.
      fetchOptions: { credentials: "omit", redirect: "manual" },
    }),
  });
async function checked() {
  const client = clientFor();
  insist((await client.getChainId()) === 84532, "wrong_megapot_chain", 503);
  const head = await client.getBlock({ blockTag: "safe" });
  const [code, wiredToken, wiredNft] = await Promise.all([
    client.getCode({ address: jackpot, blockNumber: head.number }),
    client.readContract({
      address: jackpot,
      abi,
      functionName: "usdc",
      blockNumber: head.number,
    }),
    client.readContract({
      address: jackpot,
      abi,
      functionName: "jackpotNFT",
      blockNumber: head.number,
    }),
  ]);
  insist(
    code &&
      keccak256(code) === codeHash &&
      wiredToken.toLowerCase() === token &&
      wiredNft.toLowerCase() === nft,
    "megapot_deployment_changed",
    503,
  );
  return { client, head };
}
async function receiptAt(hash: string) {
  const { client, head } = await checked(),
    receipt = await client.getTransactionReceipt({ hash: hash as Hex });
  insist(
    receipt.status === "success" && receipt.blockNumber <= head.number,
    "megapot_receipt_not_confirmed",
    409,
  );
  insist(
    (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
      receipt.blockHash,
    "megapot_receipt_reorged",
    409,
  );
  return { client, head, receipt };
}
export async function megapotPurchase(
  offer: RewardOfferInput,
  profile: RewardsProfile,
) {
  const { client, head, receipt } = await receiptAt(offer.purchaseHash);
  const [current, state] = await Promise.all([
    client.readContract({
      address: jackpot,
      abi,
      functionName: "currentDrawingId",
      blockNumber: head.number,
    }),
    client.readContract({
      address: jackpot,
      abi,
      functionName: "getDrawingState",
      args: [BigInt(offer.drawingId)],
      blockNumber: head.number,
    }),
  ]);
  insist(
    current === BigInt(offer.drawingId) &&
      state.winningTicket === 0n &&
      !state.jackpotLock &&
      offer.cutoffAt <= Number(state.drawingTime) * 1000 &&
      Number(head.timestamp) * 1000 < offer.opensAt,
    "megapot_offer_window_invalid",
    409,
  );
  const expected = new Set(offer.ticketIds),
    found = new Set<string>();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== jackpot) continue;
    let event;
    try {
      event = decodeEventLog({
        abi,
        eventName: "TicketPurchased",
        data: log.data,
        topics: log.topics,
      });
    } catch {
      continue;
    }
    const a = event.args;
    if (!expected.has(a.userTicketId.toString())) continue;
    insist(
      a.currentDrawingId.toString() === offer.drawingId &&
        a.recipient.toLowerCase() === profile.ticketWallet &&
        !found.has(a.userTicketId.toString()),
      "megapot_purchase_mismatch",
      409,
    );
    found.add(a.userTicketId.toString());
  }
  insist(found.size === expected.size, "megapot_purchase_ticket_missing", 409);
  for (const id of offer.ticketIds) {
    const owner = await client.readContract({
      address: nft,
      abi: nftAbi,
      functionName: "ownerOf",
      args: [BigInt(id)],
      blockNumber: head.number,
    });
    insist(
      owner.toLowerCase() === profile.ticketWallet,
      "megapot_ticket_not_owned",
      409,
    );
  }
  insist(
    (await client.getBlock({ blockNumber: head.number })).hash === head.hash,
    "megapot_head_changed",
    409,
  );
  return {
    receiptHash: hashJson({
      chainId: 84532,
      transactionHash: offer.purchaseHash,
      blockHash: receipt.blockHash,
      tickets: [...found].sort(),
    }),
  };
}
/** A positive award requires an actual, canonical USDC collection receipt for these exact tickets. */
export async function megapotWinnings(
  offer: RewardOfferInput,
  profile: RewardsProfile,
  claimHash?: string,
) {
  const { client, head } = await checked();
  const [current, state] = await Promise.all([
    client.readContract({
      address: jackpot,
      abi,
      functionName: "currentDrawingId",
      blockNumber: head.number,
    }),
    client.readContract({
      address: jackpot,
      abi,
      functionName: "getDrawingState",
      args: [BigInt(offer.drawingId)],
      blockNumber: head.number,
    }),
  ]);
  insist(
    current > BigInt(offer.drawingId) && state.winningTicket !== 0n,
    "megapot_drawing_pending",
    409,
  );
  if (!claimHash) {
    for (const id of offer.ticketIds) {
      const owner = await client.readContract({
        address: nft,
        abi: nftAbi,
        functionName: "ownerOf",
        args: [BigInt(id)],
        blockNumber: head.number,
      });
      insist(
        owner.toLowerCase() === profile.ticketWallet,
        "megapot_collection_receipt_required",
        409,
      );
    }
    const [tiers, payouts] = await Promise.all([
      client.readContract({
        address: jackpot,
        abi,
        functionName: "getTicketTierIds",
        args: [offer.ticketIds.map(BigInt)],
        blockNumber: head.number,
      }),
      client.readContract({
        address: jackpot,
        abi,
        functionName: "getDrawingTierPayouts",
        args: [BigInt(offer.drawingId)],
        blockNumber: head.number,
      }),
    ]);
    insist(
      tiers.length === offer.ticketIds.length &&
        tiers.every((t) => t >= 0n && t < 12n),
      "megapot_ticket_tiers_invalid",
      503,
    );
    insist(
      tiers.every((t) => payouts[Number(t)] === 0n),
      "megapot_collection_receipt_required",
      409,
    );
    return {
      usdcAtomic: "0",
      receiptHash: hashJson({
        drawingId: offer.drawingId,
        head: head.hash,
        ticketIds: offer.ticketIds,
        tiers: tiers.map(String),
        payouts: payouts.map(String),
      }),
    };
  }
  const { receipt } = await receiptAt(claimHash),
    tx = await client.getTransaction({ hash: claimHash as Hex });
  insist(
    tx.from.toLowerCase() === profile.ticketWallet &&
      tx.to?.toLowerCase() === jackpot,
    "megapot_collection_wallet_mismatch",
    409,
  );
  const call = decodeFunctionData({ abi, data: tx.input });
  insist(
    call.functionName === "claimWinnings",
    "megapot_collection_call_mismatch",
    409,
  );
  const selected = call.args[0].map(String).sort(),
    expected = [...offer.ticketIds].sort();
  insist(
    JSON.stringify(selected) === JSON.stringify(expected),
    "megapot_collection_ticket_mismatch",
    409,
  );
  const claimed = new Set<string>(),
    burned = new Set<string>();
  let sum = 0n,
    received = 0n,
    transferCount = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === jackpot) {
      let event;
      try {
        event = decodeEventLog({
          abi,
          eventName: "TicketWinningsClaimed",
          data: log.data,
          topics: log.topics,
        });
      } catch {
        continue;
      }
      const a = event.args,
        id = a.userTicketId.toString();
      insist(
        expected.includes(id) &&
          !claimed.has(id) &&
          a.drawingId.toString() === offer.drawingId &&
          a.userAddress.toLowerCase() === profile.ticketWallet,
        "megapot_collection_event_mismatch",
        409,
      );
      claimed.add(id);
      sum += a.winningsAmount;
    }
    if (log.address.toLowerCase() === nft) {
      let e;
      try {
        e = decodeEventLog({
          abi: nftAbi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
        });
      } catch {
        continue;
      }
      const id = e.args.tokenId.toString();
      if (expected.includes(id)) {
        insist(
          e.args.from.toLowerCase() === profile.ticketWallet &&
            BigInt(e.args.to) === 0n &&
            !burned.has(id),
          "megapot_collection_burn_mismatch",
          409,
        );
        burned.add(id);
      }
    }
    if (log.address.toLowerCase() === token) {
      let e;
      try {
        e = decodeEventLog({
          abi: erc20Abi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
        });
      } catch {
        continue;
      }
      if (
        e.args.from.toLowerCase() === jackpot &&
        e.args.to.toLowerCase() === profile.ticketWallet
      ) {
        received += e.args.value;
        transferCount++;
      }
    }
  }
  insist(
    claimed.size === expected.length &&
      burned.size === expected.length &&
      transferCount === 1 &&
      received === sum,
    "megapot_collection_not_backed",
    409,
  );
  return {
    usdcAtomic: sum.toString(),
    transactionHash: claimHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    receiptHash: hashJson({
      chainId: 84532,
      hash: claimHash,
      blockHash: receipt.blockHash,
      ticketIds: expected,
      usdcAtomic: sum.toString(),
    }),
  };
}
