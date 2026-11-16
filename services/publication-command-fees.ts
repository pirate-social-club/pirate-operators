import { decodeFunctionResult, encodeFunctionData, parseAbi, serializeTransaction,
  type Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import { isPublicationV5Kind, type TxRow } from "./operator-tx.ts";
import { capturedFee, byteHex, type CapturedPublicationFeeV1 } from "./publication-command-contract.ts";
import type { PublicationReadRpc } from "./publication-command-rpc.ts";

const feeAbi = parseAbi(["function getL1Fee(bytes data) view returns(uint256)"]);
const minimum = (a: string,b: string) => BigInt(a) < BigInt(b) ? BigInt(a) : BigInt(b);
/** A future admitted sender calls this before final permission/fence checks.
 * This is never a prerequisite for original historical receipt observation. */
export async function checkCapturedPublicationFee(row: TxRow,
  currentSelection: CapturedPublicationFeeV1, read: PublicationReadRpc) {
  check(isPublicationV5Kind(row.kind) && row.publicationV1 &&
    !row.authorizationList, "publication_fee_capture_missing");
  const saved = capturedFee(row.publicationV1), current = capturedFee(currentSelection);
  check(row.chainId === saved.chainId && current.chainId === saved.chainId &&
    current.payer === saved.payer &&
    BigInt(row.gas) <= minimum(saved.gas,current.gas) &&
    BigInt(row.gasPrice) <= minimum(saved.gasPrice,current.gasPrice),
    "publication_fee_above_limit");
  check(BigInt(await read<Hex>("eth_chainId",[])) === BigInt(saved.chainId),
    "publication_chain_changed");
  if (saved.chainId === 31337) return 0n;
  check(row.broadcast === "none" || row.broadcast === "attempted",
    "publication_broadcast_state_unknown");
  const priced = row.broadcast === "none" ? serializeTransaction({type:"legacy",
    chainId:row.chainId,nonce:row.nonce,to:row.to,data:row.data,
    gas:BigInt(row.gas),gasPrice:BigInt(row.gasPrice),value:0n}) : row.raw;
  check(priced,"publication_original_raw_missing");
  const data = encodeFunctionData({abi:feeAbi,functionName:"getL1Fee",args:[byteHex(priced)]});
  const result = await read<Hex>("eth_call",[{
    to:"0x420000000000000000000000000000000000000F",data},"latest"]);
  const fee = decodeFunctionResult({abi:feeAbi,functionName:"getL1Fee",data:byteHex(result)});
  check(fee <= minimum(saved.dataFee,current.dataFee),"publication_data_fee_above_limit");
  return fee;
}
