// Current authenticated application state; no wizard-subset restore fallback.
import { readFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { unseal } from "../apps/community-wizard/infra/protected-data.ts";
import { canonical, hashJson, insist, object } from "../packages/community/common.ts";
import { digest, replacePrivateJson } from "./private-json.ts";
import {
  communityAccount,
  communityOwned,
  communityPrefix,
  writeCommunityPackage,
  type communityPackage,
} from "./community-package.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { verifyCommunityPackage, type CurrentCommunityState } from "./community-package-custody.ts";
export { privateJson, durableJson } from "./private-json.ts";
type Profile = Awaited<ReturnType<typeof communityPackage>>["profile"];
export function confinedName(path: string) {
  insist(
    path.length > 0 &&
      path.length <= 512 &&
      !path.includes("\\") &&
      path.split("/").every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== ".."),
    "community_package_path_invalid",
    409,
  );
  return path;
}
export async function privateNode(path: string, directory = false) {
  const stat = await lstat(path);
  insist(
    (directory ? stat.isDirectory() : stat.isFile()) &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid!() &&
      !(stat.mode & 0o077) &&
      (directory || stat.nlink === 1),
    "community_package_not_private_regular",
    409,
  );
  return stat;
}
/** Includes directory identities, so empty extras cannot hide from inventory. */
export async function regularTree(root: string, privateFiles = true): Promise<string[]> {
  if (privateFiles) await privateNode(root, true);
  else
    insist(
      (await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(),
      "community_package_input_link",
      409,
    );
  const result: string[] = [];
  async function walk(prefix: string) {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const name = confinedName(prefix ? `${prefix}/${entry.name}` : entry.name);
      insist(
        !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()),
        "community_package_unexpected_link_or_special",
        409,
      );
      if (privateFiles) await privateNode(join(root, name), entry.isDirectory());
      if (entry.isDirectory()) {
        result.push(name + "/");
        await walk(name);
      } else result.push(name);
    }
  }
  await walk("");
  insist(result.length <= 1024, "community_package_inventory_too_large", 409);
  return result.sort();
}

