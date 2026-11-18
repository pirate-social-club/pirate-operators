import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import type { PublicClient } from "viem";
import { canonical, exact, hashJson, hashText, object } from "../../packages/community/common.ts";
import type { CommunityConfig } from "../../packages/community/config-manifest.ts";
import {
  nativePostsCustodyPath, nativePostsObservation, nativePostsOriginal, nativePostsOriginalLimit,
  nativePostsReplyLimit, nativePostsSelectionHash, parseNativePostsCustodySelection,
  type NativePostsAction, type NativePostsAnchor, type NativePostsPublisherLease,
  type NativePostsPublisherSelection,
} from "../../packages/community/native-posts-custody.ts";
import { observePublication, type PostsProfile } from "../../packages/community/post-chain.ts";
import { hash, privateFile, type OperationLease } from "./backend-state.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { publicIngressFrom, type PublicIngress } from "./public-ingress.ts";
import { readNativePostsRole } from "./web2-native-posts-role.ts";
import { nativePublicationPaths } from "./web2-publication-selection.ts";

type Graph = Pick<NativeGraph, "installationId" | "applicationBindings" | "secretBindings" | "fixtureTransport" | "allowedOrigins" | "nativePublication">;

export interface NativePostsCustodyInputs {
  lease: OperationLease;
  ingress: PublicIngress;
  /** The actual verified graph from the existing owned launch. */
  graph: Graph;
  capabilityFile: string;
  client: PublicClient;
  posts: PostsProfile;
  signal: AbortSignal;
  configurationHistory(): Promise<readonly CommunityConfig[]>;
  /** Same existing signed graph, native app original, and exclusive selected
   * disposable RPC lifetime, including the fixture egress driver's upstream. */
  assertCurrent(): Promise<void>;
}

/** No listener or sender. The actual Node operator uses this with its existing
 * result store, held process lease, payer owner and canonical read client. */
