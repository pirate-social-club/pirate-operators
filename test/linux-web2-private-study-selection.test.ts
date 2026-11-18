import assert from "node:assert/strict";
import test from "node:test";
import { hashJson } from "../packages/community/common.ts";
import { linuxWeb2DraftFrom } from "../packages/community-setup/linux-web2-profile.ts";
import { readPrivatePracticeProfile } from "../services/community-private-practice-profile.ts";
import { renderFullNativeConfig, type NativeGraph } from "../deploy/linux/full-native-config.ts";
import type { Web2BootstrapRelease } from "../deploy/linux/installed-release.ts";
import {
  assertNoBootstrapPractice, studyModule, withWeb2LocalStudy, type Web2LocalStudyPolicy,
} from "../deploy/linux/web2-local-study.ts";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";

const root = "/var/tmp/web2-study-selection-fixture";
const durableScope = "1".repeat(64);
const hex = (value: string): `0x${string}` => `0x${value}`;
function inputs(deployment: unknown) {
  const graph: NativeGraph = {
    installationId: "fixture-local-host", durableScope, releaseRoot: root + "/release", schemaPath: root + "/release/workerd.capnp",
    stateRoots: Object.fromEntries(["database", "objects", "jobs", "scheduler", "readiness", "configuration", "private-study"]
      .map(role => [role, root + "/" + role])),
    socket: root + "/control.sock", applicationBindings: [], actors: [], requiredRoles: ["application"],
    queueConfiguration: { scope: durableScope }, maintenanceConfiguration: { scope: durableScope },
    directoryRuntimeBinding: JSON.stringify(deployment), allowedOrigins: ["https://content.test"], secretBindings: [],
    listenAddress: "0.0.0.0:8443", tls: { keyFile: root + "/tls.key", certificateFile: root + "/tls.pem" },
    migrationPlanFile: root + "/release/migration-plan.json", probePlanFile: root + "/probe.json", readbackKeyFile: root + "/readback.key",
    fixtureTransport: { schema: "pirate.linux-local-fixture-transport/1", peer: "10.20.0.2",
      routes: [{ origin: "https://content.test", upstream: "http://10.20.0.2:8180/fixture/chain" }] },
  };
  const release: Web2BootstrapRelease = {
    schema: "pirate.linux-web2-bootstrap-release/1", sourceHead: "a".repeat(40), sourceTree: "b".repeat(40),
    root: graph.releaseRoot, sourceRoot: graph.releaseRoot + "/source",
    execution: { node: "toolchain/node", nodeSha256: "a".repeat(64), nodeVersion: "v24.18.1",
      loader: "toolchain/node_modules/tsx/dist/loader.mjs", tsxVersion: "4.20.6", backend: "source/backend.ts" },
    files: { [studyModule]: "c".repeat(64) }, sourceHashes: {}, imageId: "sha256:" + "d".repeat(64),
    artifactDigest: hex("e".repeat(64)), sourceDigest: hex("f".repeat(64)),
  };
  const policy: Web2LocalStudyPolicy = { schema: "pirate.web2-local-study-policy/1", issuer: hex("1".repeat(40)),
    issuerFile: root + "/authority/issuer.key", operator: hex("2".repeat(40)),
    asr: { origin: "https://study-asr.test", upstream: "http://10.20.0.2:8180/fixture/study-asr",
      authFile: root + "/authority/asr.auth", authSha256: hex("1".repeat(64)), selectedProgramSha256: hex("2".repeat(64)) },
    speech: { keyGeneration: "fixture-test", dailyUnits: 2, websiteStudyReservedUnits: 1 },
  };
  return { graph, release, policy };
}

test("Web2 Study is explicit, keeps the original zero-Records enrollment, and scopes the two native services to it", async () => {
  const fixture = await installationAuthorityFixture();
  try {
    const { draft } = fixture;
    const { graph, release, policy } = inputs(draft.deployment);
    assert.deepEqual(linuxWeb2DraftFrom(draft), draft);
    assert.equal(withWeb2LocalStudy(graph, draft, release, policy), graph);
    assert.throws(() => linuxWeb2DraftFrom({ ...draft, privatePractice: false }), /web2_private_practice_selection_invalid/);
    const chosen = linuxWeb2DraftFrom({ ...draft, privatePractice: "study-v5" });
    assert.deepEqual(chosen.configuration, draft.configuration);
    assert.deepEqual(chosen.enrollment, draft.enrollment);
    assert.equal(chosen.configuration.learningRecords, "0x" + "0".repeat(40));
    assert.throws(() => withWeb2LocalStudy(graph, chosen, release), /web2_private_study_unavailable/);
    const bound = withWeb2LocalStudy(graph, chosen, release, policy);
    const lookup = (name: string) => bound.applicationBindings.find(row => row.name === name);
    const scope = { communityId: draft.enrollment.communityId, installationId: draft.enrollment.installationId,
      deploymentDigest: hashJson(draft.deployment) };
    const profile = readPrivatePracticeProfile(lookup("COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON")!.text, scope)!;
    assert.equal(profile.activities.study?.profileHash, hashJson(JSON.parse(lookup("STUDY_PRIVATE_V5_PROFILE")!.text!)));
    assert.equal(profile.activities.dance, null);
    assert.equal(profile.activities.karaoke, null);
    assert.throws(() => readPrivatePracticeProfile(lookup("COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON")!.text,
      { ...scope, installationId: hex("3".repeat(64)) }), /private_practice_deployment_changed/);
    assert.throws(() => assertNoBootstrapPractice(bound), /bootstrap_private_practice_prebinding_refused/);
    const capnp = renderFullNativeConfig(bound, "serve", durableScope);
    assert.match(capnp, /className="SpeechBudget"/);
    assert.match(capnp, /className="PrivateStudyState"/);
    assert.match(capnp, /name="KARAOKE_OPERATOR",service="private-study-operator"/);
    assert.deepEqual(withWeb2LocalStudy(graph, structuredClone(chosen), release, policy), bound);
    assert.notDeepEqual(withWeb2LocalStudy(graph, chosen, release, {
      ...policy, asr: { ...policy.asr, selectedProgramSha256: hex("7".repeat(64)) },
    }), bound);
  } finally { await fixture.close(); }
});
