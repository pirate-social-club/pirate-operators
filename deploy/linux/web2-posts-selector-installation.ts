import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { hashJson, canonical } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import {
  parseNativePostsCustodySelection, type NativePostsCustodySelection,
} from "../../packages/community/native-posts-custody.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { InstalledTarget } from "./local-target-controller.ts";
import { privateDirectory, privateFile, syncDirectory } from "./backend-state.ts";
import { optionalWeb2Record, retainWeb2Record } from "./web2-runtime-binding.ts";

export interface Web2PostsInstallationInputs {
  /** Read under the real held owner. Supplies the observed private Anvil
   * endpoint/genesis and selected expanded publisher authority. */
  selection(original: Web2NativeOriginal, graph: NativeGraph): Promise<NativePostsCustodySelection>;
}

const selectorName = "POSTS_CUSTODY_SELECTION_JSON", roleName = "POSTS_CUSTODY_HOST_AUTH";
type BootstrapGraph = Omit<NativeGraph, "directoryRuntimeBinding">;

const contains = (root: string, path: string) => {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith("../");
};

export function postsSelectorPath(graph: BootstrapGraph, target: InstalledTarget) {
  const selectors = graph.applicationBindings.filter(binding => binding.name === selectorName);
  const roles = graph.secretBindings.filter(binding => binding.name === roleName);
  assert(!graph.applicationBindings.some(binding => binding.name === roleName) &&
    !graph.secretBindings.some(binding => binding.name === selectorName) &&
    !graph.actors.some(actor => actor.bindings.some(binding => binding.name === selectorName || binding.name === roleName)),
    "native_posts_storage_role_refused");
  if (!selectors.length && !roles.length) return undefined;
  assert(selectors.length === 1 && roles.length === 1 && graph.fixtureTransport, "native_posts_install_owner_unavailable");
  const directory = join(target.stateRoot, "posts-custody");
  const path = join(directory, "selection.json");
  assert(selectors[0]!.file === path && Object.keys(selectors[0]!).sort().join(",") === "file,name" &&
    roles[0]!.path === join(directory, "host.auth") && !contains(graph.releaseRoot, directory),
    "native_posts_install_selector_changed");
  const app = target.containers.filter(container => container.key === "application");
  assert(app.length === 1 && app[0]!.mounts.filter(m =>
    m.source === directory && m.target === directory && m.readOnly).length === 1,
    "native_posts_install_read_only_mount_required");
  for (const container of target.containers) for (const mount of container.mounts) {
    if (container === app[0] && mount.source === directory && mount.target === directory && mount.readOnly) continue;
    assert(![mount.source, mount.target].some(path => contains(path, directory) || contains(directory, path)),
      "native_posts_install_alternate_mount_refused");
  }
  const otherFiles = [...graph.secretBindings.filter(binding => binding.name !== roleName).map(binding => binding.path),
    ...[...graph.applicationBindings.filter(binding => binding.name !== selectorName),
      ...graph.actors.flatMap(actor => actor.bindings)].flatMap(binding => binding.file ? [binding.file] : [])];
  assert(otherFiles.every(file => !contains(directory, file)), "native_posts_install_role_alias_refused");
  return path;
}

export async function stagePostsSelector(input: {
  original: Web2NativeOriginal;
  graph: NativeGraph;
  target: InstalledTarget;
  owner: Web2PostsInstallationInputs;
  startRetained: boolean;
  assertCurrent(): Promise<void>;
}) {
  const { original, graph, target, owner, assertCurrent } = input;
  const path = postsSelectorPath(graph, target);
  assert(path && graph.fixtureTransport, "native_posts_install_selector_required");
  const draft = original.record.body.draft, directory = dirname(path);
  await assertCurrent();
  await privateDirectory(directory);
  const intentFile = join(directory, "posts-selector-intent.json");
  const retained = await optionalWeb2Record<NativePostsCustodySelection>(intentFile);
  const existing = await privateFile(path, 4096).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  try {
    assert((retained || !existing) && (!input.startRetained || (existing && retained)),
      "native_posts_install_original_selector_missing");
    const value = retained ? canonical(retained) : canonical(await owner.selection(structuredClone(original), structuredClone(graph)));
    assert(!existing || await existing.readFile("utf8") === value, "native_posts_install_selector_bytes_changed");
    const selected = parseNativePostsCustodySelection(value), scope = selected.scope;
    assert(selected.hostInstallationId === graph.installationId &&
      selected.hostInstallationId === original.record.body.installationId &&
      selected.originalSha256 === "0x" + nativeDigest(original) &&
      scope.origin === draft.origin && scope.chainId === draft.configuration.chainId &&
      scope.installationId === draft.enrollment.installationId && scope.communityId === draft.enrollment.communityId &&
      scope.publisher === draft.configuration.publisher && scope.native.applicationRpcUrl === draft.deployment.rpcUrl &&
      scope.native.fixtureTransportSha256 === hashJson(graph.fixtureTransport) &&
      graph.fixtureTransport.routes.filter(route => route.origin === new URL(draft.deployment.rpcUrl).origin).length === 1,
      "native_posts_install_original_scope_changed");
    await assertCurrent();
    await retainWeb2Record(directory, "posts-selector-intent", selected);
    await assertCurrent();
    if (existing) await existing.sync();
    else {
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(value); await file.sync(); }
      finally { await file.close(); }
    }
    await syncDirectory(directory);
    await assertCurrent();
  } finally { await existing?.close(); }
}
