import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson, object } from "../../packages/community/common.ts";
import { address } from "../../packages/community/manifest-core.ts";
import type { LinuxWeb2Draft, Web2PracticeSelection } from "../../packages/community-setup/linux-web2-profile.ts";
import type { DancePrivatePolicyV2 } from "../../services/dance-private-catalogue.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { Web2BootstrapRelease } from "./installed-release.ts";
import type { InstalledTarget } from "./local-target-controller.ts";
import type { Web2LocalStudyPolicy } from "./web2-local-study.ts";
import { privateDirectory, privateFile } from "./backend-state.ts";

export const karaokeModule = "web2-private-karaoke.worker.mjs";
const karaokeService = "private-karaoke-operator";
const karaokeSessionService = "private-karaoke-session";
const studyService = "private-study-operator";
const nativeHost = "web2-local-activities";
export interface Web2NativeActivityPolicy {
  schema: "pirate.web2-native-activities/1";
  /** One host-owned Unix listener shared by selected activities. */
  socket: string;
  karaoke?: {
    operatorFile: string;
    ingressFile: string;
    community: `0x${string}`;
    token: `0x${string}`;
    modelSha256: `0x${string}`;
    pythonSha256: string;
    scriptSha256: string;
    validFrom: number;
    validUntil: number;
    retentionDays: number;
    /** Optional retained provider response for the disposable local rehearsal. */
    alignmentArchiveSha256?: `0x${string}`;
  };
  dance?: {
    authorityFile: string;
    ffmpegSha256: string;
    ffprobeSha256: string;
    policy: Omit<DancePrivatePolicyV2, "configurationRevision">;
  };
}

type InitialGraph = Omit<NativeGraph, "directoryRuntimeBinding">;
const childOf = (root: string, path: string) => {
  const rel = relative(root, path);
  return path.startsWith("/") && rel.length > 0 && !rel.startsWith("/") && rel !== ".." && !rel.startsWith("../");
};
const activityNames = new Set([
  "PRIVATE_KARAOKE", "KARAOKE_SOCKET_OPERATOR", "KARAOKE_LOCAL_INGRESS", "KARAOKE_LOCAL_TRANSCRIBER",
  "KARAOKE_NATIVE_SESSION_CAPTURE", "KARAOKE_NATIVE_SESSION_SCOPE", "KARAOKE_LOCAL_SESSION_GATE",
  "KARAOKE_NATIVE_SESSION_CAPTURE", "KARAOKE_NATIVE_SESSION_SCOPE", "KARAOKE_LOCAL_SESSION_GATE",
  "KARAOKE_OPERATOR_ORIGIN", "KARAOKE_COMMUNITY_ADDRESS", "KARAOKE_PAYMENT_TOKEN", "KARAOKE_RPC_URL", "KARAOKE_SIGNATURE_CHAIN_ID",
  "PRIVATE_DANCE_POLICY_JSON", "PRIVATE_DANCE_RENDERER", "PRIVATE_DANCE_NATIVE_AUTHORITY", "KARAOKE_ALIGNMENT_ARCHIVE_SHA256",
]);
export function assertNoBootstrapNativeActivities(graph: InitialGraph) {
  assert(!graph.localActivitySocket &&
    !graph.applicationBindings.some(x => activityNames.has(x.name)) &&
    !graph.secretBindings.some(x => activityNames.has(x.name)) &&
    !graph.actors.some(a => a.service === karaokeService || a.service === "private-karaoke-session" || a.role === "private-karaoke" ||
      a.module === karaokeModule || a.bindings.some(x => activityNames.has(x.name))),
    "bootstrap_native_activity_prebinding_refused");
}

export function offeredPractice(study?: Web2LocalStudyPolicy, native?: Web2NativeActivityPolicy): Web2PracticeSelection | undefined {
  if (!study) return undefined;
  if (native?.karaoke && native?.dance) return "study-karaoke-dance-v2";
  if (native?.karaoke) return "study-karaoke-v5";
  if (native?.dance) return "study-dance-v2";
  return "study-v5";
}

async function privateValue(path: string, max: number, verify: (bytes: string) => void) {
  const file = await privateFile(path, max);
  try {
    const bytes = await file.readFile();
    try { verify(bytes.toString("ascii")); } finally { bytes.fill(0); }
  } finally { await file.close(); }
}

