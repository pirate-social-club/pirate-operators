import { createWeb2Journal, web2Wire } from "../../apps/community-wizard/server/web2-journal.ts";
import { prepareWeb2WizardRegistration } from "../../apps/community-wizard/server/web2-publishing-setup.ts";
import { createHostedEnrollmentClient } from "../../packages/community-setup/hosted-enrollment-client.ts";
import { parseEnrollment, planDocument } from "../../packages/community/hosted-enrollment.ts";
import { operatorSigningFixture } from "./linux-web2-installation.ts";
import { CommunityError } from "../../packages/community/common.ts";
import { communityIpfsTransport } from "../../services/community-deployment-profile.ts";
// Actual Wizard HTTP + hosted handlers + D1 + existing real 6343 V3/Posts chain.
// Only immutable content transport and the external wallet transport are fixtures.
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  canonical,
  hashJson,
  hashText,
  publicId,
  token,
} from "../../packages/community/common.ts";
import {
  provisionHostedInvite,
  allOperations,
} from "../../packages/community/hosted-enrollment-store.ts";
import {
  enrollmentTypedData,
  policyDocument,
  type HostedPolicy,
} from "../../packages/community/hosted-enrollment.ts";
import type { HostedRuntime } from "../../packages/community/hosted-topup-chain.ts";
import { createHostedEnrollmentService } from "../../services/hosted-community-enrollment.ts";
import { createHostedFundingService } from "../../services/hosted-community-funding.ts";
import {
  web2SongChain,
  web2Controller,
  web2Owner,
  web2Other,
  web2Publisher,
} from "./web2-first-song-chain.ts";
import {
  createWeb2Setup,
  type Web2ActionView,
  type Web2WizardView,
} from "../../apps/community-wizard/server/web2-setup.ts";
import { createWeb2DnsSetup } from "../../apps/community-wizard/server/web2-dns-setup.ts";
import { createWizardServer } from "../../apps/community-wizard/server/http.ts";
import { LinuxInputError } from "../../packages/community-setup/shared-linux-profile.ts";
import {
  createCommunityMediaStorage,
  type CommunityMediaStorage,
} from "../../deploy/linux/community-media-storage.ts";
import {
  startManagedKeyAgent,
  createManagedKeyClient,
} from "../../deploy/linux/managed-key-channel.ts";
import {
  processIdentity,
  acquireOperation,
} from "../../deploy/linux/backend-state.ts";
import { generateKeyPairSync, randomBytes } from "node:crypto";

