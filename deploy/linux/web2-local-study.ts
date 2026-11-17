import assert from "node:assert/strict";
import { isAbsolute, relative, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson, hashText } from "../../packages/community/common.ts";
import { address } from "../../packages/community/manifest-core.ts";
import type { LinuxWeb2Draft } from "../../packages/community-setup/linux-web2-profile.ts";
import { studyPrivateV5Profile } from "../../packages/study/private-v5.ts";
import type { SpeechAdmissionPolicy } from "../../services/study-speech-admission.ts";
import type { NativeBinding, NativeGraph } from "./full-native-config.ts";
import { privateDirectory, privateFile } from "./backend-state.ts";
import type { Web2BootstrapRelease } from "./installed-release.ts";
import type { InstalledTarget } from "./local-target-controller.ts";

export const studyModule = "web2-study-operator.worker.mjs";
const service = "private-study-operator";
const actorRole = "private-study";
const budget = { service, className: "SpeechBudget" };
const issuerBinding = "KARAOKE_SIGNER_PRIVATE_KEY";
const names = new Set([
  "COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON", "STUDY_RUNTIME",
  "STUDY_PRIVATE_V5_PROFILE", "STUDY_GRADER_ACTIVATION",
  "KARAOKE_SERVICE_MODE", "KARAOKE_PAYMENT_CHAIN_ID", "KARAOKE_OPERATOR",
  "KARAOKE_OPERATOR_ADDRESS", issuerBinding, "SPEECH_ADMISSION_CONFIG",
  "SPEECH_BUDGET", "LOCAL_STUDY_ASR_URL", "LOCAL_STUDY_ASR_AUTH", "LOCAL_STUDY_ASR",
]);

/** Only a signed local host policy can supply these values. The paired
 * browser supplies one activity choice and never supplies a runtime input. */
export interface Web2LocalStudyPolicy {
  schema: "pirate.web2-local-study-policy/1";
  issuer: `0x${string}`;
  issuerFile: string;
  operator: `0x${string}`;
  asr: {
    origin: string;
    upstream: string;
    authFile: string;
    authSha256: `0x${string}`;
    selectedProgramSha256: `0x${string}`;
  };
  speech: Pick<SpeechAdmissionPolicy,
    "keyGeneration" | "dailyUnits" | "websiteStudyReservedUnits">;
}

type BootstrapGraph = Omit<NativeGraph, "directoryRuntimeBinding">;
const within = (path: string, root: string) => {
  const child = relative(root, path);
  return isAbsolute(path) && resolve(path) === path && child.length > 0 &&
    child !== ".." && !child.startsWith("../") && !isAbsolute(child);
};
const digest = (value: string) => /^0x(?!0{64}$)[a-f0-9]{64}$/.test(value);

export function assertNoBootstrapPractice(graph: BootstrapGraph) {
  assert(!graph.applicationBindings.some(x => names.has(x.name)) &&
    !graph.secretBindings.some(x => names.has(x.name)) &&
    !graph.actors.some(a => a.service === service || a.role === actorRole ||
      a.module === studyModule || a.bindings.some(x => names.has(x.name))),
    "bootstrap_private_practice_prebinding_refused");
}

export function validateWeb2LocalStudyPolicy(
  selected: Web2LocalStudyPolicy,
  graph: BootstrapGraph,
  release: Web2BootstrapRelease,
  target: InstalledTarget,
  nativeSocket?: string,
) {
  assert(selected.schema === "pirate.web2-local-study-policy/1");
  const { asr, speech } = selected;
  assert(address(selected.issuer) === selected.issuer &&
    address(selected.operator) === selected.operator && selected.operator !== selected.issuer &&
    !/^0x0+$/.test(selected.issuer) && !/^0x0+$/.test(selected.operator),
    "web2_private_study_operator_authority_required");
  assert(/^[a-zA-Z0-9_-]{1,64}$/.test(speech.keyGeneration) &&
    Number.isSafeInteger(speech.dailyUnits) && speech.dailyUnits > 0 &&
    Number.isSafeInteger(speech.websiteStudyReservedUnits) &&
    speech.websiteStudyReservedUnits > 0 && speech.websiteStudyReservedUnits <= speech.dailyUnits,
    "web2_private_study_speech_admission_required");
  const fixture = graph.fixtureTransport;
  const origin = new URL(asr.origin), upstream = new URL(asr.upstream);
  const selectedTransport = nativeSocket
    ? asr.upstream === "unix:" + nativeSocket
    : fixture && upstream.protocol === "http:" && upstream.hostname === fixture.peer && upstream.port &&
      upstream.pathname === "/fixture/study-asr" && !upstream.search && !upstream.hash &&
      !upstream.username && !upstream.password && !fixture.routes.some(r => r.origin === asr.origin);
  assert(selectedTransport && origin.origin === asr.origin && origin.protocol === "https:" &&
    origin.hostname.endsWith(".test") && !origin.username && !origin.password && !graph.allowedOrigins.includes(asr.origin) &&
    digest(asr.authSha256) && digest(asr.selectedProgramSha256),
    "web2_private_study_local_transport_required");
  assert(/^[a-f0-9]{64}$/.test(release.files[studyModule] ?? ""),
    "web2_private_study_operator_module_required");
  const app = target.containers.find(c => c.key === "application");
  const state = graph.stateRoots[actorRole];
  assert(app && state && within(state, target.stateRoot) &&
    Object.entries(graph.stateRoots).every(([role, root]) => role === actorRole ||
      (state !== root && !within(state, root) && !within(root, state))) &&
    app.mounts.some(m => !m.readOnly && m.source === state && m.target === state) &&
    app.roles.includes(actorRole), "web2_private_study_owned_storage_required");
  for (const path of [selected.issuerFile, asr.authFile]) {
    assert(app.mounts.some(m => m.readOnly && m.target === m.source && within(path, m.source)) &&
      !app.mounts.some(m => !m.readOnly && within(path, m.target)),
      "web2_private_study_readonly_credentials_required");
  }
  assert(selected.issuerFile !== asr.authFile);
}

