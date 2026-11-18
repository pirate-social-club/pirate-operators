import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { privateFile, hash, type OperationLease } from "./backend-state.ts";
import { canonicalDigest } from "./installed-records.ts";
import { publicIngressFrom, type PublicIngress } from "./public-ingress.ts";
import { canonical, digest } from "../../packages/protocol/index.ts";
import type { Hex } from "viem";
import { consentDigest } from "../../packages/protocol/publication-consent.ts";
import { capturedFee, exact, parseCommand, preparedCall, record, same, signature } from "../../services/publication-command-contract.ts";
import { readPublicationJob, type PublicationCommandJob } from "../../services/publication-command-operator.ts";
import { PublicationReleaseCatalog, publicationSelectionHash, publicationSelectionSource, type PublicationAppRelease } from "../../services/publication-app-selection.ts";
import type { PublicationInstallationSpec } from "../../services/publication-installed-selection.ts";
import { publicationInstalledOperatorFetch } from "../../services/publication-installed-operator.ts";
import { PublicationOperatorTransport, type ManagedPublicationIssuer } from "../../services/publication-app-transport.ts";
import {
  checkedPublicationCapability, nativePublicationAuthorized, readPublicationNativeReference,
  publicationAcceptSessionHeader, publicationHostOrigin, publicationHostPath, publicationLookupPath, PUBLICATION_NATIVE_REPLY_LIMIT,
  type PublicationNativeReference,
} from "../../services/native-publication-reference.ts";
import type { Web2NativePublicationGraph } from "./web2-publication-selection.ts";
import {
  nativeDanceHostPath, nativeDanceReadyPath, nativeDanceRaw, nativeDanceReply,
  nativeDanceResponse, readNativeDanceReference,
} from "../../services/native-dance-retained-reference.ts";
import type { NativeDanceRetainedStore } from "./web2-native-dance-retained-store.ts";

type Operator = Parameters<typeof publicationInstalledOperatorFetch>[1];

export interface NativePublicationFirstGrant {
  commandId: Hex;
  nonce: Hex;
  sourceSha256: Hex;
  bodySha256: Hex;
  sessionHash: Hex;
}

export interface NativePublicationActivityRoute {
  readonly lease: OperationLease;
  readonly socket: string;
  readonly retainedSelectionSha256: Hex;
  readonly firstGrantSelected: boolean;
  readonly requestCapabilityFile: string;
  readonly lookupCapabilityFile: string;
  readonly ingressDigest: string;
  readonly transportRef: string;
  readonly issuerCapabilityRef: string;
  readonly issuerAddress: string;
  readonly operatorAddress: string;
  fetch(request: Request): Promise<Response>;
  assertAcceptedAppGrant(store: Operator["store"], job: Readonly<PublicationCommandJob>, sessionHash: Hex, signal: AbortSignal): Promise<void>;
}
const openedRoutes = new WeakSet<object>();
export function isNativePublicationActivityRoute(value: NativePublicationActivityRoute) {
  return openedRoutes.has(value);
}
async function capabilityFile(path: string) {
  const file = await privateFile(path, 64);
  const bytes = Buffer.alloc(64);
  try {
    const read = await file.read(bytes, 0, bytes.length, 0);
    assert(read.bytesRead === bytes.length && (await file.stat()).size === bytes.length, "native_publication_private_capability_changed");
    return checkedPublicationCapability(bytes.toString("ascii"));
  } finally { bytes.fill(0); await file.close(); }
}

/** Private activity listener supplies lifetime and bounded child custody.
 * The existing operator Store and issuer stay in the owning Node callback. */
