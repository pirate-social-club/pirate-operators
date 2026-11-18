import assert from "node:assert/strict";
import type { Hex } from "viem";
import { isAbsolute, join, normalize, relative } from "node:path";
import { type OperationLease, privateDirectory } from "./backend-state.ts";
import { canonicalDigest, verifyRecord, type SignedRecord } from "./installed-records.ts";
import { publicIngressFrom } from "./public-ingress.ts";
import type { Web2RuntimeBindingPolicy } from "./web2-runtime-binding.ts";
import { optionalWeb2Record, retainWeb2Record } from "./web2-runtime-binding.ts";
import {
  nativePublicationPaths,
  publicationMountFor,
  type Web2NativePublicationInitialization,
  type Web2NativePublicationMount,
} from "./web2-publication-selection.ts";
import { createNativePublicationActivityRoute, type NativePublicationActivityRoute } from "./web2-native-publication-host.ts";
import type { PublicationInstallationSpec } from "../../services/publication-installed-selection.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { Web2PublishingAttachment } from "./web2-operator-inputs.ts";

/** Trusted backend owner reads the exact authorized install plan's publication
 * selection. This port has no D1 mutation, issuer socket, or browser inputs. */
export interface Web2PublicationInstallationInputs {
  selection(original: Web2NativeOriginal): Promise<PublicationInstallationSpec>;
  signMount(body: Web2NativePublicationMount): Promise<SignedRecord<Web2NativePublicationMount>>;
  prepareExpansion?(input: Web2PublicationPreparation): Promise<void>;
  activateAfterStaging?(input: Web2PublicationActivation): Promise<void>;
}
export interface Web2PublicationPreparation {
  original: Web2NativeOriginal;
  graph: NativeGraph;
  attachment: Web2PublishingAttachment;
  /** Rechecks the original, signed host binding and uncreated installation. */
  assertCurrent(): Promise<void>;
  /** Same original and foreground lease across bootstrap and mounted operation. */
  assertLifetimeHeld(): Promise<void>;
}
export interface Web2PublicationActivation {
  original: Web2NativeOriginal;
  selection: PublicationInstallationSpec;
  selectionSha256: Hex;
  assertCurrent(): Promise<void>;
}

export interface Web2PublicationMountIntent {
  schema: "pirate.web2-native-publication-intent/1";
  body: Web2NativePublicationMount;
  selection: PublicationInstallationSpec;
}

const within = (root: string, path: string) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith("../");
};

export function nativePublicationHostSelection(policy: Web2RuntimeBindingPolicy) {
  const transport = policy.graph.nativePublication;
  assert(transport && transport.schema === "pirate.web2-native-publication-transport/1" &&
    Object.keys(transport).sort().join(",") === "directory,issuerAddress,issuerCapabilityRef,operatorAddress,schema,transportRef" &&
    policy.nativeActivities && policy.privateStudy, "native_publication_host_scope_changed");
  const dir = transport.directory, paths = nativePublicationPaths(dir), socket = policy.nativeActivities.socket;
  const ingress = publicIngressFrom(policy.ingress);
  const app = policy.target.containers.filter(container => container.key === "application");
  const upstreamPort = Number(new URL(ingress.upstream).port);
  assert(isAbsolute(dir) && normalize(dir) === dir && dir === join(policy.target.stateRoot, "publication-transport") &&
    !within(policy.graph.releaseRoot, dir) && !within(policy.bindingDirectory, dir) &&
    !within(dir, socket) && app.length === 1 &&
    app[0]!.ports.some(port => port.ip === "127.0.0.1" && port.host === upstreamPort) &&
    app[0]!.mounts.filter(m => m.source === dir && m.target === dir && m.readOnly).length === 1,
    "native_publication_signed_mount_changed");
  for (const container of policy.target.containers) {
    for (const mount of container.mounts) {
      if (container === app[0] && mount.source === dir && mount.target === dir && mount.readOnly) continue;
      assert(![mount.source, mount.target].some(path => within(path, dir) || within(dir, path)),
        "native_publication_alternate_mount_refused");
    }
  }
  const otherFiles = [...policy.graph.secretBindings.map(binding => binding.path),
    ...[...policy.graph.applicationBindings, ...policy.graph.actors.flatMap(actor => actor.bindings)]
      .flatMap(binding => binding.file === undefined ? [] : [binding.file])];
  assert(otherFiles.every(file => !within(dir, file)), "native_publication_capability_alias_refused");
  return {transport, paths, socket, ingress};
}