export async function createNativePostsCustody(input: NativePostsCustodyInputs) {
  const { lease, client, posts, capabilityFile, signal } = input;
  const assertCurrent = input.assertCurrent.bind(input);
  const configurationHistory = input.configurationHistory.bind(input);
  const ingress = publicIngressFrom(input.ingress);
  const upstream = new URL(ingress.upstream);
  const selection = input.graph.applicationBindings.filter(binding => binding.name === "POSTS_CUSTODY_SELECTION_JSON");
  const secrets = input.graph.secretBindings.filter(binding => binding.name === "POSTS_CUSTODY_HOST_AUTH");
  const selectionFile = selection[0]?.file;
  assert(selection.length === 1 && selectionFile && selection[0]!.text === undefined &&
    selection[0]!.service === undefined && selection[0]!.durable === undefined &&
    selectionFile !== capabilityFile &&
    input.graph.applicationBindings.filter(binding => binding.file === selectionFile).length === 1 &&
    secrets.length === 1 && secrets[0]!.path === capabilityFile &&
    input.graph.secretBindings.filter(binding => binding.path === capabilityFile).length === 1 &&
    !input.graph.secretBindings.some(binding => binding.path === selectionFile) &&
    !input.graph.applicationBindings.some(binding => binding.name === "POSTS_CUSTODY_HOST_AUTH"),
    "native_posts_host_graph_binding_required");
  async function readSelection() {
    const file = await privateFile(selectionFile!, 4096);
    try {
      const stat = await file.stat({ bigint: true });
      assert(stat.size > 0n && stat.size <= 4096n, "native_posts_selection_file_changed");
      const data = Buffer.alloc(Number(stat.size));
      const { bytesRead } = await file.read(data, 0, data.length, 0);
      const after = await file.stat({ bigint: true });
      assert(bytesRead === data.length && after.size === stat.size &&
        after.mtimeNs === stat.mtimeNs && after.ctimeNs === stat.ctimeNs, "native_posts_selection_file_changed");
      return { device: stat.dev, inode: stat.ino, raw: new TextDecoder("utf-8", { fatal: true }).decode(data) };
    } finally { await file.close(); }
  }
  await lease.assertHeld();
  await assertCurrent();
  const originalSelection = await readSelection();
  const selected = parseNativePostsCustodySelection(originalSelection.raw);
  const { scope } = selected;
  const fixture = input.graph.fixtureTransport;
  const rpcOrigin = new URL(scope.native.applicationRpcUrl).origin;
  assert(
    lease.installationId === selected.hostInstallationId &&
      input.graph.installationId === selected.hostInstallationId &&
      ingress.tls.kind === "local-fixture-ca" &&
      ingress.origin === scope.origin && upstream.protocol === "https:" &&
      upstream.hostname === "127.0.0.1" && upstream.port &&
      fixture?.schema === "pirate.linux-local-fixture-transport/1" &&
      hashJson(fixture) === scope.native.fixtureTransportSha256 &&
      fixture.routes.filter(route => route.origin === rpcOrigin).length === 1 &&
      input.graph.allowedOrigins.includes(rpcOrigin) && client.transport.url === scope.rpcUrl,
    "native_posts_fixture_authority_unavailable",
  );
  const selectionHash = nativePostsSelectionHash(selected);
  const publisher: NativePostsPublisherSelection = {
    chainId: 6343, genesisHash: scope.genesisHash, rpcUrl: scope.rpcUrl,
    publisher: scope.publisher, communityId: scope.communityId, installationId: scope.installationId,
    releaseSelectionSha256: selected.releaseSelectionSha256,
  };
  await lease.assertHeld();
  await assertCurrent();
  const publication = input.graph.nativePublication;
  const publicationRoles = publication ? nativePublicationPaths(publication.directory) : undefined;
  const role = await readNativePostsRole(capabilityFile, publicationRoles);
  async function readAndCheckRoles() {
    assert(await readNativePostsRole(capabilityFile, publicationRoles) === role,
      "native_posts_host_capability_changed");
  }
  const ca = await readFile(ingress.upstreamCaFile);
  assert(ca.length > 0 && ca.length <= 256 * 1024 && hash(ca) === ingress.upstreamCaSha256,
    "native_posts_upstream_ca_changed");

  async function current(lifetime: AbortSignal) {
    lifetime.throwIfAborted();
    await lease.assertHeld();
    await assertCurrent();
    const [observedSelection] = await Promise.all([readSelection(), readAndCheckRoles()]);
    assert(observedSelection.device === originalSelection.device &&
      observedSelection.inode === originalSelection.inode &&
      observedSelection.raw === originalSelection.raw, "native_posts_selection_file_changed");
    await lease.assertHeld();
    lifetime.throwIfAborted();
  }

  async function chain(lifetime: AbortSignal, anchor?: NativePostsAnchor) {
    await current(lifetime);
    const [id, genesis, safe] = await Promise.all([
      client.getChainId(), client.getBlock({ blockNumber: 0n }), client.getBlock({ blockTag: "safe" }),
    ]);
    assert(id === scope.chainId && genesis.hash === scope.genesisHash && safe.hash && safe.number !== null,
      "native_posts_read_chain_changed");
    if (anchor) {
      const block = await client.getBlock({ blockNumber: BigInt(anchor.number) });
      assert(BigInt(anchor.number) <= safe.number && block.hash === anchor.hash, "native_posts_safe_anchor_changed");
    }
    await current(lifetime);
    return { number: String(safe.number), hash: safe.hash };
  }

  async function read(holder: string, action: NativePostsAction, lifetime: AbortSignal) {
    const call = AbortSignal.any([lifetime, AbortSignal.timeout(8000)]);
    await current(call);
    const body = canonical({ schema: "pirate.native-posts-custody/1", selection: selectionHash, holder, ...action });
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = httpsRequest({
        method: "POST", hostname: "127.0.0.1", port: upstream.port, path: nativePostsCustodyPath,
        servername: ingress.upstreamServerName, ca, agent: false, signal: call,
        headers: { host: new URL(ingress.origin).host, authorization: "Bearer " + role,
          "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, response => {
        if (response.statusCode !== 200 || response.headers["content-type"] !== "application/json") {
          response.destroy();
          reject(Error("native_posts_custody_unavailable"));
          return;
        }
        let size = 0;
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => {
          size += part.length;
          if (size > nativePostsReplyLimit) req.destroy(Error("native_posts_reply_limit"));
          else parts.push(part);
        });
        response.once("error", reject);
        response.once("aborted", () => reject(Error("native_posts_reply_interrupted")));
        response.once("end", () => resolve(Buffer.concat(parts)));
      });
      req.once("error", reject);
      req.end(body);
    });
    await current(call);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = object(JSON.parse(raw));
    exact(value, ["request", "result"]);
    assert(raw === canonical(value) && canonical(value.request) === body, "native_posts_reply_changed");
    return object(value.result);
  }

  async function phase(holder: string, action: NativePostsAction, allowed: string, lifetime: AbortSignal) {
    const value = await read(holder, action, lifetime);
    exact(value, ["state"]);
    assert(value.state === allowed, "native_posts_custody_phase_changed");
  }

  let acquiring = false;
  await chain(signal);
  return Object.freeze({
    async acquire(requested: Readonly<NativePostsPublisherSelection>): Promise<NativePostsPublisherLease> {
      assert(!acquiring && canonical(requested) === canonical(publisher), "native_posts_publisher_selection_changed");
      acquiring = true;
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
      const holder = randomBytes(32).toString("hex");
      let attempted = false;
      async function reconcile() {
        // Cancellation of the acquisition is not a release. This narrow
        // attempt may only convert our exact existing holder to reconciliation.
        await phase(holder, { action: "reconcile" }, "reconcile", AbortSignal.timeout(10000));
      }
      try {
        await chain(lifetime);
        attempted = true;
        await phase(holder, { action: "pause" }, "draining", lifetime);
        let inventory = await read(holder, { action: "inventory" }, lifetime);
        while (inventory.state === "draining") {
          exact(inventory, ["state"]);
          await delay(250, undefined, { signal: lifetime });
          inventory = await read(holder, { action: "inventory" }, lifetime);
        }
        exact(inventory, ["state", "snapshot", "originals"]);
        assert(inventory.state === "ready" && Array.isArray(inventory.originals) &&
          inventory.originals.length <= nativePostsOriginalLimit, "native_posts_journal_unavailable");
        const anchor = await chain(lifetime);
        const proof = nativePostsObservation({ snapshot: inventory.snapshot, anchor });
        const history = await configurationHistory();
        assert(history.length > 0 && history.length <= 512, "native_posts_history_limit");
        for (const value of inventory.originals) {
          lifetime.throwIfAborted();
          const original = nativePostsOriginal(value);
          const publication = original.publication;
          const configuration = history.find(row => row.configurationRevision === publication.configurationRevision);
          assert(configuration?.schema === "pirate.community-config/4" &&
            configuration.chainId === scope.chainId && configuration.installationId === scope.installationId &&
            configuration.communityId === scope.communityId && publication.communityId === scope.communityId &&
            configuration.app.origin === scope.origin && configuration.publisher === scope.publisher &&
            configuration.postsContract === posts.address, "native_posts_historical_configuration_changed");
          const verified = await observePublication(client, posts, configuration, original.hash, scope.publisher, publication);
          assert(verified && BigInt(verified.blockNumber) <= BigInt(anchor.number) &&
            hashText(canonical(verified)) === original.resultSha256, "native_posts_original_unsettled");
        }
        await chain(lifetime, anchor);
        await phase(holder, { action: "hold", proof }, "held", lifetime);
        await chain(lifetime, anchor);
        let open = true;
        async function verify() {
          assert(open, "native_posts_lease_closed");
          await chain(signal, anchor);
          await phase(holder, { action: "verify", proof }, "held", signal);
          await chain(signal, anchor);
          assert(open, "native_posts_lease_closed");
        }
        return Object.freeze({
          assertHeldAndPostsQuiescent: verify,
          async release(outcome: "clear" | "reconcile") {
            assert(open, "native_posts_lease_closed");
            if (outcome === "reconcile") {
              open = false;
              await reconcile();
              return;
            }
            try {
              await verify();
              open = false;
              await phase(holder, { action: "clear", proof }, "posts", signal);
              acquiring = false;
            } catch (error) {
              open = false;
              try { await reconcile(); }
              catch (hold) { throw new AggregateError([error, hold], "native_posts_release_uncertain"); }
              throw error;
            }
          },
        });
      } catch (error) {
        if (attempted) {
          try { await reconcile(); }
          catch (hold) { throw new AggregateError([error, hold], "native_posts_acquire_uncertain"); }
        }
        throw error;
      }
    },
  });
}
