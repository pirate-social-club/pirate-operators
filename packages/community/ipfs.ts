import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { sha256, type Hex } from "viem";
import {
  canonical,
  hashText,
  insist,
  MAX_AUDIO_BYTES,
  object,
  text,
} from "./common.ts";
import { ipfsUri } from "./manifest-core.ts";

export interface PinIntent {
  uri: string;
  sha256: Hex;
  byteLength: number;
  mediaType: "audio/mpeg" | "application/json";
}
export type IpfsTransport = (request: Request) => Promise<Response>;
const transport: IpfsTransport = (request) => fetch(request);
// Qualified by an independent live retrieval. The former public-good gateways
// now reject backend/hotlink traffic; see the recorded recovery evidence.
export const publicGateways = ["https://gateway.pinata.cloud"] as const;
const rpcOrigin = "https://rpc.filebase.io";

/** Fixed UnixFS importer settings are part of the captured operation request.
 * Calculating the root is read-only and does not send data or buy a pin. */
export async function preparePin(
  bytes: Uint8Array,
  mediaType: PinIntent["mediaType"],
): Promise<PinIntent> {
  insist(
    bytes.length > 0 && bytes.length <= MAX_AUDIO_BYTES,
    "invalid_pin_size",
  );
  let uri: string | undefined;
  for await (const entry of importer(
    [{ content: bytes }],
    { put: async (cid) => cid },
    {
      cidVersion: 1,
      rawLeaves: true,
      reduceSingleLeafToSelf: true,
      wrapWithDirectory: false,
      chunker: fixedSize({ chunkSize: 262144 }),
      layout: balanced({ maxChildrenPerNode: 174 }),
      blockWriteConcurrency: 1,
    },
  ))
    uri = `ipfs://${entry.cid.toString()}`;
  return {
    uri: ipfsUri(uri),
    sha256: sha256(bytes),
    byteLength: bytes.length,
    mediaType,
  };
}
export async function readBounded(
  response: Response,
  maximum: number,
  requireOk = true,
) {
  insist((!requireOk || response.ok) && response.body, "ipfs_unavailable", 503);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maximum) {
        await reader.cancel();
        insist(false, "ipfs_content_too_large", 503);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function fetchPublicIpfs(
  uri: string,
  expectedSha256: Hex,
  maximum: number,
  send: IpfsTransport = transport,
) {
  const cid = ipfsUri(uri).slice(7);
  for (const gateway of publicGateways) {
    try {
      const response = await send(
        new Request(`${gateway}/ipfs/${cid}`, {
          signal: AbortSignal.timeout(30000),
          redirect: "follow",
          headers: { "cache-control": "no-cache" },
        }),
      );
      const bytes = await readBounded(response, maximum);
      insist(sha256(bytes) === expectedSha256, "ipfs_digest_mismatch", 503);
      // A correct file hash is not the root CID for a multi-block file.
      // Recompute the fixed importer root to bind both references.
      const root = await preparePin(bytes, "application/json");
      insist(root.uri === uri, "ipfs_root_mismatch", 503);
      return { bytes, gateway };
    } catch {
      /* An unavailable or mismatching response never becomes valid content. */
    }
  }
  insist(false, "public_ipfs_unavailable", 503);
}
function rpc(token: string, path: string, body?: BodyInit) {
  insist(token.length > 0 && !/\s/.test(token), "pin_credentials_missing", 503);
  return new Request(rpcOrigin + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
}
/** A non-idempotent add is sent once by the outer publication journal. A lost
 * response is reconciled by the expected root; an absent lookup never permits
 * another add. Public availability and retained pin status are both required. */
export async function addPin(
  intent: PinIntent,
  bytes: Uint8Array,
  token: string,
  received: (receipt: {
    status: number;
    body: string;
    bodySha256: Hex;
    requestId: string | null;
  }) => Promise<void>,
  send: IpfsTransport = transport,
) {
  insist(
    canonical(await preparePin(bytes, intent.mediaType)) === canonical(intent),
    "pin_input_changed",
    409,
  );
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: intent.mediaType }),
    "content",
  );
  const response = await send(
    rpc(token, "/api/v0/add?cid-version=1&wrap-with-directory=false", form),
  );
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    await readBounded(response, 65536, false),
  );
  await received({
    status: response.status,
    body: raw,
    bodySha256: hashText(raw),
    requestId: response.headers.get("x-request-id")?.slice(0, 256) ?? null,
  });
  insist(response.ok, "pin_provider_unavailable", 503);
  const output = raw.trim();
  const lines = output.split("\n").map((line) => object(JSON.parse(line)));
  insist(
    lines.length === 1 && `ipfs://${text(lines[0]!.Hash, 128)}` === intent.uri,
    "pin_root_mismatch",
    503,
  );
  return reconcilePin(intent, token, send);
}
export async function reconcilePin(
  intent: PinIntent,
  token: string,
  send: IpfsTransport = transport,
) {
  const cid = ipfsUri(intent.uri).slice(7),
    response = await send(rpc(token, `/api/v0/pin/ls?arg=${cid}`));
  const raw = await readBounded(response, 65536),
    result = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    ),
    keys = object(result.Keys),
    pin = object(keys[cid]);
  insist(pin.Type === "recursive", "pin_not_retained", 503);
  const { bytes, gateway } = await fetchPublicIpfs(
    intent.uri,
    intent.sha256,
    intent.byteLength,
    send,
  );
  insist(bytes.length === intent.byteLength, "pin_length_mismatch", 503);
  return {
    ...intent,
    retained: true,
    gateway,
    verifiedAt: Math.floor(Date.now() / 1000),
  };
}
