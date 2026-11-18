import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { zeroHash } from "viem";
import { canonical, exact, object } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import {
  maxWeb2DanceBindIntentBytes, maxWeb2DanceBindPrepareBytes, readWeb2DanceBindIntent, web2DancePrepareContentType,
} from "../../packages/community/web2-dance-bind-intent.ts";
import { danceAccountCommitment, danceCommand, danceSingletonId } from "../../packages/dance-chain/v2/wire.ts";
import { digest } from "../../packages/protocol/index.ts";
import { consentAddress, consentDigest, consentUint64 } from "../../packages/protocol/publication-consent.ts";
import type { DancePublicationSourceV2 } from "../../services/dance-publication-source.ts";
import { checkedPublicationCapability, publicationLookupPath } from "../../services/native-publication-reference.ts";
import type { InstalledDanceBindIntent, prepareInstalledDanceBindings } from "../../services/web2-installed-dance-bind-prepare.ts";
import { hash, privateDirectory, syncDirectory } from "./backend-state.ts";
import { publicIngressFrom, type PublicIngress } from "./public-ingress.ts";
import { nativePublicationPaths } from "./web2-publication-selection.ts";
import {
  readDanceActivationArtifact, readOptionalDanceActivationArtifact, retainDanceActivationArtifact,
  type Web2DanceActivationNomination,
} from "./web2-dance-retained-activation.ts";

export const web2DanceIntentFile = "web2-dance-bind-intent.json";
export const web2DancePrepareFile = "web2-dance-bind-prepare.json";

type Prepared = Awaited<ReturnType<typeof prepareInstalledDanceBindings>>;
export interface Web2DanceBindPrepareOwner {
  /** Resolve one exact independently signed intent for this installed original. */
  approvedIntent(input: Web2DanceActivationNomination): Promise<string | undefined>;
}

type PrepareSelection = {
  original: Web2NativeOriginal;
  source: DancePublicationSourceV2;
  approved: Pick<InstalledDanceBindIntent, "releaseSha256" | "configurationSha256" | "ownerWallet"> & {
    publisher: string;
    configurationRevision: number;
  };
};

function readPrepared(raw: string, intent: InstalledDanceBindIntent, selected: PrepareSelection) {
  assert(typeof raw === "string" && Buffer.byteLength(raw) <= maxWeb2DanceBindPrepareBytes, "web2_dance_bind_prepare_size");
  const record: Prepared = JSON.parse(raw);
  exact(object(record), ["schema", "intentSha256", "plans"]);
  assert(canonical(record) === raw && record.schema === "pirate.installed-dance-bind-prepare/1" &&
    record.intentSha256 === digest(intent) && Array.isArray(record.plans) && record.plans.length === 2,
    "web2_dance_bind_prepare_result_changed");

  for (const [position, entry] of record.plans.entries()) {
    exact(object(entry), ["purpose", "appGrantCommandId", "grantId", "grantReceiptSha256", "plan", "command"]);
    const grant = intent.grants[position]!, plan = entry.plan;
    exact(object(plan), ["accountId", "wallet", "publisher", "sourceHash", "ownerEpoch", "configurationRevision", "commandId"]);
    consentDigest(entry.grantId); consentDigest(entry.grantReceiptSha256);
    const wallet = consentAddress(plan.wallet), publisher = consentAddress(plan.publisher);
    const commandId = digest({ schema: "pirate.installed-dance-bind-command/1", intentSha256: record.intentSha256,
      position, appCommandId: grant.commandId, grantId: entry.grantId });
    assert(entry.purpose === grant.purpose && entry.appGrantCommandId === grant.commandId && plan.accountId === grant.accountId &&
      plan.sourceHash === intent.sourceHash && plan.ownerEpoch === intent.ownerEpoch && plan.commandId === commandId &&
      plan.publisher === selected.approved.publisher && plan.configurationRevision === String(selected.approved.configurationRevision),
      "web2_dance_bind_prepare_plan_changed");
    const domain = selected.source.domain, accountCommitment = danceAccountCommitment(domain, plan.accountId, wallet);
    const command = danceCommand(domain, "bindIdentity", publisher, commandId, {
      expectedOwnerEpoch: consentUint64(plan.ownerEpoch), expectedConfigurationRevision: consentUint64(plan.configurationRevision),
      accountCommitment, wallet, expectedIdentityEpoch: 0n, sourceGroupId: zeroHash, sourceBindingGroupEpoch: 0n,
      sourceCurrentGroupEpoch: 0n, destinationGroupId: danceSingletonId(domain, accountCommitment),
      destinationGroupEpoch: 0n, createSingleton: true, active: true,
    });
    assert(canonical(command) === canonical(entry.command), "web2_dance_bind_prepare_command_changed");
  }
  assert(record.plans[0].plan.wallet !== record.plans[1].plan.wallet &&
    record.plans[0].grantId !== record.plans[1].grantId && record.plans[0].grantReceiptSha256 !== record.plans[1].grantReceiptSha256,
    "web2_dance_bind_prepare_pair_changed");
  return record;
}

/** Exclusive original owner. A completed response is never reconstructed by
 * asking the chain to prepare empty slots again. */