export async function validateNativeActivityPolicy(input: {
  policy: Web2NativeActivityPolicy;
  study: Web2LocalStudyPolicy;
  graph: InitialGraph;
  target: InstalledTarget;
  release: Web2BootstrapRelease;
  expiresAt: number;
  mode: "setup" | "retained-dance-owner";
}) {
  const { policy, study, graph, target, release, expiresAt, mode } = input;
  assert(policy.schema === "pirate.web2-native-activities/1" && (policy.karaoke || policy.dance));
  const app = target.containers.find(c => c.key === "application");
  assert(app && childOf(target.stateRoot, policy.socket) &&
    /^\/[a-zA-Z0-9_./-]{1,100}\.sock$/.test(policy.socket) &&
    !policy.socket.split("/").some(part => part === "." || part === "..") &&
    app.mounts.some(m => m.target === m.source && m.readOnly && childOf(m.source, policy.socket)) &&
    !app.mounts.some(m => !m.readOnly && childOf(m.target, policy.socket)), "owned_activity_socket_mount_required");
  await privateDirectory(dirname(policy.socket));
  const socket = await lstat(policy.socket).catch((error: unknown) => {
    // The retained owner enters after foreground drain and opens no listener.
    if (mode === "retained-dance-owner" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (socket) {
    assert(socket.isSocket() && socket.uid === process.getuid!() && (socket.mode & 0o077) === 0 &&
      (await realpath(policy.socket)) === policy.socket, "private_activity_listener_required");
  }
  const fileOwned = (path: string) => app.mounts.some(m => m.target === m.source && m.readOnly && childOf(m.source, path)) &&
    !app.mounts.some(m => !m.readOnly && childOf(m.target, path));
  const token = (value: string) => assert(/^[A-Za-z0-9_-]{43}$/.test(value), "private_activity_credential_changed");
  const distinctFiles = [study.issuerFile, study.asr.authFile];
  if (policy.karaoke) {
    const k = policy.karaoke, root = graph.stateRoots["private-karaoke"];
    assert(root && childOf(target.stateRoot, root) && Object.entries(graph.stateRoots).every(([role, path]) =>
      role === "private-karaoke" || (path !== root && !childOf(path, root) && !childOf(root, path))) &&
      app.roles.includes("private-karaoke") && app.mounts.some(m=>m.source===root && m.target===root && !m.readOnly),
      "private_karaoke_state_mount_required");
    await privateDirectory(root);
    assert(/^[a-f0-9]{64}$/.test(release.files[karaokeModule] ?? "") && fileOwned(k.operatorFile) && fileOwned(k.ingressFile) &&
      /^0x(?!0{64}$)[a-f0-9]{64}$/.test(k.modelSha256) &&
      /^[a-f0-9]{64}$/.test(k.pythonSha256) && /^[a-f0-9]{64}$/.test(k.scriptSha256) &&
      address(k.community) === k.community && address(k.token) === k.token &&
      !/^0x0+$/.test(k.community) && !/^0x0+$/.test(k.token) &&
      Number.isSafeInteger(k.validFrom) && Number.isSafeInteger(k.validUntil) &&
      k.validFrom <= Math.floor(Date.now() / 1000) && k.validUntil > Math.floor(Date.now() / 1000) &&
      k.validUntil <= Math.floor(expiresAt / 1000) && Number.isSafeInteger(k.retentionDays) &&
      k.retentionDays >= 1 && k.retentionDays <= 90, "private_karaoke_scope_required");
    if (k.alignmentArchiveSha256 !== undefined)
      assert(graph.fixtureTransport && policy.dance && /^0x(?!0{64}$)[a-f0-9]{64}$/.test(k.alignmentArchiveSha256),
        "local_karaoke_alignment_replay_scope_required");
    await privateValue(k.operatorFile, 66, key => assert(/^0x[a-f0-9]{64}$/.test(key) &&
      privateKeyToAccount(key as `0x${string}`).address.toLowerCase() === study.operator, "private_karaoke_operator_changed"));
    await privateValue(k.ingressFile, 43, token);
    distinctFiles.push(k.operatorFile, k.ingressFile);
  }
  if (policy.dance) {
    assert(policy.dance.policy.version === "pirate.dance-private-policy/2" &&
      !Object.hasOwn(policy.dance.policy, "configurationRevision") &&
      policy.dance.policy.consent.admission === "admitted" &&
      /^[a-f0-9]{64}$/.test(release.files["sql/0022_dance_private_practice.sql"] ?? "") &&
      /^[a-f0-9]{64}$/.test(policy.dance.ffmpegSha256) && /^[a-f0-9]{64}$/.test(policy.dance.ffprobeSha256) &&
      fileOwned(policy.dance.authorityFile), "selected_private_dance_schema_and_policy_required");
    await privateValue(policy.dance.authorityFile, 43, token);
    distinctFiles.push(policy.dance.authorityFile);
  }
  assert(new Set(distinctFiles).size === distinctFiles.length, "private_activity_role_custody_overlap");
}

export function composeNativeActivities(graph: NativeGraph, draft: LinuxWeb2Draft,
  study?: Web2LocalStudyPolicy, scoped?: Web2NativeActivityPolicy): NativeGraph {
  if (!draft.privatePractice || draft.privatePractice === "study-v5") return graph;
  assert(study && scoped && draft.privatePractice === offeredPractice(study, scoped), "native_activity_original_changed");
  const app = graph.applicationBindings;
  const find = (name: string) => app.find(x => x.name === name)!;
  const profile = object(JSON.parse(find("COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON").text!));
  const activities = object(profile.activities);
  const studySelection = object(activities.study);
  if (scoped.karaoke) {
    const k = scoped.karaoke;
    activities.karaoke = studySelection;
    app.push({ name: "KARAOKE_SOCKET_OPERATOR", service: karaokeService },
      { name: "KARAOKE_NATIVE_SESSION_CAPTURE", durable: {service:karaokeSessionService,className:"NativeKaraokeSessions"} },
      { name: "KARAOKE_OPERATOR_ORIGIN", text: draft.origin },
      { name: "KARAOKE_COMMUNITY_ADDRESS", text: k.community },
      { name: "KARAOKE_PAYMENT_TOKEN", text: k.token },
      { name: "KARAOKE_RPC_URL", text: draft.deployment.rpcUrl },
      { name: "KARAOKE_SIGNATURE_CHAIN_ID", text: "6343" });
    // Payment token is a public contract address. The renderer distinguishes this
    // exact binding from credential-bearing TOKEN variables.
    graph.secretBindings.push({ name: "KARAOKE_LOCAL_INGRESS", path: k.ingressFile });
    if (k.alignmentArchiveSha256)
      app.push({ name: "KARAOKE_ALIGNMENT_ARCHIVE_SHA256", text: k.alignmentArchiveSha256 });
    const studyActor = graph.actors.find(a => a.service === studyService)!;
    studyActor.bindings.push({ name: "PRIVATE_KARAOKE", service: karaokeService });
    graph.actors.push({ service: karaokeService, module: karaokeModule, role: "private-karaoke",
      namespaces: [{ className: "ServiceState", key: "private-karaoke-" + graph.durableScope }],
      bindings: [find("STUDY_PRIVATE_V5_PROFILE"), find("SPEECH_ADMISSION_CONFIG"), find("SPEECH_BUDGET"),
        { name: "STATE", durable: { service: karaokeService, className: "ServiceState" } },
        { name: "KARAOKE_LOCAL_SESSION_GATE", service: karaokeSessionService },
        { name: "KARAOKE_LOCAL_TRANSCRIBER", service: nativeHost },
        { name: "PRIVATE_KEY", file: k.operatorFile }, { name: "KARAOKE_LOCAL_INGRESS", file: k.ingressFile },
        ...Object.entries({ ROLE: "operator", SERVICE_MODE: "internal", LOCAL_ONLY: "pirate-local-skeleton",
          COMMUNITY_ID: draft.configuration.communityId, COMMUNITY_DOMAIN: new URL(draft.origin).hostname,
          ISSUER: study.issuer, OPERATOR_ADDRESS: study.operator, COMMUNITY_ADDRESS: k.community,
          PAYMENT_TOKEN: k.token, PAYMENTS_CONTRACT: draft.configuration.operatorPayments,
          PAYMENT_CHAIN_ID: "6343", SIGNATURE_CHAIN_ID: "6343", CUTOFF: "0",
          QUOTE_VALID_FROM: String(k.validFrom), QUOTE_VALID_UNTIL: String(k.validUntil),
          HISTORY_RETENTION_DAYS: String(k.retentionDays), KARAOKE_PRIVATE_PROFILE: String(studySelection.profileHash),
          KARAOKE_LOCAL_MODEL_SHA256: k.modelSha256, KARAOKE_LOCAL_BROWSER_ORIGIN: draft.origin,
        }).map(([name, text]) => ({ name, text }))],
    });
    graph.requiredRoles.push("private-karaoke");
  }
  if (scoped.dance) {
    const doc: DancePrivatePolicyV2 = { ...scoped.dance.policy, configurationRevision: draft.configuration.configurationRevision };
    activities.dance = { kind: "private-v2", policyHash: hashJson(doc) };
    app.push({ name: "PRIVATE_DANCE_POLICY_JSON", text: canonical(doc) }, { name: "PRIVATE_DANCE_RENDERER", service: nativeHost });
    graph.secretBindings.push({ name: "PRIVATE_DANCE_NATIVE_AUTHORITY", path: scoped.dance.authorityFile });
  }
  find("COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON").text = canonical(profile);
  return graph;
}
