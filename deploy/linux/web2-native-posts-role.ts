import assert from "node:assert/strict";
import { privateFile } from "./backend-state.ts";

async function readRole(path: string) {
  const file = await privateFile(path, 64);
  const bytes = Buffer.alloc(64);
  try {
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const role = bytes.toString("ascii");
    assert(bytesRead === 64 && (await file.stat()).size === 64 && /^[a-f0-9]{64}$/.test(role),
      "native_posts_host_capability_changed");
    return role;
  } finally {
    bytes.fill(0);
    await file.close();
  }
}

/** Read only the exact private file roles mounted by the selected graph.
 * Separate mounts can still contain the same bearer. */
export async function readNativePostsRole(
  capabilityFile: string,
  publication?: Readonly<{ request: string; lookup: string }>,
): Promise<string> {
  if (!publication) return readRole(capabilityFile);
  const files = [capabilityFile, publication.request, publication.lookup];
  assert(new Set(files).size === files.length, "native_posts_private_role_alias");
  const roles = await Promise.all(files.map(readRole));
  assert(new Set(roles).size === roles.length, "native_posts_private_role_alias");
  return roles[0]!;
}