export async function createNativePublicationActivityRoute(input: {
  lease: OperationLease;
  socket: string;
  ingress: PublicIngress;
  requestCapabilityFile: string;
  lookupCapabilityFile: string;
  selection: Pick<Web2NativePublicationGraph, "transportRef" | "issuerCapabilityRef" | "issuerAddress" | "operatorAddress">;
  /** Exact archive entries from the verified installed publication selection.
   * The owning backend reads and rechecks that selection under this lease. */
  retainedSelection: Pick<PublicationInstallationSpec, "entries" | "active">;
  /** Selected fixture owner reads its signed pin after ordinary prepare. */
  firstGrant?(signal: AbortSignal): Promise<Readonly<NativePublicationFirstGrant>>;
  operator: Omit<Operator, "catalog">;
  retainedDance?: NativeDanceRetainedStore;
  issuer: ManagedPublicationIssuer & { readonly capabilityRef: string };
  /** Must verify the real selected lifetime, retained journal and issuer binding. */
  assertCurrent(): Promise<void>;
}): Promise<NativePublicationActivityRoute> {
  const { lease, socket, issuer, requestCapabilityFile, lookupCapabilityFile, assertCurrent, retainedDance } = input;
  const selection = structuredClone(input.selection);
  const { entries, active } = structuredClone(input.retainedSelection);
  const catalog = new PublicationReleaseCatalog(entries.map(entry => entry.release), active);
  const originalTransports = new Map(entries.map(entry => {
    assert(/^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(entry.transportRef), "native_publication_transport_ref_invalid");
    return [publicationSelectionHash(entry.release), entry.transportRef];
  }));
  assert(originalTransports.size === entries.length, "native_publication_retained_source_ambiguous");
  function hasOriginalCustody(release: PublicationAppRelease) {
    return originalTransports.get(publicationSelectionHash(release)) === selection.transportRef &&
      release.issuer === selection.issuerAddress && release.operator === selection.operatorAddress;
  }
  if (active !== null) assert(hasOriginalCustody(catalog.get(active)), "native_publication_active_custody_changed");
  const readFirstGrant = input.firstGrant?.bind(input);
  if (readFirstGrant) assert(active !== null, "native_publication_first_grant_scope_changed");
  const authority = { ...input.operator, catalog };
  assert(authority.operatorAddress.toLowerCase() === selection.operatorAddress, "native_publication_operator_changed");
  const ingress = publicIngressFrom(input.ingress);
  const upstream = new URL(ingress.upstream);
  assert(upstream.protocol === "https:" && upstream.hostname === "127.0.0.1" && upstream.port,
    "native_publication_private_upstream_required");
  assert(lookupCapabilityFile !== requestCapabilityFile, "native_publication_directional_capabilities_required");
  const assertIssuer = () => assert(issuer.address.toLowerCase() === selection.issuerAddress &&
    issuer.capabilityRef === selection.issuerCapabilityRef, "native_publication_issuer_changed");
  assertIssuer();
  await lease.assertHeld();
  await assertCurrent();
  await lease.assertHeld();
  const requestAccess = await capabilityFile(requestCapabilityFile);
  const lookupAccess = await capabilityFile(lookupCapabilityFile);
  assert(requestAccess !== lookupAccess, "native_publication_directional_capabilities_required");
  const ca = await readFile(ingress.upstreamCaFile);
  assert(ca.length > 0 && ca.length <= 256 * 1024 && hash(ca) === ingress.upstreamCaSha256,
    "native_publication_upstream_ca_changed");

  async function current(signal: AbortSignal) {
    signal.throwIfAborted();
    await lease.assertHeld();
    await assertCurrent();
    const [requestNow, lookupNow] = await Promise.all([
      capabilityFile(requestCapabilityFile), capabilityFile(lookupCapabilityFile),
    ]);
    assert(requestNow === requestAccess && lookupNow === lookupAccess, "native_publication_role_capability_changed");
    await lease.assertHeld();
    assertIssuer();
    signal.throwIfAborted();
  }
  async function reverse(path: string, data: string, signal: AbortSignal, sessionHash?: Hex) {
    await current(signal);
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = httpsRequest({ method: "POST", hostname: "127.0.0.1", port: upstream.port,
        servername: ingress.upstreamServerName, path, ca, agent: false, signal,
        headers: { host: new URL(ingress.origin).host, authorization: "Bearer " + lookupAccess,
          ...(sessionHash ? { [publicationAcceptSessionHeader]: sessionHash } : {}),
          "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      }, reply => {
        if (reply.statusCode !== 200 || reply.headers["content-type"] !== "application/json") {
          reply.destroy(); reject(Error("native_publication_retained_lookup_unavailable")); return;
        }
        let size = 0;
        const parts: Buffer[] = [];
        reply.on("data", (part: Buffer) => {
          size += part.length;
          if (size > PUBLICATION_NATIVE_REPLY_LIMIT) {
            req.destroy(Error("native_publication_retained_lookup_overflow")); return;
          }
          parts.push(part);
        });
        reply.once("error", reject);
        reply.once("aborted", () => reject(Error("native_publication_retained_lookup_interrupted")));
        reply.once("end", () => resolve(Buffer.concat(parts)));
      });
      req.setTimeout(3000, () => req.destroy(Error("native_publication_retained_lookup_timeout")));
      req.once("error", reject);
      req.end(data);
    });
    await current(signal);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  async function retained(ref: PublicationNativeReference, signal: AbortSignal, sessionHash?: Hex): Promise<unknown> {
    const data = canonical(ref);
    const text = await reverse(publicationLookupPath, data, signal, sessionHash), result = record(JSON.parse(text));
    exact(result, ["reference", "body"]);
    assert(text === canonical(result) && canonical(result.reference) === data && digest(result.body) === ref.bodySha256,
      "native_publication_retained_body_changed");
    return result.body;
  }

  // The owner installs this callable in its existing composer. It invokes
  // only the private primary-D1 proof, with no envelope signature or dispatch.
  async function assertAcceptedAppGrant(store: Operator["store"], job: Readonly<PublicationCommandJob>, sessionHash: Hex, signal: AbortSignal) {
    assert(store === authority.store, "native_publication_operator_store_changed");
    const expected = structuredClone(job), command = parseCommand(expected.command);
    const sourceSha256 = digest(command.source);
    const release = catalog.forOperatorSource(sourceSha256);
    const body = { command, signature: signature(expected.signature), fee: capturedFee(expected.fee) };
    const call = preparedCall(command, body.signature);
    assert(expected.schema === "pirate.publication-queued/1" && expected.kind === "record_publication_grant" &&
      expected.ref === command.commandId && command.action === "grant" &&
      active === publicationSelectionHash(release) && hasOriginalCustody(release) &&
      same(command.source, publicationSelectionSource(release)) && same(body.fee, release.fee) &&
      expected.bodyHash === digest(body) && expected.data === call.data && command.digest === call.digest,
      "native_publication_accepted_job_changed");
    const ref: PublicationNativeReference = {
      schema: "pirate.native-publication-reference/1", path: "/publication/v1/accept",
      commandId: command.commandId, nonce: command.message.nonce, sourceSha256, bodySha256: expected.bodyHash,
    };
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    await current(lifetime);
    const before = readPublicationJob(authority.store, ref.commandId);
    assert(before && same(before, expected), "native_publication_accepted_job_changed");
    const accepted = await retained(ref, lifetime, consentDigest(sessionHash));
    const after = readPublicationJob(authority.store, ref.commandId);
    assert(after && same(after, expected) && same(accepted, body), "native_publication_accepted_job_changed");
    lifetime.throwIfAborted();
  }

  const opened = Object.freeze({ lease, socket, ...selection, ingressDigest: canonicalDigest(ingress),
    retainedSelectionSha256: digest({ entries, active }), firstGrantSelected: Boolean(readFirstGrant),
    requestCapabilityFile, lookupCapabilityFile, assertAcceptedAppGrant, async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.origin !== publicationHostOrigin || (url.pathname !== publicationHostPath && url.pathname !== nativeDanceHostPath) ||
        url.search || url.hash || request.method !== "POST" ||
        !await nativePublicationAuthorized(request, requestAccess))
      return new Response(null, { status: 404 });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(9000)]);
    try {
      if (url.pathname === nativeDanceHostPath) {
        assert(retainedDance && active, "native_dance_custody_unavailable");
        const ref = await readNativeDanceReference(request);
        const release = catalog.get(active);
        assert(hasOriginalCustody(release) && ref.releaseSha256 === active &&
          ref.installationId === release.source.installationId &&
          ref.original.communityId === release.source.communityId &&
          ref.original.publisher === release.operator, "native_dance_scope_changed");
        retainedDance.assertOwner(authority.store, ref);
        const ready = await reverse(nativeDanceReadyPath, canonical(ref), signal);
        const calldata = nativeDanceRaw(nativeDanceReply(ready, ref));
        const result = await retainedDance.read(authority.store, ref, calldata, signal);
        await current(signal);
        return nativeDanceResponse(ref, result);
      }
      const ref = await readPublicationNativeReference(request);
      const release = (() => {
        try { return catalog.forOperatorSource(ref.sourceSha256); }
        catch { return undefined; }
      })();
      if (!release || !hasOriginalCustody(release)) {
        await current(signal);
        // The original belongs to custody this host cannot service. Preserve it
        // for its original transport, signer and operator journal.
        return Response.json({ error: "native_publication_retained_authority_unavailable" }, {
          status: 503, headers: { "cache-control": "no-store" },
        });
      }
      const selectedGrant = ref.path === "/publication/v1/accept" ? readFirstGrant : undefined;
      let firstGrant: NativePublicationFirstGrant | undefined;
      if (selectedGrant) {
        await current(signal);
        firstGrant = structuredClone(await selectedGrant(signal));
        exact(record(firstGrant), ["commandId", "nonce", "sourceSha256", "bodySha256", "sessionHash"]);
        assert(active === publicationSelectionHash(release) &&
          ref.commandId === firstGrant.commandId && ref.nonce === firstGrant.nonce &&
          ref.sourceSha256 === firstGrant.sourceSha256 && ref.bodySha256 === firstGrant.bodySha256,
          "native_publication_first_grant_scope_changed");
        consentDigest(firstGrant.sessionHash);
      }
      async function lookup(lifetime: AbortSignal) {
        const body = await retained(ref, lifetime, firstGrant?.sessionHash);
        if (selectedGrant)
          assert(same(await selectedGrant(lifetime), firstGrant), "native_publication_first_grant_scope_changed");
        lifetime.throwIfAborted();
        return body;
      }
      const body = await lookup(signal);
      // Use the existing canonical envelope, real issuer and selected
      // operator handler. There is no endpoint accepting caller signing text.
      const transport = new PublicationOperatorTransport({
        async fetch(...args: Parameters<Fetcher["fetch"]>) {
          const forwarded = new Request(args[0], args[1]);
          const lifetime = AbortSignal.any([forwarded.signal, signal]);
          if (!selectedGrant) await lookup(lifetime);
          await current(lifetime);
          const result = await publicationInstalledOperatorFetch(new Request(forwarded, { signal: lifetime }), selectedGrant ? {
            ...authority,
            async assertAcceptCurrent(authenticatedBody) {
              assert(same(await lookup(lifetime), authenticatedBody), "native_publication_accepted_body_changed");
              await current(lifetime);
            },
          } : authority);
          assert(result, "native_publication_operator_route_unavailable");
          return result;
        },
      }, {
        get address() { return issuer.address; },
        async signMessage(value) {
          await lookup(signal);
          await current(signal);
          const signature = await issuer.signMessage(value);
          await current(signal);
          return signature;
        },
      }, authority.clock, 8500, 32768, { drainOnTimeout: true });
      const result = await transport.request(ref.path, { command_id: ref.commandId, nonce_hex: ref.nonce }, release, body);
      await current(signal);
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch { return new Response(null, { status: 503 }); }
  } });
  await lease.assertHeld();
  openedRoutes.add(opened);
  return opened;
}
