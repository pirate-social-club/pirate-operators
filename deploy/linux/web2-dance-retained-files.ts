import assert from "node:assert/strict";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { web2DanceRewardBinding, web2DanceRewardFile } from "../../packages/community/web2-dance-reward-attachment.ts";
import type { NativeGraph } from "./full-native-config.ts";

export const web2DanceScopeBinding = "WEB2_DANCE_RETAINED_SCOPE_JSON";
export const web2DanceScopeFile = "web2-dance-retained-owner-scope.json";
const names = new Set([web2DanceScopeBinding, web2DanceRewardBinding, "WEB2_DANCE_REWARD_ATTACHMENT_SHA256"]);

export function danceActivationPaths(graph: Omit<NativeGraph, "directoryRuntimeBinding">) {
  const bindings = graph.applicationBindings.filter(binding => binding.name === web2DanceScopeBinding);
  assert(!graph.secretBindings.some(binding => binding.name === web2DanceScopeBinding) &&
    !graph.actors.some(actor => actor.bindings.some(binding => binding.name === web2DanceScopeBinding)),
    "web2_dance_activation_alternate_binding_refused");
  if (bindings.length === 0) return undefined;

  const directory = graph.stateRoots.configuration;
  const publication = graph.nativePublication;
  assert(directory && isAbsolute(directory) && normalize(directory) === directory &&
    graph.danceRewardIntent && publication && graph.publicationExpansion === "registry-revision-two/1" &&
    graph.fixtureTransport, "web2_dance_activation_original_mount_required");
  const scope = join(directory, web2DanceScopeFile);
  const reward = join(dirname(publication.directory), "dance-rewards", web2DanceRewardFile + ".json");
  assert(bindings.length === 1 && bindings[0]?.file === scope &&
    Object.keys(bindings[0]).length === 2, "web2_dance_activation_signed_locator_required");
  const mountedRewards = graph.applicationBindings.filter(binding =>
    binding.name === web2DanceRewardBinding || binding.name === "WEB2_DANCE_REWARD_ATTACHMENT_SHA256");
  assert(mountedRewards.length === 1 && mountedRewards[0]?.name === web2DanceRewardBinding &&
    mountedRewards[0].file === reward && Object.keys(mountedRewards[0]).length === 2 &&
    !graph.secretBindings.some(binding => names.has(binding.name)) &&
    !graph.actors.some(actor => actor.bindings.some(binding => names.has(binding.name))),
    "web2_dance_activation_signed_reward_mount_required");
  return { directory, scope, reward };
}

/** Keep the immutable locator out of the effective application config. Only
 * serve can embed a checked boot snapshot from the selected launcher. */
export function web2DanceActivationBindings(
  graph: NativeGraph, mode: "serve" | "initialize" | "cold-reconcile",
  snapshot?: Readonly<{ directory: string; scope: string }>,
) {
  const selected = danceActivationPaths(graph);
  const ordinary = graph.applicationBindings.filter(binding => binding.name !== web2DanceScopeBinding);
  if (!snapshot) return ordinary;
  assert(selected && mode === "serve" && isAbsolute(snapshot.directory) &&
    snapshot.scope === join(snapshot.directory, web2DanceScopeFile),
    "web2_dance_activation_boot_snapshot_required");
  return [...ordinary, { name: web2DanceScopeBinding, file: snapshot.scope }];
}
