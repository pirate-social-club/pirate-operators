import type { Hex } from "viem";
import { check, digest } from "../../packages/protocol/index.ts";
import { exact, generation, record } from "../../services/publication-command-contract.ts";
import {
  installPublicationSelection,
  type PublicationInstallationSpec,
  type PublicationMountIdentity,
} from "../../services/publication-installed-selection.ts";
import { parsePublicationRelease, publicationSelectionHash } from "../../services/publication-app-selection.ts";
import { nativeDigest, verifyNativeRecord } from "../../packages/community/native-business-binding.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import type { SignedRecord } from "./installed-records.ts";

/** Host policy selects a single transport. No selector or credential comes from a request. */
export interface Web2NativePublicationGraph {
  schema: "pirate.web2-native-publication-transport/1";
  directory: string;
  transportRef: string;
  issuerCapabilityRef: string;
  issuerAddress: Hex;
  operatorAddress: Hex;
}

export interface Web2NativePublicationMount {
  schema: "pirate.web2-native-publication-mount/1";
  nativeOriginalSha256: string;
  mount: PublicationMountIdentity;
  transportRef: string;
  issuerCapabilityRef: string;
  issuerAddress: Hex;
}

export interface Web2NativePublicationInitialization {
  schema: "pirate.web2-native-publication-initialization/1";
  selector: SignedRecord<Web2NativePublicationMount>;
  selection: PublicationInstallationSpec;
}

export const nativePublicationService = "web2-local-activities";
export const nativePublicationBindingNames = [
  "PUBLICATION_NATIVE_MOUNT_JSON",
  "PUBLICATION_OPERATOR_HOST",
  "PUBLICATION_OPERATOR_HOST_AUTH",
  "PUBLICATION_RETAINED_LOOKUP_AUTH",
  "WEB2_PUBLICATION_INITIALIZATION_JSON",
] as const;

export function nativePublicationPaths(directory: string) {
  return {
    request: directory + "/host-reference.auth",
    lookup: directory + "/retained-lookup.auth",
    selector: directory + "/publication-native-mount.json",
    initialization: directory + "/publication-initialization.json",
    intent: directory + "/publication-intent.json",
  };
}

export function publicationMountFor(
  original: Web2NativeOriginal,
  selection: PublicationInstallationSpec,
  transport: Pick<Web2NativePublicationGraph, "transportRef" | "issuerCapabilityRef" | "issuerAddress"> &
    Partial<Pick<Web2NativePublicationGraph, "operatorAddress">>,
): Web2NativePublicationMount {
  const draft = original.record.body.draft;
  const nativeOriginalSha256 = nativeDigest(original);
  const installedBindingSha256 = ("0x" + nativeOriginalSha256) as Hex;
  check(selection.schema === "pirate.publication-installation/1" &&
    selection.communityId === draft.enrollment.communityId &&
    selection.installationId === draft.enrollment.installationId &&
    selection.origin === draft.origin &&
    selection.installedBindingSha256 === installedBindingSha256 &&
    generation(selection.incarnation) > 0,
    "native_publication_original_scope_changed");
  const previous = selection.previous;
  check(previous === null ? selection.incarnation === "1" :
    previous.schema === "pirate.publication-mount/1" && previous.communityId === selection.communityId &&
    generation(previous.incarnation) + 1 === generation(selection.incarnation),
    "native_publication_predecessor_changed");
  check(/^[a-z][a-z0-9_-]{0,63}$/.test(transport.transportRef) &&
    /^[A-Za-z0-9_.:-]{1,256}$/.test(transport.issuerCapabilityRef) &&
    /^0x[a-f0-9]{40}$/.test(transport.issuerAddress),
    "native_publication_transport_scope_changed");
  check(Array.isArray(selection.entries) && selection.entries.length <= 128,
    "native_publication_retained_transport_unavailable");
  let activeMatched = selection.active === null;
  for (const entry of selection.entries) {
    const release = parsePublicationRelease(entry.release);
    check(release.source.communityId === selection.communityId &&
      /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(entry.transportRef),
      "native_publication_archive_scope_changed");
    if (publicationSelectionHash(release) !== selection.active) continue;
    check(!activeMatched && release.source.installationId === selection.installationId &&
      release.configuration.app.origin === selection.origin &&
      digest(release.profile) === digest(draft.deployment.directoryProfile) &&
      entry.transportRef === transport.transportRef && release.issuer === transport.issuerAddress &&
      (transport.operatorAddress === undefined || release.operator === transport.operatorAddress),
      "native_publication_active_custody_changed");
    activeMatched = true;
  }
  check(activeMatched, "native_publication_active_selection_missing");
  return {
    schema: "pirate.web2-native-publication-mount/1",
    nativeOriginalSha256,
    mount: {
      schema: "pirate.publication-mount/1",
      communityId: selection.communityId,
      installationId: selection.installationId,
      origin: selection.origin,
      incarnation: selection.incarnation,
      installedBindingSha256,
      selectionSha256: digest(selection),
    },
    transportRef: transport.transportRef,
    issuerCapabilityRef: transport.issuerCapabilityRef,
    issuerAddress: transport.issuerAddress,
  };
}

/** Called by the selected cold Workerd initializer, after the exact native original. */
export async function initializeNativePublication(
  db: D1Database,
  original: Web2NativeOriginal,
  initialization: Web2NativePublicationInitialization,
) {
  exact(record(initialization), ["schema", "selector", "selection"]);
  check(initialization.schema === "pirate.web2-native-publication-initialization/1",
    "native_publication_initialization_invalid");
  const selector = initialization.selector;
  await verifyNativeRecord(selector, original.trust);
  const expected = publicationMountFor(original, initialization.selection, selector.body);
  check(digest(expected) === digest(selector.body), "native_publication_selector_changed");
  const binding = await installPublicationSelection(db, initialization.selection);
  check(digest(binding.expected) === digest(expected.mount), "native_publication_d1_mount_changed");
  return expected.mount.selectionSha256;
}