/** Pin resource targets while allowing the engine to update ordinary env values. */
function bindingIdentity(value: unknown, logical: string) {
  insist(Array.isArray(value), "community_state_binding_missing_or_foreign", 409);
  if (logical !== "App") {
    insist(value.length === 0, "community_state_binding_missing_or_foreign", 409);
    return [];
  }
  const required: Record<string, Record<string, string>> = {
    DB: { type: "d1", databaseId: communityOwned[1]!.id },
    MEDIA: { type: "r2_bucket", bucketName: communityOwned[2]!.id },
    JOBS: { type: "queue", queueId: communityOwned[3]!.id, queueName: communityPrefix + "-jobs" },
    KARAOKE_OPERATOR: { type: "service", service: "pirate-learning-testnet-v2" },
    KARAOKE_SPEECH_BUDGET: {
      type: "durable_object_namespace",
      className: "SpeechBudget",
      scriptName: "pirate-learning-testnet-v2",
    },
  };
  const seen = new Set<string>(),
    sids = new Set<string>();
  for (const raw of value) {
    const row = object(raw),
      data = object(row.data);
    insist(
      typeof row.sid === "string" &&
        !sids.has(row.sid) &&
        Array.isArray(data.bindings) &&
        data.bindings.length === 1,
      "community_state_binding_missing_or_foreign",
      409,
    );
    sids.add(row.sid);
    const binding = object(data.bindings[0]),
      name = String(binding.name);
    insist(
      !seen.has(name) &&
        (row.sid === name || (row.sid === "learning-operator" && name === "KARAOKE_OPERATOR")),
      "community_state_binding_missing_or_foreign",
      409,
    );
    seen.add(name);
    if (required[name])
      insist(
        Object.entries(required[name]!).every(([key, expected]) => binding[key] === expected) &&
          !binding.shim,
        "community_state_binding_missing_or_foreign",
        409,
      );
    else
      insist(
        /^[A-Z][A-Z0-9_]{0,127}$/.test(name) &&
          ["plain_text", "json", "secret_text"].includes(String(binding.type)),
        "community_state_binding_missing_or_foreign",
        409,
      );
  }
  insist(
    Object.keys(required).every((name) => seen.has(name)),
    "community_state_binding_missing_or_foreign",
    409,
  );
  return required;
}
/** Resource bindings are inline in pinned Alchemy ResourceState, not separate files. */
function stateIdentity(input: unknown, logical: string) {
  const value = object(input);
  if (logical === "__stack_output__") {
    insist(
      canonical(value) === canonical({ origin: firstSong.origin, database: communityOwned[1]!.id }),
      "community_state_output_foreign",
      409,
    );
    return hashJson(value);
  }
  const consumer = logical === "Consumer";
  const expected = communityOwned.find((r) => r.logical === logical);
  insist(expected || consumer, "community_unknown_state", 409);
  const attr = object(value.status === "updating" ? object(value.old).attr : value.attr);
  const attributes = consumer
    ? {
        accountId: communityAccount,
        queueId: communityOwned[3]!.id,
        scriptName: communityPrefix,
      }
    : { accountId: communityAccount, ...expected!.attributes };
  insist(
    ["created", "updated", "updating"].includes(String(value.status)) &&
      value.resourceType === (consumer ? "Cloudflare.Queues.Consumer" : expected!.type) &&
      (!value.kind || value.kind === "resource") &&
      value.logicalId === logical &&
      value.fqn === logical &&
      !value.namespace &&
      typeof value.instanceId === "string" &&
      value.instanceId.length > 0 &&
      value.instanceId.length <= 128 &&
      value.providerMode !== "local" &&
      !value.adoptionBlocked &&
      !value.propsIncomplete &&
      Object.entries(attributes).every(([k, v]) => attr[k] === v) &&
      (!consumer || (typeof attr.consumerId === "string" && attr.consumerId.length > 0)),
    "community_state_identity_changed",
    409,
  );
  // A partial update may carry an old attr set, but never a foreign new identity.
  if (value.attr)
    insist(
      Object.entries(attributes).every(([k, v]) => object(value.attr)[k] === v) &&
        (!consumer || object(value.attr).consumerId === attr.consumerId),
      "community_state_identity_changed",
      409,
    );
  const binding = bindingIdentity(value.bindings, logical);
  if (value.status === "updating")
    insist(
      canonical(bindingIdentity(object(value.old).bindings, logical)) === canonical(binding),
      "community_state_binding_missing_or_foreign",
      409,
    );
  return hashJson({
    resourceType: value.resourceType,
    logicalId: logical,
    fqn: value.fqn,
    instanceId: value.instanceId,
    attributes: { ...attributes, ...(consumer ? { consumerId: attr.consumerId } : {}) },
    bindings: binding,
  });
}
export function assertCommunityState(input: unknown, logical: string) {
  stateIdentity(input, logical);
}
/** Complete six-record inventory is authenticated in memory; no values are logged. */
export async function inventoryCommunityState(cwd: string, password: string): Promise<CurrentCommunityState> {
  await privateNode(cwd, true);
  await privateNode(join(cwd, ".alchemy"), true);
  const root = join(cwd, ".alchemy/state");
  const names = [...communityOwned.map((r) => r.logical), "Consumer", "__stack_output__"];
  const expected = names.map((n) => `${communityPrefix}/setup/${n}.json`).sort();
  insist(
    canonical(await regularTree(root)) ===
      canonical([`${communityPrefix}/`, `${communityPrefix}/setup/`, ...expected].sort()),
    "community_current_state_inventory_changed",
    409,
  );
  const files: Record<string, string> = {},
    identities: Record<string, string> = {};
  for (const relative of expected) {
    const bytes = await readFile(join(root, relative));
    const logical = relative.split("/").at(-1)!.slice(0, -5);
    identities[logical] = stateIdentity(
      JSON.parse(unseal(bytes.toString("utf8"), password, `alchemy-state:${relative}`)),
      logical,
    );
    files[relative] = digest(bytes);
  }
  // Detect a changed input while inventorying. Engine mutation needs custody too.
  for (const [relative, hash] of Object.entries(files))
    insist(
      digest(await readFile(join(root, relative))) === hash,
      "community_current_state_changed_during_read",
      409,
    );
  insist(
    canonical(await regularTree(root)) ===
      canonical([`${communityPrefix}/`, `${communityPrefix}/setup/`, ...expected].sort()),
    "community_current_state_inventory_changed",
    409,
  );
  return { files, identities };
}
export async function verifyCommunitySuccessor(directory: string, profile: Profile, password: string) {
  return verifyCommunityPackage(directory, hashJson(profile), profile.reviewedUpdate, (cwd) =>
    inventoryCommunityState(cwd, password),
  );
}