export async function assertWeb2LocalStudyInputs(selected: Web2LocalStudyPolicy, graph: BootstrapGraph) {
  await privateDirectory(graph.stateRoots[actorRole]!);
  const issuer = await privateFile(selected.issuerFile, 66);
  try {
    const bytes = await issuer.readFile();
    try {
      const key = bytes.toString("utf8");
      assert(/^0x[a-f0-9]{64}$/.test(key) &&
        privateKeyToAccount(key as `0x${string}`).address.toLowerCase() === selected.issuer,
        "web2_private_study_issuer_changed");
    } finally { bytes.fill(0); }
  } finally { await issuer.close(); }
  const auth = await privateFile(selected.asr.authFile, 43);
  try {
    const bytes = await auth.readFile();
    try {
      const value = bytes.toString("ascii");
      assert(/^[A-Za-z0-9_-]{43}$/.test(value) && hashText(value) === selected.asr.authSha256,
        "web2_private_study_asr_auth_changed");
    } finally { bytes.fill(0); }
  } finally { await auth.close(); }
}

/** Build the actual native bindings from the authenticated retained draft.
 * This projection is repeated when reopening an intent or bound release. */
export function withWeb2LocalStudy(
  graph: NativeGraph,
  draft: LinuxWeb2Draft,
  release: Web2BootstrapRelease,
  selected?: Web2LocalStudyPolicy,
  nativeSocket?: string,
): NativeGraph {
  if (!draft.privatePractice) return graph;
  assert(selected && (nativeSocket || graph.fixtureTransport), "web2_private_study_unavailable");
  const { communityId, installationId } = draft.deployment.directoryProfile;
  assert(communityId === draft.enrollment.communityId && installationId === draft.enrollment.installationId &&
    communityId === draft.configuration.communityId && installationId === draft.configuration.installationId,
    "web2_private_study_draft_identity_changed");
  const speechPolicy: SpeechAdmissionPolicy = { ...selected.speech, communityId, telegramTrialUnits: 0 };
  const profile = studyPrivateV5Profile({
    schema: "pirate.study-private-runtime/5", version: 5, chainId: 6343,
    sourceChainId: draft.deployment.directoryProfile.chainId, communityId,
    contract: draft.configuration.postsContract,
    releaseHash: hashJson({ artifact: release.artifactDigest, source: release.sourceDigest,
      actor: release.files[studyModule], localProgram: selected.asr.selectedProgramSha256 }),
    speechPolicyHash: hashJson(speechPolicy),
  });
  const common: NativeBinding[] = [
    { name: "STUDY_PRIVATE_V5_PROFILE", text: canonical(profile) },
    { name: "SPEECH_ADMISSION_CONFIG", text: canonical(speechPolicy) },
    { name: "SPEECH_BUDGET", durable: budget },
  ];
  return {
    ...graph,
    applicationBindings: [...graph.applicationBindings, ...common,
      { name: "COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON", text: canonical({
        schema: "pirate.community-private-practice/1", communityId, installationId,
        deploymentDigest: hashJson(draft.deployment),
        activities: { study: { kind: "private-v5", profileHash: hashJson(profile) }, karaoke: null, dance: null },
      }) },
      { name: "STUDY_RUNTIME", text: "private-v5" },
      { name: "KARAOKE_SERVICE_MODE", text: "internal" },
      { name: "KARAOKE_PAYMENT_CHAIN_ID", text: "6343" },
      { name: "KARAOKE_OPERATOR_ADDRESS", text: selected.operator },
      { name: "KARAOKE_OPERATOR", service },
    ],
    secretBindings: [...graph.secretBindings, { name: issuerBinding, path: selected.issuerFile }],
    actors: [...graph.actors, {
      service, module: studyModule, role: actorRole,
      namespaces: [
        { className: "PrivateStudyState", key: "study-v5-operator-" + graph.durableScope },
        { className: "SpeechBudget", key: "study-speech-budget-" + graph.durableScope },
      ],
      bindings: [...common,
        { name: "PRIVATE_STUDY_STATE", durable: { service, className: "PrivateStudyState" } },
        { name: "COMMUNITY_ID", text: communityId },
        { name: "PAYMENT_CHAIN_ID", text: "6343" },
        { name: "ISSUER", text: selected.issuer },
        { name: "OPERATOR_ADDRESS", text: selected.operator },
        { name: "LOCAL_STUDY_ASR_URL", text: selected.asr.origin + "/transcribe" },
        { name: "LOCAL_STUDY_ASR_AUTH", file: selected.asr.authFile },
        ...(nativeSocket ? [{ name: "LOCAL_STUDY_ASR", service: "web2-local-activities" }] : []),
      ],
    }],
    requiredRoles: [...graph.requiredRoles, actorRole],
    ...(nativeSocket ? { localActivitySocket: nativeSocket } : {
      allowedOrigins: [...graph.allowedOrigins, selected.asr.origin],
      fixtureTransport: { ...graph.fixtureTransport!,
        routes: [...graph.fixtureTransport!.routes, { origin: selected.asr.origin, upstream: selected.asr.upstream }] },
    }),
  };
}
