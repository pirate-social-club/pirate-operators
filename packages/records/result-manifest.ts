// Canonical timed manifests are one raw IPFS block. Their CID is derivable from
// the public SHA-256 contentRevision, without a community API or lookup table.
import { CID } from "multiformats/cid";
import { create } from "multiformats/hashes/digest";
import { hexToBytes, type Hex } from "viem";
import { canonical, check, digest } from "../protocol/index.ts";
import { fetchPublicIpfs } from "../community/ipfs.ts";
import type { KaraokeManifest } from "../protocol/payments.ts";
export const RESULT_MANIFEST_MAX_BYTES = 262144;
export function resultManifestUri(hash: Hex) {
  return `ipfs://${CID.createV1(0x55, create(0x12, hexToBytes(hash))).toString()}`;
}
export function resultManifestBytes(manifest: KaraokeManifest) {
  const bytes = new TextEncoder().encode(canonical(manifest));
  check(bytes.length <= RESULT_MANIFEST_MAX_BYTES, "result_manifest_too_large");
  return bytes;
}
export async function publicResultManifest(
  hash: Hex,
): Promise<KaraokeManifest | undefined> {
  try {
    const { bytes } = await fetchPublicIpfs(
      resultManifestUri(hash),
      hash,
      RESULT_MANIFEST_MAX_BYTES,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      manifest = JSON.parse(text) as KaraokeManifest;
    check(
      canonical(manifest) === text && digest(manifest) === hash,
      "result_manifest_mismatch",
    );
    return manifest;
  } catch {
    return undefined;
  }
}
