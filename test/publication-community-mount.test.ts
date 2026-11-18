import assert from "node:assert/strict";
import test from "node:test";
import { zeroHash } from "viem";
import {
  parseWeb2ProfileDocument,
  web2ProfileDocument,
} from "../packages/community/web2-directory.ts";
import {
  communityFetch,
  type CommunityDependencies,
  type CommunityEnv,
} from "../services/community-application.ts";
import type { Web2CommunityDeploymentProfile } from "../services/community-deployment-profile.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";

test("mounted Web2 consent recovers a recorded original independently of private practice and fresh configuration", { timeout: 30000 }, async (t) => {
  const fixture = await publicationAppFixture(t);
  const { configuration } = fixture.authority.release;
  const profile = web2ProfileDocument(
    parseWeb2ProfileDocument(fixture.authority.release.profile),
  );
  const origin = fixture.context.origin;
  const deployment: Web2CommunityDeploymentProfile = {
    schema: "pirate.community-deployment/2",
    origin,
    name: "Publication fixture",
    planId: "fixture",
    postingPeriod: "1",
    rpcUrl: origin + "/unavailable",
    ipfsGateways: [],
    managedOrigin: origin,
    directoryProfile: profile,
    posts: {
      address: configuration.postsContract,
      runtimeCodeHash: fixture.authority.release.source.directoryRuntimeHash,
      deploymentBlock: "1",
    },
    freshness: { maxSafeBlockAgeSeconds: "900" },
  };
  const env = {
    DB: fixture.ports.db,
    COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON: "{",
  } as CommunityEnv;
  let configurationReads = 0;
  async function unavailableConfiguration(): Promise<never> {
    configurationReads += 1;
    throw new Error("fresh Directory deliberately unavailable");
  }
  const ports: CommunityDependencies = {
    deployment,
    configuration: unavailableConfiguration,
    freshConfiguration: unavailableConfiguration,
    verifyLogin: async () => false,
    creatorHealth: async () => false,
  };
  const cookie = "__Host-community_session=" + "a".repeat(64);
  const request = (route: string, init?: RequestInit) => {
    const headers = new Headers({ cookie, origin });
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    return new Request(origin + "/api/publication-consent/v1/" + route, { ...init, headers });
  };

  const noMount = await communityFetch(request("capabilities"), env, ports);
  assert.equal(noMount.status, 404);
  assert.deepEqual(await noMount.json(), { error: "feature_unavailable" });

  const mounted = () => ({ ...ports, publication: fixture.ports });
  const wrongInstallation = await communityFetch(request("capabilities"), env, {
    ...mounted(),
    deployment: {
      ...deployment,
      directoryProfile: { ...profile, installationId: zeroHash },
    } satisfies Web2CommunityDeploymentProfile,
  });
  assert.equal(wrongInstallation.status, 503);
  assert.equal(
    (await communityFetch(request("capabilities", { headers: { cookie: "" } }), env, mounted())).status,
    409,
  );

  const prepare = (requestId: string) => ({
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "fixture-csrf-value" },
    body: JSON.stringify({ requestId, purpose: "study-results" }),
  });
  const invalid = prepare("common-csrf-denied");
  const denied = await communityFetch(request("grants/prepare", {
    ...invalid,
    headers: { ...invalid.headers, "x-csrf-token": "wrong" },
  }), env, mounted());
  assert.equal(denied.status, 403);
  assert.equal((await fixture.rows()).length, 0);

  const prepared = await communityFetch(request("grants/prepare", prepare("common-original")), env, mounted());
  assert.equal(prepared.status, 200);
  const command = parseCommand((await prepared.json() as { command: unknown }).command);
  const { commandId } = command;
  assert.match(commandId, /^0x[0-9a-f]{64}$/);
  const submit = await communityFetch(request("commands/" + commandId + "/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "fixture-csrf-value" },
    body: JSON.stringify({ signature: await fixture.sign(command) }),
  }), env, mounted());
  assert.equal(submit.status, 200);
  assert.equal((await submit.json() as { phase: string }).phase, "accepted");
  const original = await fixture.historicalRecordedOriginal(command);

  await fixture.setCatalog(null);
  const recovered = await communityFetch(request("commands/" + commandId), env, mounted());
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("cache-control"), "no-store");
  assert.equal(recovered.headers.get("x-content-type-options"), "nosniff");
  assert.match(recovered.headers.get("content-type") ?? "", /^application\/json/);
  const readback = await recovered.json() as {
    phase: string;
    commandId: string;
    receipt: { state: string; transactionHash: string };
  };
  assert.equal(readback.commandId, commandId);
  assert.equal(readback.phase, "accepted");
  assert.equal(readback.receipt.state, "recorded");
  assert.equal(readback.receipt.transactionHash, original.hash);
  const disabled = await communityFetch(request("grants/prepare", prepare("common-disabled")), env, mounted());
  assert.equal(disabled.status, 409);
  assert.equal((await fixture.rows()).length, 1);
  assert.deepEqual(fixture.operatorCalls.map(({ path }) => path), [
    "/publication/v1/accept",
    "/publication/v1/reconcile",
    "/publication/v1/reconcile",
  ]);
  assert.ok(fixture.authority.state.calls.every((method) => !method.startsWith("eth_send")));
  assert.equal(configurationReads, 0);
});
