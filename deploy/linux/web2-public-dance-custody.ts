import assert from "node:assert/strict";
import { isAbsolute, join, normalize } from "node:path";
import type { Hex } from "viem";
import { canonical, exact, object } from "../../packages/community/common.ts";
import { nativeDigest, verifyNativeRecord } from "../../packages/community/native-business-binding.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { consentDigest } from "../../packages/protocol/publication-consent.ts";
import type { NativeDanceRetainedScope } from "../../services/native-dance-retained-reference.ts";
import { hash, type OperationLease } from "./backend-state.ts";
import type { SignedRecord } from "./installed-records.ts";
import { readDanceActivationArtifact, readOptionalDanceActivationArtifact } from "./web2-dance-retained-artifacts.ts";

import {
  assertPinnedNativeDanceRetainedCustody, type NativeDanceRetainedStore,
} from "./web2-native-dance-retained-store.ts";

export const web2PublicDanceCustodyFile = "web2-public-dance-custody.json";
export const web2PublicDanceStagedCustodyFile = "web2-public-dance-staged-custody.json";
export const maxWeb2PublicDanceCustodyBytes = 16 * 1024;

type PhysicalPath = { path: string; device: string; inode: string };
export interface Web2PublicDancePhysicalCustody {
  store: PhysicalPath & { journalId: Hex };
  composer: PhysicalPath & { runId: string; genesisHash: Hex; intentSha256: string };
}
type CustodySubject = {
  nativeOriginalSha256: string;
  hostInstallationId: string;
  approvalSha256: string;
  selectionSha256: Hex;
  rewardSha256: string;
  scopeSha256: string;
  prepareIntentSha256: string;
  prepareResultSha256: string;
  scope: NativeDanceRetainedScope;
};
export type Web2PublicDanceCustody = CustodySubject & Web2PublicDancePhysicalCustody & {
  schema: "pirate.public-web2-dance-custody/1";
};
export type Web2PublicDanceServeCustody = Readonly<{ record: Web2PublicDanceCustody; recordSha256: string }>;

function physical(value: PhysicalPath) {
  return typeof value.path === "string" && value.path.length <= 4096 && !value.path.includes("\0") &&
    isAbsolute(value.path) && normalize(value.path) === value.path &&
    typeof value.device === "string" && /^(?:0|[1-9][0-9]{0,20})(?![\s\S])/.test(value.device) &&
    typeof value.inode === "string" && /^[1-9][0-9]{0,20}(?![\s\S])/.test(value.inode);
}

/** Independently approved public physical identity. Stage pins the exact
 * signed bytes before retaining scope. Scoped reopen requires that same pin.
 * The host Store reader independently verifies the physical paths. */
export async function readPublicDanceCustody(input: {
  directory: string;
  original: Web2NativeOriginal;
  expected: Omit<CustodySubject, "nativeOriginalSha256" | "hostInstallationId">;
  genesisHash: Hex;
  requireStaged: boolean;
}) {
  const { original, expected, directory } = input;
  const selectedPath = join(directory, web2PublicDanceCustodyFile);
  const stagedPath = join(directory, web2PublicDanceStagedCustodyFile);
  const read = () => Promise.all([
    readOptionalDanceActivationArtifact(selectedPath, maxWeb2PublicDanceCustodyBytes),
    readOptionalDanceActivationArtifact(stagedPath, maxWeb2PublicDanceCustodyBytes),
  ]);
  const [raw, staged] = await read();
  assert(raw !== undefined, "web2_public_dance_custody_required");
  assert(staged === undefined ? !input.requireStaged : staged === raw, "web2_public_dance_staged_custody_changed");
  const signed: SignedRecord<Web2PublicDanceCustody> = JSON.parse(raw);
  assert(canonical(signed) === raw, "web2_public_dance_custody_not_canonical");
  await verifyNativeRecord(signed, original.trust);
  const { schema, store, composer, ...subject } = signed.body;
  exact(object(store), ["path", "device", "inode", "journalId"]);
  exact(object(composer), ["path", "device", "inode", "runId", "genesisHash", "intentSha256"]);
  assert(schema === "pirate.public-web2-dance-custody/1" && canonical(subject) === canonical({
    ...expected, nativeOriginalSha256: nativeDigest(original), hostInstallationId: original.record.body.installationId,
  }) && physical(store) && physical(composer) && composer.path !== store.path &&
    typeof composer.runId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}(?![\s\S])/.test(composer.runId) &&
    consentDigest(composer.genesisHash) === input.genesisHash &&
    typeof composer.intentSha256 === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(composer.intentSha256),
    "web2_public_dance_custody_changed");
  consentDigest(store.journalId);
  const assertCurrent = async (requireStaged = input.requireStaged) => {
    const [current, retained] = await read();
    assert(current === raw && (retained === undefined ? !requireStaged && staged === undefined : retained === raw),
      "web2_public_dance_staged_custody_changed");
  };
  await assertCurrent();
  return { raw, stagedPath, record: signed.body, recordSha256: hash(raw), assertCurrent };
}


/** Use the one admitted physical-identity guard on both host paths. The
 * composer artifact is a separate exact byte pin in the same signed record. */
export async function assertPublicDancePublisher(
  retained: NativeDanceRetainedStore, operatorStore: object, signed: Readonly<Web2PublicDanceCustody>,
  lease: OperationLease,
) {
  const { composer, store, scope } = signed;
  const checkPhysical = () => assertPinnedNativeDanceRetainedCustody(retained, operatorStore, scope, {
    storeIdentity: store, journalDirectory: composer.path,
    directoryIdentity: { device: composer.device, inode: composer.inode },
    runId: composer.runId, genesisHash: composer.genesisHash,
  }, lease);
  await checkPhysical();
  const path = join(composer.path, "selection-intent.json");
  const raw = await readDanceActivationArtifact(path, 65_536);
  const intent = object(JSON.parse(raw));
  assert(hash(raw) === composer.intentSha256 && intent.runId === composer.runId &&
    intent.genesisHash === composer.genesisHash && intent.nativeOriginalSha256 === signed.nativeOriginalSha256 &&
    intent.publisher === scope.publisher && intent.localOnly === false,
    "native_dance_composer_custody_changed");
  await checkPhysical();
  assert(await readDanceActivationArtifact(path, 65_536) === raw, "native_dance_composer_custody_changed");
}
