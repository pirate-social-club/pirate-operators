import assert from "node:assert/strict";
import { dirname, join, normalize, relative, isAbsolute } from "node:path";
import { bytes32, canonical, hashJson } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import type { Hex } from "viem";
import { nativePostsDispatchPath, nativePostsObservationPath, nativePostsQuotePath } from "../../services/native-posts-publication.ts";
import { hash, privateDirectory, privateFile, type OperationLease } from "./backend-state.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { InstalledTarget } from "./local-target-controller.ts";
import { verifyRecord, type SignedRecord } from "./installed-records.ts";
import { publishingAttachment } from "./web2-publishing-attachment.ts";
import { optionalWeb2Record, retainWeb2Record } from "./web2-runtime-binding.ts";

export interface ProtectedFirstSongGraph {
  schema: "pirate.web2-protected-posts-transport/1";
  transportRef: string;
  directory: string;
}

export interface ProtectedFirstSongRoute {
  lease: OperationLease;
  socket: string;
  fetch(request: Request): Promise<Response | null>;
  close(): Promise<void>;
}

export interface ProtectedFirstSongInstallationInputs {
  open(input: {
    original: Web2NativeOriginal;
    graph: NativeGraph;
    startRetained: boolean;
    assertCurrent(): Promise<void>;
  }): Promise<ProtectedFirstSongRoute>;
}

interface ProtectedPostsSelection {
  schema: "pirate.web2-protected-posts-mount/1";
  transportRef: string;
  hostInstallationId: string;
  installationId: Hex;
  applicationOriginalSha256: Hex;
  releaseSha256: Hex;
  configurationSha256: Hex;
  grantSha256: Hex;
}

export const protectedPostsBinding = {
  owner: "WEB2_PROTECTED_POSTS_OWNER",
  selection: "WEB2_PROTECTED_POSTS_SELECTION_JSON",
  forward: "WEB2_PROTECTED_POSTS_FORWARD_AUTH",
  reverse: "WEB2_PROTECTED_POSTS_REVERSE_AUTH",
} as const;
export const protectedPostsRoute = (path?: string) => path === nativePostsQuotePath ||
  path === nativePostsDispatchPath || path === nativePostsObservationPath ||
  path === "/publication/v1/posts-catalog-commit" || path === "/publication/v1/posts-catalog-status" ||
  path === "/publication/v1/managed-request";

export interface ProtectedPostsBootSnapshot {
  selection: string;
  forward: string;
  reverse: string;
}
const retainedMountName = "web2-protected-posts-original";

type Graph = Omit<NativeGraph, "directoryRuntimeBinding">;
const beneath = (root: string, path: string) => {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith("../");
};

export function protectedPostsPaths(graph: Graph) {
  const selected = graph.protectedFirstSong;
  if (!selected) return;
  const { directory } = selected;
  const socket = join(dirname(directory), "activity-transport", "host.sock");
  assert(Object.keys(selected).sort().join(",") === "directory,schema,transportRef" &&
    selected.schema === "pirate.web2-protected-posts-transport/1" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(selected.transportRef) &&
    isAbsolute(directory) && normalize(directory) === directory &&
    directory === join(dirname(directory), "posts-transport") &&
    /^\/[a-zA-Z0-9_./-]{1,100}\.sock$/.test(socket) &&
    ![directory, dirname(socket)].some(path => beneath(graph.releaseRoot, path)) &&
    !graph.fixtureTransport && (!graph.localActivitySocket || graph.localActivitySocket === socket),
    "protected_posts_graph_selection_changed");
  const bindings = [...graph.applicationBindings, ...graph.secretBindings, ...graph.actors.flatMap(actor => actor.bindings)];
  assert(!bindings.some(binding => ["COMMUNITY_PUBLISHER_PRIVATE_KEY", "POSTS_CUSTODY_SELECTION_JSON",
    "POSTS_CUSTODY_HOST_AUTH"].includes(binding.name)) &&
    !graph.actors.some(actor => actor.service === "web2-local-activities"),
    "protected_posts_legacy_binding_refused");
  return {
    directory, socket, selection: join(directory, "selection.json"),
    forward: join(directory, "owner.auth"), reverse: join(directory, "primary.auth"),
  };
}

export function validateProtectedPostsTarget(graph: Graph, target: InstalledTarget) {
  const paths = protectedPostsPaths(graph);
  if (!paths) return;
  assert(paths.directory === join(target.stateRoot, "posts-transport"), "protected_posts_target_changed");
  const application = target.containers.filter(node => node.key === "application");
  assert(application.length === 1, "protected_posts_application_required");
  for (const directory of [paths.directory, dirname(paths.socket)]) {
    for (const container of target.containers) {
      const selected = container.mounts.filter(m => m.source === directory && m.target === directory && m.readOnly);
      assert(selected.length === (container === application[0] ? 1 : 0), "protected_posts_read_only_mount_required");
      for (const mount of container.mounts) {
        if (selected.includes(mount)) continue;
        assert(![mount.source, mount.target].some(path => beneath(path, directory) || beneath(directory, path)),
          "protected_posts_alternate_mount_refused");
      }
    }
  }
  const files = [...graph.secretBindings.map(binding => binding.path),
    ...[...graph.applicationBindings, ...graph.actors.flatMap(actor => actor.bindings)]
      .flatMap(binding => binding.file ? [binding.file] : [])];
  assert(files.every(file => !beneath(paths.directory, file)), "protected_posts_mount_alias_refused");
  return paths;
}

