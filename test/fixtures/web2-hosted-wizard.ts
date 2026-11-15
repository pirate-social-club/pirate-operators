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
  type Web2WizardView,
} from "../../apps/community-wizard/server/web2-setup.ts";
import { createWizardServer } from "../../apps/community-wizard/server/http.ts";
import { LinuxInputError } from "../../packages/community-setup/shared-linux-profile.ts";

export async function hostedWizardFixture(
  options: {
    contractController?: boolean;
    sameRecipient?: boolean;
    invalidDeployment?: boolean;
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
  const nativeDirectory = resolve(".local/web2-hosted-wizard/native");
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
    const inputs = {
      policy,
      notice,
      deployment: options.invalidDeployment
        ? { ...hostDeployment, ipfsGateways: [] }
        : hostDeployment,
      configuration: {
        operatorPayments: chain.current().operatorPayments,
        signingKeyId: chain.current().feed.signingKeyId,
        policies: chain.current().policies,
      },
      transport,
      async pinConfiguration(value: { uri: string; bytes: Uint8Array }) {
        chain.contents.set(value.uri.slice(7), value.bytes);
      },
    };
    const start = async () => {
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
      return r.body.view as unknown as Web2WizardView;
    };
    const prepareInput = {
      name: "Wizard Garden",
      origin: "https://wizard-community.example",
      controller,
      publisher:
        options.contractController || options.sameRecipient
          ? controller
          : web2Publisher.address.toLowerCase(),
      inviteToken,
      noticeAccepted: true,
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
      journal: join(directory, "web2-wizard-original.json"),
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
        await mkdir(".local/web2-hosted-wizard/evidence", { recursive: true });
        const artifactPath = `.local/web2-hosted-wizard/evidence/${label}.json`;
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
              plan: original.plan,
              policy: policyDocument(policy),
              broadcasts: chain.effects.broadcasts - before,
              operations: operations.map((o) => ({
                kind: o.kind,
                transactionHash: o.tx_hash,
                // Only consumed disposable-fixture originals are exportable.
                // The product's public status never returns signed raw bytes.
                consumedFixtureRawTransaction:
                  o.state === "consumed" ? o.raw : null,
                receipt: o.receipt ? JSON.parse(o.receipt) : null,
              })),
            },
            null,
            2,
          ),
        );
        return artifactPath;
      },
      async close() {
        const results = await Promise.allSettled([
          stopServer(),
          mf.dispose(),
          chain.close(),
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
