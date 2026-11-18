import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { sha256 } from "viem";
import { preparePublicationGrant } from "../../../packages/protocol/publication-consent.ts";
import { communityId, origin, serveCommunity } from "./community-fixture.ts";

const prefix = origin + "/api/publication-consent/v1/";
const word = (digit: string) => "0x" + digit.repeat(64);
const registry = `0x${"a".repeat(40)}` as const;
const documents = { terms: "Fixture terms", disclosure: "Fixture publication disclosure", privacy: "Fixture privacy", retention: "Fixture retention" };
const documentHash = (text: string) => sha256(new TextEncoder().encode(text));
const policyManifest = JSON.stringify(Object.fromEntries(Object.entries(documents).map(([key, text]) => [`${key}Sha256`, documentHash(text)])));

for (const actor of [
  { purpose: "dance-verdict", wallet: "2", author: "1", command: "1", renewed: "4", nonce: "2" },
  { purpose: "dance-review-attribution", wallet: "9", author: "9", command: "8", renewed: "a", nonce: "9" },
]) test(`publication settings recover ${actor.purpose} replies on the same request without a second MOSS prompt`, async ({ page }) => {
  const { purpose } = actor;
  const wallet = "0x" + actor.wallet.repeat(40);
  const community = await serveCommunity(page, true, false, false, "strict-origin", {
    sessionIdentity: { authorId: word(actor.author), wallet },
  });
  await page.route(origin + "/api/capabilities", (route) => route.fulfill({ json: {
    schema: "pirate.community-capabilities/1", signIn: true, creatorConnection: false,
    upload: false, publication: false, policyVersion: "fixture", publicationPermissions: true,
  } }));
  const manifest = JSON.parse(await readFile("dist/live/.vite/manifest.json", "utf8")) as Record<string, { file: string }>;
  const walletPath = Object.entries(manifest).find(([name]) => name.includes("@megaeth-labs/wallet-sdk"))?.[1].file;
  expect(walletPath).toBeTruthy();
  const prompts: unknown[] = [];
  await page.route(origin + "/__fixture/publication-prompt", async (route) => {
    prompts.push(route.request().postDataJSON());
    await route.fulfill({ json: true });
  });
  await page.route(`${origin}/${walletPath}`, (route) => route.fulfill({
    contentType: "application/javascript",
    body: `const connected = { status: "connected", address: ${JSON.stringify(wallet)} };
      export const mega = { async initialise(){}, async connect(){return connected}, async status(){return connected},
        async signData({data}){await fetch("/__fixture/publication-prompt", {method:"POST",body:JSON.stringify(data)});
          return {status:"success",signature:"0x7d"}} };`,
  }));
  await page.route(prefix + "capabilities", (route) => route.fulfill({ json: {
    profile: "publication-consent-v1", purposes: ["dance-verdict", "dance-review-attribution"],
  } }));
  await page.route(prefix + `state?purpose=${purpose}`, (route) => route.fulfill({ json: {
    schema: "pirate.publication-permission/1", purpose, commandId: null, sourceId: word("7"),
    state: "denied", reason: "unknown_grant",
  } }));
  const requests: string[] = [];
  const submissions: string[] = [];
  const reads: string[] = [];
  let accepted = false;
  function original(requestId: string, isRenewal = false) {
    const commandId = word(isRenewal ? actor.renewed : actor.command);
    const message = {
      communityId, learner: wallet, purpose, nonce: isRenewal ? word("5") : word(actor.nonce),
      publicationTarget: registry, publicationTargetRuntimeHash: word("6"), policyHash: documentHash(policyManifest),
      permissionRevision: "1", withdrawalEpoch: "0", issuedAt: "1800000000", validAfter: "1800000000",
      expiresAt: "1800000120", submitBefore: "1800000060",
    };
    const { digest } = preparePublicationGrant(6343n, registry, message, "0x");
    return {
      commandId, phase: accepted && !isRenewal ? "accepted" : "prepared",
      command: {
        schema: "pirate.publication-command/1", commandId, requestId, action: "grant", digest,
        accountId: community.accountId, preparedAtMs: 1, localFenceGeneration: "0",
        source: { schema: "pirate.publication-source/1", resultsVersion: 5, communityId, chainId: 6343, registry },
        message,
      },
      receipt: accepted && !isRenewal ? { state: "recorded", action: "grant", purpose, commandId, digest } : null,
      documents: { ...documents, manifest: policyManifest },
    };
  }
  await page.route(prefix + "grants/prepare", async (route) => {
    const body = route.request().postDataJSON() as { requestId: string; purpose: string };
    expect(route.request().headers()["x-csrf-token"]).toEqual("fixture-csrf");
    expect(body.purpose).toEqual(purpose);
    requests.push(body.requestId);
    if (requests.length === 1) return route.abort();
    return route.fulfill({ json: original(body.requestId, body.requestId !== requests[0]) });
  });
  await page.route(prefix + `commands/${word(actor.command)}`, (route) => {
    reads.push(route.request().url());
    return route.fulfill({ json: original(requests[0]!) });
  });
  await page.route(prefix + `commands/${word(actor.command)}/submit`, (route) => {
    submissions.push(route.request().postDataJSON().signature);
    accepted = true;
    return route.abort();
  });
  await page.goto(origin + "/#/account");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const choose = () => page.getByLabel("Publication purpose").selectOption(purpose);
  await choose();
  await page.getByRole("button", { name: "Review publication request" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The request was interrupted" })).toBeVisible();
  await page.reload();
  await choose();
  await page.getByRole("button", { name: "Continue preparing" }).click();
  const sign = page.getByRole("button", { name: "Sign publication grant in MOSS" });
  await expect(sign).toBeVisible();
  expect(requests).toEqual([requests[0], requests[0]]);
  await sign.click();
  await expect(page.getByRole("status").filter({ hasText: "The request was interrupted" })).toBeVisible();
  await page.reload();
  await choose();
  await expect(page.getByText("Publication grant recorded.")).toBeVisible();
  expect(reads).toHaveLength(2);
  expect(prompts).toEqual([expect.objectContaining({ primaryType: "PublicationGrant", message: expect.objectContaining({
    purpose, learner: wallet, nonce: word(actor.nonce),
  }) })]);
  expect(submissions).toEqual(["0x7d"]);
  await page.getByRole("button", { name: "Review a new grant" }).click();
  await expect(sign).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[2]).not.toEqual(requests[0]);
  expect(prompts).toHaveLength(1);
});
