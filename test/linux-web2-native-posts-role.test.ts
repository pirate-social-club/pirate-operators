import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readNativePostsRole } from "../deploy/linux/web2-native-posts-role.ts";
import { nativePublicationPaths } from "../deploy/linux/web2-publication-selection.ts";

test("Posts refuses publication bearer aliases from the actual native transport paths", async t => {
  const root = await mkdtemp(join(tmpdir(), "pirate-native-posts-role-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicationDirectory = join(root, "publication-transport");
  const postsDirectory = join(root, "posts-custody");
  await mkdir(publicationDirectory, { mode: 0o700 });
  await mkdir(postsDirectory, { mode: 0o700 });
  const postsPath = join(postsDirectory, "host.auth");
  const { request, lookup } = nativePublicationPaths(publicationDirectory);
  const roles = { request, lookup };
  const write = (path: string, byte: string) => writeFile(path, byte.repeat(64), { mode: 0o600 });

  await write(postsPath, "a");
  assert((await readNativePostsRole(postsPath)).length === 64, "posts_role_not_read");
  await write(request, "b");
  await assert.rejects(readNativePostsRole(postsPath, roles), { code: "ENOENT" });
  await write(lookup, "c");
  assert((await readNativePostsRole(postsPath, roles)).length === 64, "distinct_roles_not_read");
  await assert.rejects(readNativePostsRole(request, roles), /native_posts_private_role_alias/);

  await write(request, "a");
  await assert.rejects(readNativePostsRole(postsPath, roles), /native_posts_private_role_alias/);
  await write(request, "b");
  await write(lookup, "a");
  await assert.rejects(readNativePostsRole(postsPath, roles), /native_posts_private_role_alias/);
  await write(lookup, "b");
  await assert.rejects(readNativePostsRole(postsPath, roles), /native_posts_private_role_alias/);
  await write(lookup, "c");
  assert((await readNativePostsRole(postsPath, roles)).length === 64, "distinct_roles_not_read_after_refusal");
});
