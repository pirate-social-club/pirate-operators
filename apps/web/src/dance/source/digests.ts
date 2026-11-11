/** Exact existing backend boundary: V5 bytes32 uses 0x; source3 SHA256 uses
 * 64 lowercase digits. Never alter a retained command's chosen representation. */
export function producerDigest(v5: string): string {
  if (!/^0x[a-f0-9]{64}$/.test(v5) || /^0x0+$/.test(v5))
    throw Error("dance_digest_invalid");
  return v5.slice(2);
}
export function verdictDigest(producer: string): string {
  if (!/^[a-f0-9]{64}$/.test(producer) || /^0+$/.test(producer))
    throw Error("dance_digest_invalid");
  return "0x" + producer;
}
