import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonical } from "../../packages/community/common.ts";
import { maxTrustedWeb2PublicationBytes, trustedWeb2PublicationFile, verifyTrustedWeb2Publication } from "../../packages/community/web2-trusted-publication.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { privateDirectory, privateFile } from "./backend-state.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { canonicalDigest } from "./installed-records.ts";
import { publicationMountFor } from "./web2-publication-selection.ts";
import { trustedRevisionTwo, type readApprovedTrustedRevisionTwo } from "./web2-trusted-revision-two.ts";

export async function readTrustedNativePublication(input: {
  graph: NativeGraph;
  original: Web2NativeOriginal;
  approval: Awaited<ReturnType<typeof readApprovedTrustedRevisionTwo>>;
}) {
  const { graph, original, approval } = input, transport = graph.nativePublication;
  if (!transport) return undefined;
  const directory = graph.stateRoots.configuration;
  assert(directory && graph.publicationExpansion === trustedRevisionTwo && !graph.fixtureTransport,
    "trusted_web2_publication_graph_changed");
  await privateDirectory(directory);
  const path = join(directory, trustedWeb2PublicationFile);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const file = await privateFile(path, maxTrustedWeb2PublicationBytes);
  let raw: string;
  try {
    const start = await file.stat({ bigint: true });
    assert(start.size > 0n && start.size <= BigInt(maxTrustedWeb2PublicationBytes),
      "trusted_web2_publication_attachment_size");
    const buffer = Buffer.alloc(Number(start.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const latest = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    assert(offset === Number(start.size) && latest.size === start.size && latest.mtimeNs === start.mtimeNs &&
      latest.ctimeNs === start.ctimeNs && named.dev === latest.dev && named.ino === latest.ino &&
      named.size === latest.size && named.mtimeNs === latest.mtimeNs && named.ctimeNs === latest.ctimeNs &&
      named.isFile() && named.nlink === 1n && named.uid === start.uid && !(named.mode & 0o077n),
      "trusted_web2_publication_attachment_changed_during_read");
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
  const result = await verifyTrustedWeb2Publication(raw, original, {
    graphSha256: canonicalDigest(graph), approvalSha256: approval.approvalSha256,
    registryRuntimeHash: approval.approval.registryRuntimeHash, configuration: approval.configuration,
    ownerWallet: approval.approval.ownerWallet, transport,
  });
  const { selection, selector } = result.initialization;
  assert(canonical(publicationMountFor(original, selection, transport)) === canonical(selector.body),
    "trusted_web2_publication_mount_changed");
  return { ...result, raw };
}
