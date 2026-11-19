import assert from "node:assert/strict";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
  type BigIntStats,
} from "node:fs";
import { hash } from "./backend-state.ts";

/** Short, already-authorized private files checked at the synchronous effect
 * boundary. Keep only a digest and physical identity, never the secret bytes. */
export function pinNativeDanceEffectFile(path: string, limit: number, expectedSha256?: string) {
  function stamp(info: BigIntStats) {
    assert(info.isFile() && info.nlink === 1n && info.uid === BigInt(process.getuid!()) &&
      !(info.mode & 0o077n) && info.size > 0n && info.size <= BigInt(limit),
      "native_dance_effect_file_unavailable");
    return [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
  }
  function read() {
    assert(realpathSync(path) === path, "native_dance_effect_file_changed");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytesToWipe: Buffer | undefined;
    try {
      const before = fstatSync(fd, { bigint: true });
      const identity = stamp(before);
      const bytes = Buffer.alloc(Number(before.size));
      bytesToWipe = bytes;
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        assert(count > 0, "native_dance_effect_file_changed");
        offset += count;
      }
      assert(stamp(fstatSync(fd, { bigint: true })) === identity &&
        stamp(lstatSync(path, { bigint: true })) === identity &&
        realpathSync(path) === path, "native_dance_effect_file_changed");
      return { identity, digest: hash(bytes) };
    } finally {
      bytesToWipe?.fill(0);
      closeSync(fd);
    }
  }
  assert(Number.isSafeInteger(limit) && limit > 0, "native_dance_effect_file_limit_changed");
  const pinned = read();
  assert(expectedSha256 === undefined || pinned.digest === expectedSha256, "native_dance_effect_file_changed");
  return () => {
    const current = read();
    assert(current.identity === pinned.identity && current.digest === pinned.digest, "native_dance_effect_file_changed");
  };
}
