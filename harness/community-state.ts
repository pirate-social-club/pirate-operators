import { readFile, lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unseal } from "../apps/community-wizard/infra/protected-data.ts";
import { canonical, insist, object } from "../packages/community/common.ts";
import { fileDigest } from "./creator-state.ts";
import {
  communityAccount,
  communityBase,
  communityOwned,
  type communityPackage,
} from "./community-package.ts";

type Profile = Awaited<ReturnType<typeof communityPackage>>["profile"];
export async function privateJson(path: string) {
  try {
    const stat = await lstat(path);
    insist(
      stat.isFile() && stat.uid === process.getuid!() && !(stat.mode & 0o077),
      "community_metadata_not_private",
      409,
    );
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** A final name appears only after complete bytes are durable. A lost response
 * can reuse the same document; a conflicting committed value is never replaced. */
export async function durableJson(
  path: string,
  value: unknown,
  boundary?: (phase: "prepared" | "committed") => Promise<void>,
) {
  const temporary = `${path}.${randomUUID()}.tmp`,
    handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await boundary?.("prepared");
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await privateJson(path);
    insist(
      existing && canonical(existing) === canonical(value),
      "community_metadata_conflict",
      409,
    );
  }
  const parent = await open(join(path, ".."), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  await boundary?.("committed");
  await unlink(temporary);
}
export function assertCommunityState(input: unknown, logical: string) {
  if (logical === "__stack_output__") return;
  const expected = communityOwned.find((r) => r.logical === logical);
  insist(expected, "community_unknown_state", 409);
  const value = object(input),
    attr = object(
      value.status === "updating" ? object(value.old).attr : value.attr,
    );
  insist(
    ["created", "updated", "updating"].includes(String(value.status)) &&
      value.resourceType === expected.type &&
      value.logicalId === logical &&
      attr.accountId === communityAccount &&
      Object.entries(expected.attributes).every(([k, v]) => attr[k] === v),
    "community_state_identity_changed",
    409,
  );
}
/** Copies only authenticated encrypted state, using exclusive durable names.
 * The historical wizard state is never overwritten or used for a new apply. */
export async function restoreCommunityState(
  directory: string,
  profile: Profile,
  password: string,
) {
  const root = join(directory, "deployment/.alchemy/state");
  for (const [relative, digest] of Object.entries(profile.predecessorState)) {
    insist(
      /^pirate-first-song-20261105\/setup\/\w+\.json$/.test(relative),
      "community_invalid_state_path",
      409,
    );
    const logical = relative.split("/").at(-1)!.slice(0, -5),
      original = join(communityBase, "deployment/.alchemy/state", relative),
      bytes = await readFile(original);
    insist(
      fileDigest(bytes) === digest,
      "community_original_state_changed",
      409,
    );
    assertCommunityState(
      JSON.parse(
        unseal(bytes.toString("utf8"), password, `alchemy-state:${relative}`),
      ),
      logical,
    );
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(path);
      insist(
        stat.isFile() && stat.uid === process.getuid!() && !(stat.mode & 0o077),
        "community_successor_state_not_private",
        409,
      );
      assertCommunityState(
        JSON.parse(
          unseal(
            await readFile(path, "utf8"),
            password,
            `alchemy-state:${relative}`,
          ),
        ),
        logical,
      );
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${path}.restore-${randomUUID()}.tmp`,
      handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
    for (let parent = join(path, ".."); ; parent = join(parent, "..")) {
      const folder = await open(parent, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      if (parent === directory) break;
    }
    await unlink(temporary);
  }
}
