// Offline RPC/IPFS transport over a retained raw public capture. It performs ABI
// decoding only; it does not normalize, authenticate or reduce learning results.
import { decodeEventLog, hexToBytes, type PublicClient } from "viem";
import type { ReferenceSnapshot, RawLog } from "./reference-results/facts.ts";

export function evidenceClient(snapshot: ReferenceSnapshot) {
  const block = (number: bigint) => {
    const b = snapshot.blocks[String(number)];
    if (!b) throw Error("raw_block_missing");
    return {
      number: BigInt(b.number),
      hash: b.hash,
      timestamp: BigInt(b.timestamp),
    };
  };
  const log = (l: RawLog) => ({ ...l, blockNumber: BigInt(l.blockNumber) });
  const events = async (options: any) => {
    const result = [];
    for (const l of snapshot.logs) {
      if (
        l.address.toLowerCase() !== options.address.toLowerCase() ||
        BigInt(l.blockNumber) < options.fromBlock ||
        BigInt(l.blockNumber) > options.toBlock
      )
        continue;
      if (!options.event && !options.abi) {
        result.push(log(l));
        continue;
      }
      try {
        const event = decodeEventLog({
          abi: options.event ? [options.event] : options.abi,
          eventName: options.eventName,
          data: l.data,
          topics: l.topics,
          strict: true,
        });
        const args = event.args as any;
        if (
          Object.entries(options.args ?? {}).some(
            ([key, value]) =>
              String(args[key]).toLowerCase() !== String(value).toLowerCase(),
          )
        )
          continue;
        result.push({ ...log(l), ...event });
      } catch {
        /* A different event signature does not match this RPC filter. */
      }
    }
    return result;
  };
  const client = {
    getChainId: async () => snapshot.profile.chainId,
    getBlockNumber: async () => BigInt(snapshot.head.number) + 1n,
    getBlock: async ({ blockNumber }: any) => block(blockNumber),
    getCode: async ({ address }: any) => snapshot.codes[address.toLowerCase()],
    getLogs: events,
    getContractEvents: events,
    getTransactionReceipt: async ({ hash }: any) => {
      const r = snapshot.receipts[hash];
      if (!r) throw Error("raw_receipt_missing");
      return {
        status: r.status,
        transactionHash: r.hash,
        blockHash: r.blockHash,
        blockNumber: BigInt(r.blockNumber),
        logs: r.logs.map(log),
      };
    },
    readContract: async ({ address, functionName, args }: any) => {
      if (
        functionName === "getCommunity" &&
        address.toLowerCase() ===
          snapshot.profile.directory.address.toLowerCase()
      )
        return {
          ...snapshot.directoryState,
          configurationRevision: BigInt(
            String(snapshot.directoryState.configurationRevision),
          ),
        };
      const s = snapshot.contractStates.find(
        (c) => c.address.toLowerCase() === address.toLowerCase(),
      );
      if (s && functionName === "commitments") return s.commitments[args[0]];
      if (s && functionName === "VERSION") return s.version ?? 2;
      if (s && functionName === "policyFor")
        return s.policies[
          s.version === 3 ? `${args[0]}:${args[1]}` : String(args[0])
        ];
      if (s && functionName === "communityId") return s.communityId;
      if (s && functionName === "publicityPolicy") return s.publicityPolicy;
      throw Error("raw_contract_read_missing");
    },
  } as unknown as PublicClient;
  const transport = async (request: Request) => {
    const cid = new URL(request.url).pathname.split("/ipfs/")[1];
    const wire = snapshot.documents[`ipfs://${cid}`];
    return wire
      ? new Response(Uint8Array.from(hexToBytes(wire)))
      : new Response("unavailable", { status: 404 });
  };
  return { client, transport };
}
