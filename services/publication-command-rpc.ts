import { check } from "../packages/protocol/index.ts";

export type PublicationReadMethod = "eth_chainId" | "eth_getTransactionReceipt" |
  "eth_getTransactionByHash" | "eth_getBlockByNumber" | "eth_getCode" | "eth_call";
export type PublicationReadRpc = <T>(method: PublicationReadMethod, params: unknown[]) => Promise<T>;
/** Root supplies managed URL, a real bounded scope signal and named response
 * limit. No browser-supplied transport, send method, redirects or retry. */
export function publicationReadRpc(url: string, signal: AbortSignal,
  maxResponseBytes: number): PublicationReadRpc {
  const address = new URL(url);
  check(["http:","https:"].includes(address.protocol) &&
    Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 &&
    maxResponseBytes <= 2097152, "publication_rpc_configuration_invalid");
  return async <T>(method: PublicationReadMethod, params: unknown[]): Promise<T> => {
    check(["eth_chainId","eth_getTransactionReceipt","eth_getTransactionByHash",
      "eth_getBlockByNumber","eth_getCode","eth_call"].includes(method),
      "publication_rpc_method_invalid");
    check(!signal.aborted, "publication_rpc_expired");
    const response = await fetch(url,{method:"POST",redirect:"manual",signal,
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});
    check(response.ok && response.body,"publication_rpc_unavailable");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        check(!signal.aborted,"publication_rpc_expired");
        if (item.done) break;
        size += item.value.byteLength;
        check(size <= maxResponseBytes,"publication_rpc_response_too_large");
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(()=>undefined); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    const reply = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as {
      jsonrpc?:string;id?:number;error?:unknown;result?:T;
    };
    check(reply.jsonrpc === "2.0" && reply.id === 1 && !reply.error &&
      Object.hasOwn(reply,"result"), "publication_rpc_unavailable");
    return reply.result as T;
  };
}