export async function retainWeb2DanceBindPrepare(input: PrepareSelection & {
  directory: string;
  owner: Web2DanceBindPrepareOwner;
  prepare(raw: string): Promise<string>;
  assertCurrent(): Promise<void>;
}) {
  const { directory, original, approved, source, owner, assertCurrent, prepare } = input;
  const request = Object.freeze({ nativeOriginalSha256: nativeDigest(original), releaseSelectionHash: approved.releaseSha256 });
  const intentPath = join(directory, web2DanceIntentFile), preparePath = join(directory, web2DancePrepareFile);
  await privateDirectory(directory);
  await assertCurrent();
  const selected = await owner.approvedIntent(request);
  assert(typeof selected === "string", "web2_dance_bind_intent_required");
  const intent = await readWeb2DanceBindIntent(selected, original);
  assert(intent.releaseSha256 === approved.releaseSha256 && intent.configurationSha256 === approved.configurationSha256 &&
    intent.ownerWallet === approved.ownerWallet && intent.sourceHash === source.sourceHash,
    "web2_dance_bind_intent_selection_changed");
  const retainedIntent = await readOptionalDanceActivationArtifact(intentPath, maxWeb2DanceBindIntentBytes);
  const existing = await readOptionalDanceActivationArtifact(preparePath, maxWeb2DanceBindPrepareBytes);
  assert(retainedIntent === undefined ? existing === undefined : retainedIntent === selected,
    "web2_dance_bind_prepare_original_changed");
  async function current() {
    await assertCurrent();
    assert(await owner.approvedIntent(request) === selected, "web2_dance_bind_intent_changed");
    await assertCurrent();
  }

  await current();
  await retainDanceActivationArtifact(intentPath, selected, maxWeb2DanceBindIntentBytes);
  await syncDirectory(directory);
  await current();
  const latest = await readOptionalDanceActivationArtifact(preparePath, maxWeb2DanceBindPrepareBytes);
  assert(existing === undefined || existing === latest, "web2_dance_bind_prepare_original_changed");
  // A physical result, including a failed or partial write, always wins over
  // another attempt to prepare. Never reconstruct an already retained pair.
  const bytes = latest ?? await prepare(selected);
  const record = readPrepared(bytes, intent, input);
  assert(await readDanceActivationArtifact(intentPath, maxWeb2DanceBindIntentBytes) === selected,
    "web2_dance_bind_prepare_original_changed");
  await current();
  await retainDanceActivationArtifact(preparePath, bytes, maxWeb2DanceBindPrepareBytes);
  await syncDirectory(directory);
  assert(await readDanceActivationArtifact(preparePath, maxWeb2DanceBindPrepareBytes) === bytes,
    "web2_dance_bind_prepare_original_changed");
  await current();
  return { intentSha256: record.intentSha256, prepareSha256: hash(bytes), status: latest === undefined ? "prepared" : "retained" };
}

/** Fail before teardown can emit EOF for a truncated prefix. */
export function readWeb2DanceBindPrepareResponse(
  reply: Readable,
  cancel: (error: Error) => void,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, overflowed = false;
    reply.once("error", reject);
    reply.once("aborted", () => reject(new Error("web2_dance_bind_prepare_interrupted")));
    reply.once("end", () => {
      if (!overflowed) resolve(Buffer.concat(chunks, size));
    });
    reply.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      if (size + chunk.length > maxWeb2DanceBindPrepareBytes) {
        overflowed = true;
        const error = new Error("web2_dance_bind_prepare_size");
        reject(error);
        reply.destroy();
        cancel(error);
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
    });
  });
}

/** Prepare has no way to reach the operator dispatch or issuer. The existing
 * reverse capability and signed loopback upstream are the only transport. */
export async function requestWeb2DanceBindPrepare(input: {
  ingress: PublicIngress;
  transportDirectory: string;
  raw: string;
  assertCurrent(): Promise<void>;
}) {
  const ingress = publicIngressFrom(input.ingress), upstream = new URL(ingress.upstream);
  const paths = nativePublicationPaths(input.transportDirectory);
  const capabilities = async () => Promise.all([paths.request, paths.lookup].map(async path =>
    checkedPublicationCapability(await readDanceActivationArtifact(path, 64))));
  const [forward, reverse] = await capabilities();
  assert(forward && reverse && forward !== reverse, "native_publication_directional_capabilities_required");
  const ca = await readFile(ingress.upstreamCaFile);
  assert(ca.length > 0 && ca.length <= 256 * 1024 && hash(ca) === ingress.upstreamCaSha256,
    "native_publication_upstream_ca_changed");
  await input.assertCurrent();

  const signal = AbortSignal.timeout(30_000);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const req = request({
      method: "POST", hostname: "127.0.0.1", port: upstream.port, servername: ingress.upstreamServerName,
      path: publicationLookupPath, ca, rejectUnauthorized: true, agent: false, signal,
      headers: { host: new URL(ingress.origin).host, authorization: "Bearer " + reverse,
        "content-type": web2DancePrepareContentType, "content-length": Buffer.byteLength(input.raw) },
    }, reply => {
      if (reply.statusCode !== 200 || reply.headers["content-type"] !== "application/json") {
        reply.destroy();
        reject(new Error("web2_dance_bind_prepare_unavailable"));
        return;
      }
      void readWeb2DanceBindPrepareResponse(reply, error => req.destroy(error)).then(resolve, reject);
    });
    req.once("error", reject);
    req.end(input.raw);
  });
  assert.deepEqual(await capabilities(), [forward, reverse], "native_publication_role_capability_changed");
  signal.throwIfAborted();
  await input.assertCurrent();
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