export async function hostedWizardFixture(
  options: {
    contractController?: boolean;
    sameRecipient?: boolean;
    invalidDeployment?: boolean;
    publishing?: boolean;
    grantWindowSeconds?:number;
    signingOrigin?:string;
    observeInstallationAttempts?:boolean;
    missingCustody?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pw2-wizard-"));
  const publicRecognition = {
    schema: "pirate.recognition-profile/1" as const,
    namespace: hashText("Wizard fixture recognition"),
    origin: "https://recognition.example",
    signer: web2Other.address.toLowerCase(),
    providerBindingSha256: hashText("explicit content fixture"),
  };
  const chain = await web2SongChain({
    ...publicRecognition,
    sha256: hashJson(publicRecognition),
  });
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('unused')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  let server: ReturnType<typeof createWizardServer> | undefined;
  let setup: Awaited<ReturnType<typeof createWeb2Setup>> | undefined;
  let origin = "",
    csrf = "",
    dropRedeem = false,
    dropPrepare = false,
    changePrepare = false;
  const origins: string[] = [];
  let nextStatusGate: { enter: () => void; wait: Promise<void> } | undefined;
  const statusReleases = new Set<() => void>();
  const nativeDirectory = resolve(".local/web2-owner-signing-implementation/completion/hosted-wizard/native");
  const nativePath = join(
    nativeDirectory,
    `fixture-${process.pid}-${publicId().slice(2, 18)}.json`,
  );
  let nativeFields: string[] = [];
  async function recordNative(state: string) {
    await writeFile(
      nativePath,
      JSON.stringify(
        {
          pid: process.pid,
          start: nativeFields[19],
          group: nativeFields[2],
          session: nativeFields[3],
          state,
          at: new Date().toISOString(),
          ports: [
            Number(new URL(chain.client.chain.rpcUrls.default.http[0]!).port),
            Number(new URL(chain.deployment.rpcUrl).port),
            ...origins.map((o) => Number(new URL(o).port)),
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  try {
    await mkdir(nativeDirectory, { recursive: true });
    const nativeStat = await readFile("/proc/self/stat", "utf8");
    nativeFields = nativeStat.slice(nativeStat.lastIndexOf(")") + 2).split(" ");
    const db = await mf.getD1Database("DB"),
      sql = await readFile(
        "packages/community/schema/hosted-enrollment.sql",
        "utf8",
      );
    await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    const {
      communityKey: _key,
      communityId: _id,
      installationId: _installation,
      ...deployment
    } = chain.profile;
    const notice =
      "Disposable local pilot: no backup or public availability guarantee.";
    const policy: HostedPolicy = {
      schema: "pirate.hosted-enrollment-policy/1",
      pilotId: "wizard-fixture",
      serviceOrigin: "https://hosted.example",
      deployment,
      registrar: web2Controller.address.toLowerCase() as Address,
      funder: web2Other.address.toLowerCase() as Address,
      registrarRevision: "1",
      noticeSha256: hashText(notice),
      inviteMaxSeconds: 3600,
      challengeSeconds: 1800,
      maxSafeBlockAgeSeconds: 600,
      broadcastRetrySeconds: 10,
      maxBroadcastAttempts: 3,
      registrationGas: "3000000",
      topupGas: "50000",
      maxFeePerGas: "1000000",
      maxPriorityFeePerGas: "1",
      extraFeeCeiling: "0",
      extraFeeField: "none",
      globalCeiling: "1000000000000000000",
      communityCeiling: "100000000000000000",
      recipientCeiling: "100000000000000000",
      controllerInitialWei: options.contractController
        ? "0"
        : "1000000000000000",
      publisherInitialWei: options.contractController
        ? "0"
        : "2000000000000000",
    };
    const client = createPublicClient({
      chain: chain.client.chain,
      transport: http(chain.deployment.rpcUrl, { retryCount: 0 }),
      cacheTime: 0,
      pollingInterval: 20,
    });
    const runtime: HostedRuntime = {
      db,
      policy,
      client,
      now: () => Math.floor(Date.now() / 1000),
      registrar: {
        address: policy.registrar,
        signTransaction: (tx) => web2Controller.signTransaction(tx),
      },
      funder: {
        address: policy.funder,
        signTransaction: (tx) => web2Other.signTransaction(tx),
      },
      readConfiguration: (uri) =>
        fetch(chain.deployment.ipfsGateways[0] + "/ipfs/" + uri.slice(7)),
    };
    const enrollment = createHostedEnrollmentService(runtime),
      funding = createHostedFundingService(runtime);
    let controller = web2Owner.address.toLowerCase() as Address;
    if (options.contractController) {
      const a = JSON.parse(
        await readFile("out/MockAccount.sol/MockAccount.json", "utf8"),
      ) as { abi: Abi; bytecode: { object: Hex } };
      const wallet = createWalletClient({
        account: web2Owner,
        chain: chain.client.chain,
        transport: http(chain.deployment.rpcUrl),
      });
      const hash = await wallet.deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        gasPrice: 1000000n,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert(receipt.contractAddress);
      controller = receipt.contractAddress.toLowerCase() as Address;
      const init = await wallet.writeContract({
        address: controller,
        abi: a.abi,
        functionName: "initialize",
        args: [web2Owner.address],
        gasPrice: 1000000n,
      });
      await client.waitForTransactionReceipt({ hash: init });
      await chain.rpc("anvil_mine", ["0x40", "0x0"]);
    }
    const inviteToken = token();
    await provisionHostedInvite(
      db,
      policy,
      {
        id: publicId(),
        token: inviteToken,
        allowanceId: publicId(),
        expiresAt: runtime.now() + 3500,
      },
      runtime.now(),
    );
    const before = chain.effects.broadcasts;
    const transport: typeof fetch = async (url, init) => {
      const request = new Request(url, init);
      if (request.url.endsWith("/status") && nextStatusGate) {
        const gate = nextStatusGate;
        nextStatusGate = undefined;
        gate.enter();
        await gate.wait;
      }
      const response = await (
        new URL(request.url).pathname === "/initial-topup"
          ? funding
          : enrollment
      )(request);
      if (request.url.endsWith("/redeem") && dropRedeem) {
        dropRedeem = false;
        throw Error("real handler completed; acknowledgement lost");
      }
      if (request.url.endsWith("/prepare") && dropPrepare) {
        dropPrepare = false;
        throw Error("real preparation saved; acknowledgement lost");
      }
      if (request.url.endsWith("/prepare") && response.ok && changePrepare) {
        const body = (await response.json()) as {
          typedData: { message: { origin: string } };
        };
        body.typedData.message.origin = "https://changed.example";
        return Response.json(body);
      }
      return response;
    };
    const {
      schema: _schema,
      name: _name,
      origin: _origin,
      planId: _planId,
      directoryProfile: _profile,
      ...hostDeployment
    } = chain.deployment;
    const signing = await operatorSigningFixture(directory,policy,options);
    // Real key-agent custody for the community media credential vault, the
    // same construction the Linux bootstrap performs. The Filebase transport
    // is the one injected boundary; the test controls token acceptance.
    for (const name of ["media-operation", "media-keys", "media-agent", "media-vault", "media-cohort", "dns-journal"])
      await mkdir(join(directory, name), { mode: 0o700 });
    const mediaFrame = await processIdentity(process.pid);
    assert(mediaFrame);
    const mediaLease = await acquireOperation(
      join(directory, "media-operation"),
      "wizard-media-storage",
      "wizard-host-fixture",
      { purpose: "integration" },
      mediaFrame.pidNamespace,
    );
    const mediaPair = generateKeyPairSync("ed25519");
    await writeFile(
      join(directory, "media-keys", "issuer.der"),
      mediaPair.privateKey.export({ format: "der", type: "pkcs8" }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, "media-keys", "master"), randomBytes(32), { mode: 0o600 });
    const mediaAuthKey = randomBytes(32);
    const mediaAgent = await startManagedKeyAgent({
      socket: join(directory, "media-agent", "key.sock"),
      directory: join(directory, "media-agent"),
      installationId: "wizard-host-fixture",
      authenticationKey: mediaAuthKey,
      lease: mediaLease,
      keys: [
        {
          ref: "community-media",
          generation: 1,
          path: join(directory, "media-keys", "master"),
          bytes: 32,
        },
      ],
      signingKeyFile: join(directory, "media-keys", "issuer.der"),
      trust: {
        keyId: "wizard-media-issuer",
        spki: mediaPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      },
      permittedProfileDigests: new Set(),
      capturedRoots: [join(directory, "media-cohort")],
    });
    const mediaChannel = await createManagedKeyClient({
      socket: join(directory, "media-agent", "key.sock"),
      installationId: "wizard-host-fixture",
      authenticationKey: mediaAuthKey,
      lease: mediaLease,
    });
    const filebase = {
      accepted: new Map<string, number>(),
      calls: [] as Array<{ method: string; path: string; authorization: string | null }>,
    };
    const filebaseTransport = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      filebase.calls.push({
        method: request.method,
        path: url.pathname + url.search,
        authorization,
      });
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!filebase.accepted.has(token))
        return new Response("refused", { status: 401 });
      const pins: Record<string, { Type: string }> = {};
      for (let i = 0; i < filebase.accepted.get(token)!; i++)
        pins["bafybeig" + String(i).padStart(40, "0")] = { Type: "recursive" };
      return new Response(JSON.stringify({ Keys: pins }), { status: 200 });
    };
    const prepareInput = {
      name:"Wizard Garden",origin:"https://wizard-community.example",controller,
      publisher:options.sameRecipient ? controller : web2Publisher.address.toLowerCase(),inviteToken,noticeAccepted:true,
    };
    let installationAttempts=0;
    const installationUnavailable=async()=>{installationAttempts++;throw Error("fixture installation must not run after an expired owner window");};
    const inputs = {
      policy,
      ...(options.observeInstallationAttempts ? {installation:{prepare:installationUnavailable,apply:installationUnavailable,status:installationUnavailable,close:async()=>{}}} : {}),
      ...(options.signingOrigin ? {signingOrigin:options.signingOrigin} : {}),
      notice,
      hostInstallationId:"wizard-host-fixture",
      ...(!options.missingCustody ? {publisherProof:signing.publisher} : {}),
      ...(options.publishing ? {publishing:{grants:signing.grants,chain:{client,send:communityIpfsTransport(chain.deployment),now:()=>BigInt(Math.floor(Date.now()/1000)),
        maxSafeBlockAgeSeconds:600n,deployment:{...policy.deployment,deploymentBlock:String(policy.deployment.deploymentBlock)},registrar:policy.registrar,registrarRevision:1n}}} : {}),
      deployment: options.invalidDeployment
        ? { ...hostDeployment, ipfsGateways: [] }
        : hostDeployment,
      configuration: {
        operatorPayments: chain.current().operatorPayments,
        signingKeyId: chain.current().feed.signingKeyId,
        policies: chain.current().policies,
      },
      transport,
      mediaStorage: undefined as CommunityMediaStorage | undefined,
      dns: undefined as import("../../apps/community-wizard/server/web2-dns-setup.ts").Web2DnsSetup | undefined,
      async pinConfiguration(value: { uri: string; bytes: Uint8Array }) {
        chain.contents.set(value.uri.slice(7), value.bytes);
      },
    };
    if(options.sameRecipient) {
      const selected={name:prepareInput.name,origin:prepareInput.origin,controller,publisher:controller};
      const {plan,deployment}=await prepareWeb2WizardRegistration(policy,inputs.configuration,inputs.deployment,selected);
      await inputs.pinConfiguration({uri:plan.uri,bytes:new TextEncoder().encode(canonical(plan.config))});
      const oldClient=createHostedEnrollmentClient(policy,transport),prepared=await oldClient.prepare(plan,inviteToken);
      const e=parseEnrollment(prepared.enrollment),proof=await web2Owner.signTypedData(enrollmentTypedData(e));
      await oldClient.redeem(prepared,proof);await chain.rpc("anvil_mine",["0x40","0x0"]);
      await oldClient.topup(prepared,proof,[{recipient:controller,signature:proof}]);await chain.rpc("anvil_mine",["0x40","0x0"]);
      const {journal,save}=await createWeb2Journal(directory,policy,inputs.hostInstallationId,runtime.now);
      Object.assign(journal,{request:selected,inviteToken,plan:web2Wire(planDocument(plan)),deployment,prepared,
        controllerSignature:proof,recipientProofs:[{recipient:controller,signature:proof}],
        enrollment:await oldClient.status(prepared,proof),phase:"funded"});
      await save();
    }
    const dnsAnswers = {
      txt: new Map<string, string[]>(),
      a: new Map<string, string[]>(),
    };
    const dnsError = (code: string) =>
      Object.assign(new Error(code), { code });
    const dnsResolver = {
      async resolveTxt(name: string) {
        const found = dnsAnswers.txt.get(name);
        if (!found) throw dnsError("ENODATA");
        return found.map((value) => [value]);
      },
      async resolve4(name: string) {
        const found = dnsAnswers.a.get(name);
        if (!found) throw dnsError("ENODATA");
        return found;
      },
      async resolve6() {
        throw dnsError("ENODATA");
      },
    };
    const start = async () => {
      inputs.mediaStorage?.dispose();
      inputs.mediaStorage = await createCommunityMediaStorage({
        directory: join(directory, "media-vault"),
        lease: mediaLease,
        channel: mediaChannel,
        keyRef: "community-media",
        keyGeneration: 1,
        installationId: "wizard-host-fixture",
        send: filebaseTransport,
      });
      inputs.dns = await createWeb2DnsSetup({
        directory: join(directory, "dns-journal"),
        resolver: dnsResolver,
      });
      setup = await createWeb2Setup(directory, inputs);
      server = createWizardServer(
        undefined,
        resolve("apps/community-wizard/dist"),
        { infisical: false, cloudflare: false },
        {
          web2: setup,
          async authorizeWeb2(req) {
            // A private test channel, not a claim about the Linux pairing issuer.
            if (req.headers.cookie !== "wizard_fixture=paired")
              throw new LinuxInputError(
                "operator_pairing_required",
                "Use the original paired runner.",
              );
          },
        },
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin =
        "http://127.0.0.1:" + (server.address() as { port: number }).port;
      origins.push(origin);
      await recordNative("running");
    };
    await start();
    const raw = async (
      method: string,
      path: string,
      body?: unknown,
      overrides: {
        pair?: boolean;
        host?: string;
        origin?: string;
        csrf?: string;
      } = {},
    ) => {
      // Node fetch rewrites Host to the URL host. node:http sends the requested
      // wire header, so the negative Host case reaches the actual server guard.
      return new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const request = httpRequest(
            origin + path,
            {
              method,
              headers: {
                "content-type": "application/json",
                ...(overrides.pair === false
                  ? {}
                  : { cookie: "wizard_fixture=paired" }),
                ...(method === "POST"
                  ? {
                      origin: overrides.origin ?? origin,
                      "x-wizard-token": overrides.csrf ?? csrf,
                    }
                  : {}),
                host: overrides.host ?? new URL(origin).host,
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              let size = 0;
              response.on("data", (value: Buffer) => {
                size += value.length;
                if (size > 262144)
                  request.destroy(Error("fixture response bound"));
                else chunks.push(value);
              });
              response.on("error", (error) => {
                clearTimeout(deadline);
                reject(error);
              });
              response.on("end", () => {
                clearTimeout(deadline);
                try {
                  resolve({
                    status: response.statusCode!,
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          const deadline = setTimeout(
            () => request.destroy(Error("fixture HTTP deadline")),
            10000,
          );
          request.on("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
          request.end(body === undefined ? undefined : JSON.stringify(body));
        },
      );
    };
    const state = async () => {
      const r = await raw("GET", "/api/web2/state");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      csrf = r.body.csrf as string;
      return r.body.view as unknown as Web2WizardView;
    };
    const post = async (action: string, input: unknown, revision?: number) => {
      const current = await state();
      return raw("POST", "/api/web2/" + action, {
        ...(input as object),
        revision: revision ?? current.revision,
      });
    };
    const send = async (action: string, input: unknown) => {
      const r = await post(action, input);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.view as unknown as Web2ActionView;
    };
    const sign = async (typed: unknown, actor = controller) =>
      (actor.toLowerCase() === web2Publisher.address.toLowerCase()
        ? web2Publisher
        : web2Owner
      ).signTypedData(typed as ReturnType<typeof enrollmentTypedData>);
    const stopServer = async () => {
      await setup?.settled();
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((e) => (e ? reject(e) : resolve())),
        );
      }
    };
    return {
      get origin() {
        return origin;
      },
      directory,
      installationAttempts:()=>installationAttempts,
      nominatedOwner:web2Other.address.toLowerCase(),
      signingJournal:join(directory,"web2-signing-sidecar.json"),
      loseAttachmentReply:(outcome:"before"|"after"="after")=>signing!.loseAttachmentReply(outcome),
      waitForGrantExpiry:()=>signing.waitForGrantExpiry(),
      attachmentEffects:()=>signing.attachmentEffects(),
      attachmentUnknown:(value:boolean)=>signing.attachmentUnknown(value),
      custodyUnavailable:()=>signing.custodyUnavailable(),
      changeGrantSelection:(kind:"publisher")=>signing!.changeGrantSelection(kind),
      journal: join(directory, "web2-wizard-original.json"),
      dnsAnswers,
      inviteToken,
      prepareInput,
      raw,
      state,
      post,
      send,
      sign,
      prepare: () => send("prepare", prepareInput),
      prepareResponse: () => post("prepare", prepareInput),
      dropRedeemReply: () => {
        dropRedeem = true;
      },
      dropPrepareReply: () => {
        dropPrepare = true;
      },
      changePrepareReply: () => {
        changePrepare = true;
      },
      holdNextStatus() {
        let enter!: () => void, resolve!: () => void;
        const entered = new Promise<void>((done) => {
            enter = done;
          }),
          wait = new Promise<void>((done) => {
            resolve = done;
          });
        const release = () => {
          statusReleases.delete(release);
          resolve();
        };
        statusReleases.add(release);
        nextStatusGate = { enter, wait };
        return { entered, release };
      },
      broadcasts: () => chain.effects.broadcasts - before,
      preparationCount: async () =>
        (await db
          .prepare("SELECT COUNT(*) AS n FROM hosted_preparations")
          .first<{ n: number }>())!.n,
      mine: () => chain.rpc("anvil_mine", ["0x40", "0x0"]),
      recipientProofs: async (view: Web2WizardView) =>
        Promise.all(
          view.recipients.map(async (r) => ({
            recipient: r.address,
            signature: await sign(view.challenge, r.address),
          })),
        ),
      async restart() {
        await stopServer();
        await start();
      },
      async artifact(label: string, view: Web2WizardView) {
        const operations = view.enrollment
          ? await allOperations(db, view.enrollment.enrollmentId)
          : [];
        const original = JSON.parse(
          await readFile(join(directory, "web2-wizard-original.json"), "utf8"),
        );
        await mkdir(".local/web2-owner-signing-implementation/completion/hosted-wizard/evidence", { recursive: true });
        const artifactPath = `.local/web2-owner-signing-implementation/completion/hosted-wizard/evidence/${label}-${Date.now()}.json`;
        await writeFile(
          artifactPath,
          JSON.stringify(
            {
              schema: "pirate.web2-wizard-evidence/1",
              scope:
                "Actual Wizard HTTP, hosted handlers, D1 and disposable 6343 RPC; fixture paired/wallet/content transport; no installed Linux claim",
              view,
              sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
                encoding: "utf8",
              }).trim(),
              sourceTreeDirty: Boolean(
                execFileSync(
                  "git",
                  ["status", "--porcelain", "--untracked-files=no"],
                  { encoding: "utf8" },
                ).trim(),
              ),
              requestDigest:hashJson(original.request),
              configurationDigest:hashJson(original.plan.config),
              ...(await readFile(join(directory,"web2-signing-sidecar.json"),"utf8").then(raw=>{
                const sidecar=JSON.parse(raw);return {authorizationDigest:sidecar.accepted ? hashJson(sidecar.accepted) : null,
                  grantDigest:sidecar.selection.grant.sha256,selectionDigest:sidecar.selection.selectionDigest,attachmentDigest:sidecar.attachment?.digest ?? null};
              },()=>({}))),
              plan: original.plan,
              policy: policyDocument(policy),
              broadcasts: chain.effects.broadcasts - before,
              operations: operations.map((o) => ({
                kind: o.kind,
                transactionHash: o.tx_hash,
                // Only consumed disposable-fixture originals are exportable.
                // The product's public status never returns signed raw bytes.

                receipt: o.receipt ? JSON.parse(o.receipt) : null,
              })),
            },
            null,
            2,
          ),
        );
        return artifactPath;
      },
      filebase,
      async close() {
        for (const release of statusReleases) release();
        inputs.mediaStorage?.dispose();
        const results = await Promise.allSettled([
          stopServer(),
          mf.dispose(),
          chain.close(),
          (async () => {
            mediaChannel.dispose();
            await mediaAgent.close();
          })(),
        ]);
        const failures = results.filter((r) => r.status === "rejected");
        await recordNative(failures.length ? "cleanup-uncertain" : "closed");
        if (!failures.length) await rm(directory, { recursive: true });
        else
          throw new AggregateError(
            failures,
            "Wizard fixture cleanup retained private state",
          );
      },
    };
  } catch (error) {
    server?.closeAllConnections();
    server?.close();
    const results = await Promise.allSettled([mf.dispose(), chain.close()]);
    if (results.every((r) => r.status === "fulfilled"))
      await rm(directory, { recursive: true });
    await recordNative(
      results.every((r) => r.status === "fulfilled")
        ? "closed"
        : "cleanup-uncertain",
    ).catch(() => {});
    throw error;
  }
}
