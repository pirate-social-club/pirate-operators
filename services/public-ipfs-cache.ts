// Only published public content enters this namespace. No public key-serving
// route or bucket-access change is introduced; current chain authority is still
// checked by each caller before resolving these bytes.
import { hexToBytes, type Hex } from "viem";
import {
  readBounded,
  type PublicIpfsCache,
} from "../packages/community/ipfs.ts";
import { ipfsUri } from "../packages/community/manifest-core.ts";
import { bytes32, insist } from "../packages/community/common.ts";

export function publicIpfsCache(media: R2Bucket): PublicIpfsCache {
  const key = (uri: string, digest: Hex) =>
    `public-ipfs/v1/${ipfsUri(uri).slice(7)}/${bytes32(digest)}`;
  return {
    async read(uri, digest, maximum) {
      const stored = await media.get(key(uri, digest));
      if (!stored) return undefined;
      if (stored.size > maximum) {
        await stored.body.cancel();
        insist(false, "ipfs_content_too_large", 503);
      }
      return readBounded(new Response(stored.body), maximum);
    },
    async write(uri, digest, bytes) {
      await media.put(key(uri, digest), new Uint8Array(bytes), {
        sha256: hexToBytes(digest),
        httpMetadata: { contentType: "application/octet-stream" },
      });
    },
  };
}
