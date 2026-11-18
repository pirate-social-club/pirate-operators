import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { canonical, hashJson } from "../../packages/community/common.ts";
import type { CommunityConfig } from "../../packages/community/config-manifest.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import {
  parseNativePostsCustodySelection, type NativePostsCustodySelection, type NativePostsPublisherSelection,
} from "../../packages/community/native-posts-custody.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { publicationSelectionHash } from "../../services/publication-app-selection.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { canonicalDigest } from "./installed-records.ts";
import type { Web2ExpandedPublicationApproval } from "./web2-expanded-publication.ts";

export type BootstrapPostsScope = Readonly<{
  chainId: 6343; genesisHash: Hex; publisher: Address; communityId: Hex; installationId: string;
}>;

/** Construct the installed selector only from this foreground original's
 * held bootstrap lease and independently verified canonical expansion. */
export function captureFreshPostsSelection(input: {
  original: Web2NativeOriginal;
  graph: NativeGraph;
  scope: BootstrapPostsScope;
  publisher: Readonly<NativePostsPublisherSelection>;
  directRpcUrl: unknown;
  history: readonly CommunityConfig[];
  proof: Web2ExpandedPublicationApproval["proof"];
}) {
  const { original, graph, scope, publisher, proof } = input;
  const { draft, installationId } = original.record.body;
  const { selection, evidence } = proof;
  const transport = graph.fixtureTransport;
  const rpcOrigin = new URL(draft.deployment.rpcUrl).origin;
  const entries = selection.entries.filter(entry => publicationSelectionHash(entry.release) === selection.active);
  const release = entries[0]?.release;
  const originalSha256 = nativeDigest(original);
  assert(graph.installationId === installationId && graph.durableScope === original.durableScope &&
    graph.publicationExpansion === "registry-revision-two/1" && graph.nativePublication &&
    transport?.schema === "pirate.linux-local-fixture-transport/1" &&
    transport.routes.filter(route => route.origin === rpcOrigin).length === 1 && graph.allowedOrigins.includes(rpcOrigin) &&
    evidence.nativeOriginalSha256 === originalSha256 && evidence.hostInstallationId === installationId &&
    evidence.releaseArtifactDigest === original.release.body.artifactDigest &&
    evidence.releaseSourceDigest === original.release.body.sourceDigest &&
    evidence.releaseSha256 === selection.active && evidence.selectionSha256 === hashJson(selection) &&
    selection.incarnation === "1" && selection.previous === null && selection.entries.length === 1 &&
    selection.installedBindingSha256 === "0x" + originalSha256 && selection.communityId === scope.communityId &&
    selection.installationId === scope.installationId && selection.origin === draft.origin &&
    evidence.communityId === scope.communityId && evidence.directoryInstallationId === scope.installationId &&
    evidence.genesisHash === scope.genesisHash && evidence.configurationRevision === 2 &&
    draft.configuration.configurationRevision === 1 && draft.configuration.chainId === scope.chainId &&
    draft.configuration.publisher === scope.publisher && draft.enrollment.communityId === scope.communityId &&
    draft.enrollment.installationId === scope.installationId && entries.length === 1 && release &&
    release.operator === scope.publisher && release.fee.payer === scope.publisher &&
    entries[0]!.transportRef === graph.nativePublication.transportRef && graph.nativePublication.operatorAddress === scope.publisher &&
    publisher.chainId === scope.chainId && publisher.communityId === scope.communityId &&
    publisher.installationId === scope.installationId && publisher.publisher === scope.publisher &&
    publisher.genesisHash === scope.genesisHash && publisher.releaseSelectionSha256 === evidence.releaseSha256 &&
    publisher.rpcUrl === input.directRpcUrl && input.history.length === 2 &&
    canonical(input.history) === canonical([draft.configuration, release.configuration]),
    "native_fresh_posts_selection_changed");
  const selected = parseNativePostsCustodySelection(canonical({
    schema: "pirate.native-posts-custody-selection/1",
    hostInstallationId: installationId,
    originalSha256: "0x" + originalSha256,
    releaseSelectionSha256: publisher.releaseSelectionSha256,
    scope: {
      chainId: scope.chainId, genesisHash: scope.genesisHash, rpcUrl: publisher.rpcUrl,
      publisher: scope.publisher, communityId: scope.communityId, installationId: scope.installationId,
      origin: draft.origin,
      native: { applicationRpcUrl: draft.deployment.rpcUrl, fixtureTransportSha256: hashJson(transport) },
    },
  }));
  return { selected, graphSha256: canonicalDigest(graph), proofSha256: canonicalDigest(proof) };
}

export type FreshPostsSelection = Readonly<ReturnType<typeof captureFreshPostsSelection>>;

/** The installer owns writing the selector. Reopening the original cannot
 * materialize bytes from any other graph, approval or foreground operation. */
export function readFreshPostsSelection(captured: FreshPostsSelection | undefined, input: {
  original: Web2NativeOriginal;
  graph: NativeGraph;
  proof: Web2ExpandedPublicationApproval["proof"];
}): NativePostsCustodySelection {
  assert(captured && captured.graphSha256 === canonicalDigest(input.graph) &&
    captured.proofSha256 === canonicalDigest(input.proof) &&
    captured.selected.originalSha256 === "0x" + nativeDigest(input.original),
    "native_fresh_posts_original_unavailable");
  return structuredClone(captured.selected);
}