export async function readProtectedPostsMount(graph: NativeGraph, original: Web2NativeOriginal) {
  const paths = protectedPostsPaths(graph);
  assert(paths && graph.protectedFirstSong, "protected_posts_mount_unselected");
  await privateDirectory(paths.directory);
  const read = async (path: string, max: number) => {
    const file = await privateFile(path, max);
    try {
      const bytes = await file.readFile();
      assert(bytes.length <= max, "protected_posts_mount_file_size");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    finally { await file.close(); }
  };
  const { record, release, trust } = original, { draft, installationId: hostInstallationId } = record.body;
  assert(draft.configuration.configurationRevision === 1 && draft.configuration.chainId === 6343 &&
    hostInstallationId === graph.installationId && hostInstallationId === release.body.graph.installationId,
    "protected_posts_revision_one_original_required");
  const attachmentText = graph.applicationBindings.find(binding => binding.name === "WEB2_PUBLISHING_ATTACHMENT_JSON")?.text;
  assert(attachmentText, "protected_posts_attachment_required");
  const attachment = publishingAttachment(JSON.parse(attachmentText));
  assert(attachment.digest === record.body.publishingAttachmentDigest && attachment.digest === release.body.publishingAttachmentDigest,
    "protected_posts_attachment_changed");
  const expected: ProtectedPostsSelection = {
    schema: "pirate.web2-protected-posts-mount/1",
    transportRef: graph.protectedFirstSong.transportRef,
    hostInstallationId,
    installationId: draft.configuration.installationId,
    applicationOriginalSha256: `0x${nativeDigest(original)}`,
    releaseSha256: hashJson(release.body),
    configurationSha256: hashJson(draft.configuration),
    grantSha256: bytes32(attachment.selection.grant.sha256),
  };
  const [raw, forward, reverse] = await Promise.all([
    read(paths.selection, 16 * 1024), read(paths.forward, 64), read(paths.reverse, 64),
  ]);
  const selection: SignedRecord<ProtectedPostsSelection> = JSON.parse(raw);
  assert(Object.keys(selection).sort().join(",") === "body,keyId,schema,signature" &&
    canonical(verifyRecord(selection, trust)) === canonical(expected), "protected_posts_mount_original_changed");
  assert(/^[a-f0-9]{64}(?![\s\S])/.test(forward) && /^[a-f0-9]{64}(?![\s\S])/.test(reverse) &&
    forward !== reverse, "protected_posts_directional_roles_changed");
  return { selection, raw, forward, reverse };
}

type Mount = Awaited<ReturnType<typeof readProtectedPostsMount>>;
const mountFingerprint = (mount: Mount) => ({
  schema: "pirate.web2-protected-posts-original/1",
  selectionSha256: hash(mount.raw), forwardSha256: hash(mount.forward), reverseSha256: hash(mount.reverse),
});

export async function readRetainedProtectedPostsMount(graph: NativeGraph, original: Web2NativeOriginal): Promise<Mount> {
  const retained = await optionalWeb2Record(join(graph.stateRoots.configuration!, retainedMountName + ".json"));
  assert(retained, "protected_posts_retained_mount_missing");
  const mount = await readProtectedPostsMount(graph, original);
  assert(canonical(retained) === canonical(mountFingerprint(mount)), "protected_posts_retained_mount_changed");
  return mount;
}

/** The foreground launcher owns the listener; the backend owns the selected
 * provider and its Store. Keep a failed mount held until the listener drains. */
export function createProtectedPostsMountLifetime(owner: ProtectedFirstSongInstallationInputs, lease: OperationLease) {
  let acquired: ProtectedFirstSongRoute | undefined, ready = false;
  let identity: Hex | undefined, originalMount: Mount | undefined;
  return {
    async open(input: Parameters<ProtectedFirstSongInstallationInputs["open"]>[0]) {
      const { original, graph, assertCurrent, startRetained } = input;
      const paths = protectedPostsPaths(graph);
      const currentIdentity = hashJson({ original, graph });
      assert(paths && (!identity || identity === currentIdentity) &&
        original.record.body.installationId === lease.installationId, "protected_posts_mount_original_changed");
      await assertCurrent();
      await lease.assertHeld();
      ready = false;
      const directory = graph.stateRoots.configuration!;
      if (startRetained || await optionalWeb2Record(join(directory, retainedMountName + ".json"))) {
        const persisted = await readRetainedProtectedPostsMount(graph, original);
        assert(!originalMount || canonical(persisted) === canonical(originalMount), "protected_posts_retained_mount_changed");
        originalMount = persisted;
      }
      await assertCurrent();
      identity = currentIdentity;
      acquired ??= await owner.open({ ...input, original: structuredClone(original), graph: structuredClone(graph) });
      assert(acquired.lease === lease && acquired.socket === paths.socket,
        "protected_posts_listener_scope_changed");
      const mounted = await readProtectedPostsMount(graph, original);
      assert(!originalMount || canonical(mounted) === canonical(originalMount), "protected_posts_retained_mount_changed");
      await assertCurrent();
      await lease.assertHeld();
      await retainWeb2Record(directory, retainedMountName, mountFingerprint(mounted));
      await assertCurrent();
      assert(canonical(await readProtectedPostsMount(graph, original)) === canonical(mounted),
        "protected_posts_retained_mount_changed");
      await lease.assertHeld();
      originalMount = mounted;
      ready = true;
      return acquired;
    },
    route() { return ready ? acquired : undefined; },
    async close() {
      ready = false;
      await acquired?.close();
      acquired = undefined;
    },
  };
}
