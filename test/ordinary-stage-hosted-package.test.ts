import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ordinaryStageApplicationOrigin } from "../harness/managed-package.ts";
import { canonical, hashText } from "../packages/community/common.ts";
import { hostedCommunityConfiguration } from "../services/hosted-community-runtime.ts";
import { hostedFixture } from "./fixtures/hosted-community-enrollment.ts";

const stage = "pirate-web2-enrollment-staging";
const worker = "https://pirate-web2-enrollment-staging.piratesocialclub.workers.dev";
const app = "https://staging.jazleeuw.club";

test("the ordinary enrollment package requires the exact staging origin, service, and stack", () => {
  assert.equal(ordinaryStageApplicationOrigin(stage, worker, app), app);
  for (const input of [undefined, "https://jazleeuw.club", app + "/", app + "\n", worker]) {
    assert.throws(() => ordinaryStageApplicationOrigin(stage, worker, input), /hosted_staging_application_origin_required/);
  }
  assert.throws(
    () => ordinaryStageApplicationOrigin(stage, "https://example.com", app),
    /hosted_staging_application_origin_required/,
  );
});

test("existing non-stage hosted packages retain their input and cannot claim the stage scope", () => {
  assert.equal(ordinaryStageApplicationOrigin("pirate-bounded-fixture", "https://example.com", undefined), undefined);
  assert.throws(
    () => ordinaryStageApplicationOrigin("pirate-bounded-fixture", worker, app),
    /hosted_staging_stack_required/,
  );
  assert.throws(
    () => ordinaryStageApplicationOrigin("pirate-web2-admission-staging", worker, undefined),
    /hosted_staging_stack_required/,
  );
});

test("actual Alchemy stage collection binds matching runtime JSON and app-origin variable without effect keys", async () => {
  const fixture = await hostedFixture({}, { packaged: true, stagingApplicationOrigin: app });
  try {
    assert(fixture.worker);
    const { cwd, pkg } = fixture.worker, script = join(cwd, "collect-ordinary-stage.mjs");
    await writeFile(script, `
import * as E from "effect/Effect";
import * as C from "effect/ConfigProvider";
import {StackContext} from "alchemy/StackContext";
const module = await import("./alchemy.run.ts");
const stack = {name:module.default.stackName,stage:"staging",resources:{},bindings:{},actions:{}};
await E.runPromise(module.selectedManagedResources.pipe(E.provideService(StackContext,stack),
  E.provideService(C.ConfigProvider,C.fromUnknown({}))));
const resources = Object.values(stack.resources);
const env = resources.find(r => r.Type === "Cloudflare.Worker").Props.env;
console.log(JSON.stringify({ stack:stack.name, resources:resources.map(r=>r.Type).sort(),
  bindings:Object.keys(env).sort(), origin:env.HOSTED_STAGING_APPLICATION_ORIGIN,
  bytes:env.HOSTED_COMMUNITY_CONFIGURATION_JSON, digest:env.HOSTED_COMMUNITY_CONFIGURATION_SHA256 }));
`, { mode: 0o600 });
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      cwd, timeout: 60_000, maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(),
        MANAGED_SERVICE_PACKAGE_PROFILE: "hosted-enrollment", MANAGED_WEB2_PREFIX: stage,
        MANAGED_WEB2_PLAN_ID: pkg.profile.identity.planId, MANAGED_WEB2_PACKAGE_DIGEST: pkg.profileHash },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.stack, stage);
    assert.deepEqual(result.resources, ["Cloudflare.D1Database", "Cloudflare.Worker"]);
    assert.deepEqual(result.bindings, [
      "DB", "HOSTED_COMMUNITY_CONFIGURATION_JSON", "HOSTED_COMMUNITY_CONFIGURATION_SHA256",
      "HOSTED_COMMUNITY_PROFILE", "HOSTED_STAGING_APPLICATION_ORIGIN",
    ]);
    assert.equal(result.origin, app);
    const parsed = hostedCommunityConfiguration(JSON.parse(result.bytes));
    assert.equal(parsed.stagingApplicationOrigin, app);
    assert.equal(result.bytes, canonical(parsed));
    assert.equal(result.digest, hashText(result.bytes));
  } finally { await fixture.close(); }
});