// Single community custody boundary; no creator-update runner is redirected.
export async function prepareCommunitySuccessor(
  directory: string,
  packaged: Awaited<ReturnType<typeof communityPackage>>,
  reviewed: boolean,
  password: string,
) {
  const { reviewedPredecessor, preserveReviewedPackage } = await import("./reviewed-update.ts");
  const { privateJson } = await import("./private-json.ts");
  const { communityDependencyModules } = await import("./community-dependencies.ts");
  const { profile, profileHash } = packaged;
  const authenticate = (cwd: string) => inventoryCommunityState(cwd, password);
  const execution = await privateJson(join(directory, "execution.json"));
  insist(execution, "community_package_execution_missing", 409);
  if (execution.profileHash !== profileHash) {
    insist(reviewed, "community_reviewed_update_flag_required", 409);
    const current = await verifyCommunitySuccessor(directory, profile, password);
    const links = {
      "deployment/node_modules": communityDependencyModules,
      ...(current.binding
        ? { [`${current.binding.relativePath}/node_modules`]: communityDependencyModules }
        : {}),
    };
    await reviewedPredecessor(directory, packaged);
    await preserveReviewedPackage(directory, profileHash, links);
    const binding = await writeCommunityPackage(directory, packaged, authenticate);
    await adoptCommunityPackage(directory, packaged, binding, authenticate);
  }
  const active = await verifyCommunitySuccessor(directory, profile, password);
  const binding = active.binding;
  insist(binding?.profileHash === profileHash, "community_package_binding_missing", 409);
  return { ...active, binding };
}

// Community-only atomic adoption. Generic creator-update adoption stays unchanged.
export async function adoptCommunityPackage(
  directory: string,
  packaged: Parameters<typeof import("./reviewed-update.ts").reviewedPredecessor>[1],
  binding: import("./community-package-custody.ts").CommunityPackageBinding,
  authenticate: import("./community-package-custody.ts").AuthenticateState,
) {
  const { verifyPreparedCommunityPackage, verifyCommunityPackage } = await import(
    "./community-package-custody.ts"
  );
  const { reviewedPredecessor } = await import("./reviewed-update.ts");
  const qualified = await reviewedPredecessor(directory, packaged);
  insist(binding.profileHash === packaged.profileHash, "community_package_profile_substitution", 409);
  if (qualified.adopted) {
    const current = await verifyCommunityPackage(
      directory,
      packaged.profileHash,
      packaged.profile.reviewedUpdate,
      authenticate,
    );
    insist(canonical(current.binding) === canonical(binding), "community_package_binding_changed", 409);
    return;
  }
  await verifyPreparedCommunityPackage(directory, binding, packaged.profile.reviewedUpdate, authenticate);
  await replacePrivateJson(
    join(directory, "execution.json"),
    {
      profileHash: packaged.profileHash,
      previousProfileHash: packaged.profile.reviewedUpdate.previousProfileHash,
      previousExecutionSha256: packaged.profile.reviewedUpdate.expectedExecutionSha256,
      backup: join(directory, `before-update-${packaged.profileHash.slice(2)}`),
      packageBinding: binding,
      at: new Date().toISOString(),
    },
    packaged.profile.reviewedUpdate.expectedExecutionSha256,
  );
}
