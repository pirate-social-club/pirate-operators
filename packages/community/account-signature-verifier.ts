import {
  BaseError, RpcRequestError, concatHex, encodeDeployData,
  erc6492SignatureValidatorAbi, erc6492SignatureValidatorByteCode,
  hashTypedData, isErc8010Signature, parseErc8010Signature,
  serializeErc6492Signature, zeroAddress, type Address, type Hex, type PublicClient,
  type TypedDataDefinition,
} from "viem";
import { verifyAuthorization } from "viem/utils";
import { insist } from "./common.ts";

/** Account authority is decided by the pinned EVM validator at the caller's
 * explicit safe block. viem2.57.16 public verifyHash catches chain failures and
 * attempts raw ECDSA recovery; that fallback is not an authority here.
 *
 * Use viem's exported ERC6492 validator ABI/bytecode and ERC8010 codec, not a
 * copied validator or deployed service. The validator selects plain EOA versus
 * ERC1271 from actual account state. Accepted signature bytes are never changed
 * in storage, and the typed hash/domain/message are the exact caller projection.
 */
type AccountTypedProof={data:TypedDataDefinition;address:Address;signature:Hex;blockNumber:bigint};
export async function verifyAccountTypedData(client:PublicClient,input:AccountTypedProof):Promise<boolean> {
  input=structuredClone(input);
  if(!client.chain)return verifyOnChain(client,input);
  let verified:boolean|undefined;
  // The pinned public action's supported chain hook returns BEFORE its default
  // catch/fallback. Keep its normal lifecycle while taking authority only from
  // our actual EVM result; a client that ignores this hook is unavailable.
  await client.verifyTypedData({...input.data,address:input.address,signature:input.signature,blockNumber:input.blockNumber,
    chain:{...client.chain,verifyHash:async()=>{verified=await verifyOnChain(client,input);return verified;}}});
  insist(verified!==undefined,"account_signature_verification_unavailable",503);
  return verified;
}
async function verifyOnChain(client:PublicClient,input:AccountTypedProof):Promise<boolean> {
  insist(/^0x(?:[0-9a-fA-F]{2}){1,16384}(?![\s\S])/.test(input.signature),"invalid_signature");
  let proof=input.signature;
  let authorizationList:Parameters<PublicClient["call"]>[0]["authorizationList"];
  if(isErc8010Signature(proof)) {
    const parsed=parseErc8010Signature(proof);
    if(!parsed.authorization)return false;
    const authorization=parsed.authorization;
    const code=await client.getCode({address:input.address,blockNumber:input.blockNumber});
    const delegated=concatHex(["0xef0100",authorization.address]);
    if(code?.toLowerCase()!==delegated.toLowerCase()) {
      // A projected delegation needs a real signed authorization valid for
      // this account/state. Otherwise an ignored authorization could expose a
      // code-free raw-key path inside the universal validator.
      if(code&&code!=="0x"&&!code.startsWith("0xef0100"))return false;
      if(!await verifyAuthorization({address:input.address,authorization:authorization}))return false;
      const chainId=await client.getChainId();
      if(BigInt(authorization.chainId)!==0n&&BigInt(authorization.chainId)!==BigInt(chainId))return false;
      if(authorization.nonce!==await client.getTransactionCount({address:input.address,blockNumber:input.blockNumber}))return false;
      authorizationList=[authorization];
      // ERC6492's preparation/retry handles the optional ERC8010 initializer
      // in the same eth_call as projected delegation and ERC1271 validation.
      proof=parsed.data&&parsed.data!=="0x"
        ? serializeErc6492Signature({address:parsed.address??input.address,data:parsed.data,signature:parsed.signature})
        : parsed.signature;
    } else proof=parsed.signature;
  }
  try {
    const result=await client.call({
      blockNumber:input.blockNumber,batch:false,authorizationList,account:zeroAddress,
      data:encodeDeployData({abi:erc6492SignatureValidatorAbi,bytecode:erc6492SignatureValidatorByteCode,
        args:[input.address,hashTypedData(input.data),proof]}),
    });
    insist(result.data==="0x00"||result.data==="0x01","account_signature_verification_unavailable",503);
    return result.data==="0x01";
  } catch(error) {
    // Only the RPC's actual EVM-revert code is an invalid proof. Transport,
    // unsupported execution and malformed responses remain unavailable.
    if(error instanceof BaseError&&error.walk(e=>e instanceof RpcRequestError&&e.code===3) instanceof RpcRequestError)return false;
    throw error;
  }
}
