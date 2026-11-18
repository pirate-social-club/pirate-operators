import assert from "node:assert/strict";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { web2DanceRewardBinding, web2DanceRewardFile } from "../../packages/community/web2-dance-reward-attachment.ts";
import type { NativeGraph } from "./full-native-config.ts";

export const web2DanceScopeBinding = "WEB2_DANCE_RETAINED_SCOPE_JSON";
export const web2DanceScopeFile = "web2-dance-retained-owner-scope.json";
const names = new Set([web2DanceScopeBinding, web2DanceRewardBinding, "WEB2_DANCE_REWARD_ATTACHMENT_SHA256"]);

type SelectedGraph = Omit<NativeGraph, "directoryRuntimeBinding">;
export function web2DanceAuthorityMode(graph: SelectedGraph) {
  if (graph.publicationExpansion === "registry-revision-two/1" && graph.fixtureTransport && graph.nativePublication)
    return "fixture";
  if (graph.publicationExpansion === "retained-registry-revision-two/1" && !graph.fixtureTransport && graph.nativePublication)
    return "trusted-public";
  throw Error("web2_dance_activation_original_mount_required");
}

export function danceActivationPaths(graph: Omit<NativeGraph, "directoryRuntimeBinding">) {
  const bindings = graph.applicationBindings.filter(binding => binding.name === web2DanceScopeBinding);
  assert(!graph.secretBindings.some(binding => binding.name === web2DanceScopeBinding) &&
    !graph.actors.some(actor => actor.bindings.some(binding => binding.name === web2DanceScopeBinding)),
    "web2_dance_activation_alternate_binding_refused");
  if (bindings.length === 0) {
    assert(graph.publicationExpansion !== "retained-registry-revision-two/1" || !graph.danceRewardIntent,
      "web2_public_dance_scope_locator_required");
    return undefined;
  }

  const directory = graph.stateRoots.configuration;
  const publication = graph.nativePublication, mode = web2DanceAuthorityMode(graph);
  assert(directory && isAbsolute(directory) && normalize(directory) === directory &&
    graph.danceRewardIntent && publication, "web2_dance_activation_original_mount_required");
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
  return { directory, scope, reward, mode };
}

export interface Web2DanceBootSnapshot {
  directory: string;
  scope?: string;
  reward?: string;
}

/** The fixture keeps its existing Rewards mount. The public graph's signed
 * locators are dormant until the trusted launcher supplies verified snapshots. */
export function web2DanceActivationBindings(
  graph: NativeGraph, mode: "serve" | "initialize" | "cold-reconcile",
  snapshot?: Readonly<Web2DanceBootSnapshot>,
  trustedPublicationSelected = false,
) {
  const selected = danceActivationPaths(graph);
  const publicMode = selected?.mode === "trusted-public";
  const ordinary = graph.applicationBindings.filter(binding =>
    binding.name !== web2DanceScopeBinding && (!publicMode || binding.name !== web2DanceRewardBinding));
  if (!snapshot) return ordinary;
  assert(selected && mode === "serve" && isAbsolute(snapshot.directory) &&
    (!snapshot.scope || snapshot.scope === join(snapshot.directory, web2DanceScopeFile)) &&
    (publicMode ? trustedPublicationSelected &&
      snapshot.reward === join(snapshot.directory, web2DanceRewardFile + ".json") :
      snapshot.scope && snapshot.reward === undefined),
    "web2_dance_activation_boot_snapshot_required");
  return [...ordinary,
    ...(snapshot.reward ? [{ name: web2DanceRewardBinding, file: snapshot.reward }] : []),
    ...(snapshot.scope ? [{ name: web2DanceScopeBinding, file: snapshot.scope }] : []),
  ];
}