export function assertNativePublicationHost(
  policy: Web2RuntimeBindingPolicy,
  route: NativePublicationActivityRoute,
  lease: OperationLease,
) {
  const { transport, paths, socket, ingress } = nativePublicationHostSelection(policy);
  assert(route.lease === lease && route.socket === socket &&
    route.ingressDigest === canonicalDigest(ingress) &&
    route.transportRef === transport.transportRef && route.issuerCapabilityRef === transport.issuerCapabilityRef &&
    route.issuerAddress === transport.issuerAddress && route.operatorAddress === transport.operatorAddress &&
    route.requestCapabilityFile === paths.request && route.lookupCapabilityFile === paths.lookup,
    "native_publication_host_scope_changed");
}

type HostTransportInputs = Parameters<typeof createNativePublicationActivityRoute>[0];

/** Backend factory seam. Catalog, issuer and Store must already be held by
 * the admitted owner. This joins the existing activity lease and Wizard. */
export async function openWeb2PublicationTransport(
  policy: Web2RuntimeBindingPolicy,
  lease: OperationLease,
  owner: Pick<HostTransportInputs, "retainedSelection" | "issuer" | "operator" | "assertCurrent" | "firstGrant" | "retainedDance">,
) {
  const { transport, paths, socket, ingress } = nativePublicationHostSelection(policy);
  assert(!owner.firstGrant || policy.graph.publicationExpansion === "registry-revision-two/1" && policy.graph.fixtureTransport,
    "native_publication_first_grant_unadmitted");
  assert(owner.issuer.address.toLowerCase() === transport.issuerAddress &&
    owner.issuer.capabilityRef === transport.issuerCapabilityRef &&
    owner.operator.operatorAddress.toLowerCase() === transport.operatorAddress,
    "native_publication_retained_authority_unavailable");
  const route = await createNativePublicationActivityRoute({
    ...owner, lease, socket, ingress,
    requestCapabilityFile: paths.request, lookupCapabilityFile: paths.lookup, selection: {
      transportRef: transport.transportRef, issuerCapabilityRef: transport.issuerCapabilityRef,
      issuerAddress: transport.issuerAddress, operatorAddress: transport.operatorAddress,
    },
  });
  assertNativePublicationHost(policy, route, lease);
  return route;
}

/** Finish the retained host selection after the original plan is signed, before
 * controller start. On restart only the same signed selector is accepted. */
export async function stageNativePublication(input: {
  original: Web2NativeOriginal;
  transport: NonNullable<Web2RuntimeBindingPolicy["graph"]["nativePublication"]>;
  ports: Web2PublicationInstallationInputs;
  startRetained: boolean;
  expectedSelectionSha256?: Hex;
  assertCurrent(): Promise<void>;
}) {
  const { original, transport, ports, assertCurrent } = input;
  const dir = transport.directory, paths = nativePublicationPaths(dir);
  await assertCurrent();
  await privateDirectory(dir);
  let intent = await optionalWeb2Record<Web2PublicationMountIntent>(paths.intent);
  let retained = await optionalWeb2Record<Web2NativePublicationInitialization>(paths.initialization);
  const mount = await optionalWeb2Record<SignedRecord<Web2NativePublicationMount>>(paths.selector);
  if (!intent) {
    assert(!input.startRetained && !retained && !mount, "native_publication_intent_missing");
    const selection = structuredClone(await ports.selection(structuredClone(original)));
    intent = { schema: "pirate.web2-native-publication-intent/1",
      body: publicationMountFor(original, selection, transport), selection };
  }
  assert(intent.schema === "pirate.web2-native-publication-intent/1" &&
    canonicalDigest(intent.body) === canonicalDigest(publicationMountFor(original, intent.selection, transport)),
    "native_publication_retained_intent_changed");
  assert(input.expectedSelectionSha256 === undefined ||
    intent.body.mount.selectionSha256 === input.expectedSelectionSha256,
    "native_expanded_publication_selection_changed");
  await assertCurrent();
  await retainWeb2Record(dir, "publication-intent", intent);
  if (!retained) {
    assert(!input.startRetained && !mount, "native_publication_initialization_original_missing");
    await assertCurrent();
    const selector = structuredClone(await ports.signMount(structuredClone(intent.body)));
    retained = { schema: "pirate.web2-native-publication-initialization/1", selector, selection: intent.selection };
  }
  assert(retained.schema === "pirate.web2-native-publication-initialization/1" &&
    Buffer.byteLength(JSON.stringify(retained) + "\n") <= 5 * 1024 ** 2 &&
    canonicalDigest(retained.selection) === canonicalDigest(intent.selection) &&
    canonicalDigest(verifyRecord(retained.selector, original.trust)) === canonicalDigest(intent.body) &&
    (!mount || canonicalDigest(mount) === canonicalDigest(retained.selector)),
    "native_publication_retained_mount_changed");
  await assertCurrent();
  await retainWeb2Record(dir, "publication-initialization", retained);
  await assertCurrent();
  await retainWeb2Record(dir, "publication-native-mount", retained.selector);
  await assertCurrent();
  return retained;
}
