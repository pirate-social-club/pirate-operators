import {linuxDraftFrom} from "../packages/community-setup/shared-linux-profile.ts";
import {fixtureShared} from "./community-wizard-linux-shared-fixture.ts";
import {exactNamespaceProof} from "../apps/community-wizard/server/shared-namespace-port.ts";
// Controlled adapter protocol fixture only. This is not encryption, SSH,
// naming authority, Alchemy, runtime portability or second-host acceptance.
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLinuxSetup } from "../apps/community-wizard/server/linux-setup.ts";
import { digestJson } from "../apps/community-wizard/server/linux-journal.ts";
import type {
  LinuxDeploymentPort,
  NamespaceAuthorityPort,
  LinuxCapabilities,
  LinuxObservation,
  LinuxOperation,
  LinuxOperationResult,
  LinuxDeploymentIntent,
  LinuxRestoreIntent,
  LinuxPlan,
  NamespaceProof,
  NamespaceAuthorityResult,
  CredentialRequirement,
} from "../apps/community-wizard/server/linux-contracts.ts";
import type {
  LinuxCommunityProfileV2,
  LinuxDraftV2,
} from "../packages/community-setup/shared-linux-profile.ts";
export const fixtureHash = (s: string) =>
  `0x${createHash("sha256").update(s).digest("hex")}`;
export const fixtureKey = "fixture-separate-recovery-key-never-real";
export const fixtureCiphertext = Buffer.from(
  "controlled encrypted-byte transport fixture; not real backup encryption",
);
export const fixtureDraft = (slug = "fixture-community"): LinuxDraftV2 => ({
  version: 2,
  infrastructure: "pirate.shared-directory/2",
  mode: "create",
  name: "Fixture community",
  slug,
  origin: `https://${slug}.example`,
  target: { kind: "local-linux" },
  namespace: { tld: "fixture" },
  features: {
    learning: false,
    karaoke: false,
    media: false,
    dance: false,
    telegram: false,
  },
  services: {
    publicationProfile: "publication:verified",
    learningProfile: null,
  },
  storage: {
    publicMedia: { version: 1, role: "public-ipfs", provider: "filebase-ipfs" },
    privateData: { provider: "local-volume" },
    backup: {
      version: 1,
      role: "backup",
      provider: "filebase-private",
      bucket: "fixture-recovery",
      endpoint: "https://s3.filebase.io",
      region: "auto",
      forcePathStyle: false,
    },
  },
  limits: {
    speechDaily: 100,
    websiteReserved: 50,
    perAccountDaily: 10,
    monthlyUsdCents: 1000,
  },
  recovery: { sessionPolicy: "revoke-existing" },
});
export function fixtureProfile(
  draft = fixtureDraft(),
): LinuxCommunityProfileV2 {
  const shared=fixtureShared(draft);
  return {
    schema: "pirate.community-linux-profile/2",
    settings: structuredClone(draft),
    identity: shared.identity,
    runtime: {
      sourceDigest: fixtureHash("source"),
      artifactDigest: fixtureHash("actual-fixture-artifact"),
      recipe: "fixture-recipe:1",
      migrations: { "0001_setup.sql": fixtureHash("fixture-sql") },
    },
    learning: draft.features.learning
      ? {
          profileId: "learning:verified",
          configurationDigest: fixtureHash("learning-config"),
          operatorOrigin: "https://learning.example",
          communityOrigin: draft.origin,
          resultsContract: `0x${"11".repeat(20)}`,
          chainId: 6343,
          issuer: `0x${"22".repeat(20)}`,
          operator: `0x${"33".repeat(20)}`,
          codeHash: fixtureHash("results-code"),
          secretRefs: {
            speech: "managed:speech",
            operator: "managed:operator",
            issuer: "managed:issuer",
          },
          activation: {
            totalWei: "10000",
            accountWei: "1000",
            accounts: 10,
            gasPriceWei: "1",
            gasLimit: "100",
            dataFeeWei: "1",
          },
        }
      : null,
    namespace: shared.proof,
    infrastructure: shared.infrastructure,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export async function linuxFixture(
  options: { slug?: string; timeoutMs?: number; uploadTimeoutMs?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pirate-wizard-linux-unit-"));
  const draft = fixtureDraft(options.slug),
    clock = { now: 2_000_000_000_000 };
  const facts = {
    executes: [] as LinuxOperation[],
    reconciles: [] as LinuxOperation[],
    credentialValues: {} as Record<string, string>,
    credentialState: "missing" as "missing" | "saved" | "verified",
    authority: "verified" as NamespaceAuthorityResult["status"],
    revision: 1,
    nativeIntents: [] as Array<LinuxDeploymentIntent | LinuxRestoreIntent>,
    lostSave: false,
    lostUpload: false,
    existing: [] as LinuxCommunityProfileV2[],
    restoreProfile: fixtureProfile(draft),
  };
  const requirement = (): CredentialRequirement[] => [
    {
      id: "ELEVENLABS_API_KEY",
      label: "Community speech key",
      role: "speech",
      scope: `community/${draft.slug}/speech`,
      state: facts.credentialState,
      correction: "Verify this selected service.",
    },
  ];
  const capabilities: LinuxCapabilities = {
    version: 2,
    adapterId: "fixture:linux",
    sourceDigest: fixtureHash("source"),
    targets: ["local-linux", "ssh-linux"],
    operations: ["create", "import", "restore", "upgrade"],
    features: ["learning", "karaoke", "media", "dance", "telegram"],
    backup: {
      formats: ["fixture-encrypted-v1"],
      maxBytes: 1_000_000,
      sessionPolicies: ["revoke-existing", "preserve-existing"],
    },
    publicationSelection: "publication:verified",
    publicationProfiles: [
      {
        id: "publication:verified",
        label: "Fixture verified publication",
        verified: true,
      },
    ],
    learningProfiles: [
      {
        id: "learning:verified",
        label: "Fixture verified Learning",
        verified: true,
      },
    ],
    sshConnections: [{ id: "ssh:owned", label: "Owned fixture host" }],
    backupProfiles: [
      {
        id: "backup:filebase",
        label: "Fixture Filebase transport",
        profile: draft.storage.backup,
      },
    ],
    limitations: ["Controlled test adapters; no runtime qualification."],
    policy:{schema:"pirate.operator-policy-view/1",speech:{contractId:"fixture-speech-v1",unitLabel:"fixture admission unit",definition:"Controlled admission-unit contract; not provider billing."},
      providerBudget:{proposalUsdCents:1000,enforcement:"operator-stop",coveredServices:["fixture-speech"],excludedServices:["gas","storage","hosting"],evidenceRef:"fixture-stop-evidence"},
      freeNames:null},
  };
  const uploads = new Map<
    string,
    { backupId: string; ciphertextDigest: string }
  >();
  const proof = (tld:string):NamespaceAuthorityResult => facts.authority!=="verified"
    ? {tld,status:facts.authority,correction:"Wait for current authority reconciliation."}
    : {...fixtureProfile({...draft,namespace:{tld}}).namespace,status:"verified",tld,correction:"Controlled external proof only."};
  const success = (
    op: LinuxOperation,
    revision = ++facts.revision,
  ): LinuxObservation => ({
    state: "succeeded",
    custody: "cleared",
    revision,
    receiptRef: `receipt:${op.id}`,
    identity: op.plan.profile.identity,
    profileDigest: op.plan.profileDigest,
    recovery:
      op.kind === "restore"
        ? {
            inspectionId: op.plan.restoreInspectionId!,
            manifestDigest: op.plan.restoreManifestDigest!,
            sessionPolicy: op.plan.sessionPolicy,
          }
        : null,
    sharedConfiguration:{directory:op.plan.profile.infrastructure.directory,configuration:op.plan.profile.infrastructure.configuration,
      evidenceRef:"fixture-canonical-reader",blockNumber:"1",blockHash:fixtureHash("fixture-canonical-block")},
    health: {
      origin: op.plan.profile.settings.origin,
      application: true,
      login: true,
      media: true,
      learning: true,
      checkedAt: clock.now,
    },
  });
  const registered = new Map<string, LinuxOperation>();
  const evidence = (relativePath: string) => ({
    relativePath,
    sha256: fixtureHash(relativePath).slice(2),
  });
  const result = (operationId: string): LinuxOperationResult => ({
    operationId,
    outcome: "completed",
    lastCompletedPhase: "fixture-observation",
    unrunPhases: [],
    resources: Object.values(
      registered.get(operationId)!.plan.profile.identity.resources,
    ).map((resourceKey) => ({
      resourceKey,
      intentId: operationId,
      targetIdentityDigest:
        registered.get(operationId)!.plan.backend.target.endpointIdentityDigest,
      disposition: "owned-present" as const,
      evidence: evidence(`receipts/${operationId}.json`),
    })),
    ownedProcesses: [],
    rawReceipt: evidence(`receipts/${operationId}.json`),
    postguard: evidence(`postguard/${operationId}.json`),
    cleanup: evidence(`cleanup/${operationId}.json`),
  });
  const backend: LinuxDeploymentPort = {
    version: 2,
    journalRecovery:{policy:"pirate.linux-journal-capacity/1",sourceDigest:capabilities.sourceDigest,resultMaxBytes:524288,intentMaxBytes:262144,
      async terminal({operation}){return {state:"result",result:result(operation.id)};}},
    operator: {
      async deploy(intent) {
        facts.nativeIntents.push(structuredClone(intent));
        facts.executes.push(
          structuredClone(registered.get(intent.operationId)!),
        );
        return result(intent.operationId);
      },
      async restore(intent) {
        facts.nativeIntents.push(structuredClone(intent));
        facts.executes.push(
          structuredClone(registered.get(intent.operationId)!),
        );
        return result(intent.operationId);
      },
      async reconcile(request) {
        facts.reconciles.push(
          structuredClone(registered.get(request.operationId)!),
        );
        return result(request.operationId);
      },
    },
    async capabilities() {
      return structuredClone(capabilities);
    },
    async inspectTarget({ target }) {
      return {
        id: "target:fixture",
        target,
        fingerprint: "fixture-host-fingerprint",
        supported: true,
        description: "Controlled Linux fixture target",
        corrections: [],
        existing: structuredClone(facts.existing),
        prepared: (()=>{const profile=fixtureProfile(linuxDraftFrom(activeSetup?.snapshot().draft ?? {...draft,target}));return {identity:profile.identity,infrastructure:profile.infrastructure,settings:profile.settings};})(),
      };
    },
    async credentialRequirements({ draft }) {
      return draft.features.learning ? requirement() : [];
    },
    async saveCredentials({ values }) {
      facts.credentialValues = { ...values };
      facts.credentialState = "saved";
      if (facts.lostSave)
        throw Error("raw private provider response must not escape");
    },
    async reconcileCredentials({ draft }) {
      return {
        state: "saved",
        requirements: draft.features.learning ? requirement() : [],
      };
    },
    async verifyCredentials({ draft }) {
      facts.credentialState = "verified";
      return draft.features.learning ? requirement() : [];
    },
    async stageBackup({ requestId, bytes }) {
      const chunks: Uint8Array[] = [];
      for await (const part of bytes) chunks.push(part);
      const ciphertextDigest = `0x${createHash("sha256").update(Buffer.concat(chunks)).digest("hex")}`;
      const old = uploads.get(requestId);
      if (old && old.ciphertextDigest !== ciphertextDigest)
        throw Error("immutable upload identity conflict");
      const receipt = old ?? {
        backupId: `backup:${requestId}`,
        ciphertextDigest,
      };
      uploads.set(requestId, receipt);
      if (facts.lostUpload) throw Error("lost upload reply");
      return receipt;
    },
    async inspectBackup({ backupId, recoveryKey }) {
      if (recoveryKey !== fixtureKey)
        throw Error(`untrusted error ${recoveryKey}`);
      const upload = [...uploads.values()].find((v) => v.backupId === backupId);
      if (!upload) throw Error("missing bytes");
      return {
        id: "restore:fixture",
        backupId,
        ciphertextDigest: upload.ciphertextDigest,
        manifestDigest: fixtureHash(
          "complete-session-revocation-and-data-manifest",
        ),
        format: "fixture-encrypted-v1",
        authenticated: true,
        compatible: true,
        profile: structuredClone(facts.restoreProfile),
        sessionPolicies: ["revoke-existing", "preserve-existing"],
        corrections: [],
      };
    },
    async prepare(input) {
      const profile = fixtureProfile(input.draft);
      if (input.retainedIdentity)
        profile.identity = structuredClone(input.retainedIdentity);
      profile.namespace = exactNamespaceProof(input.namespace);
      profile.infrastructure.binding = profile.namespace.binding;
      const preimage: Omit<LinuxPlan, "digest"> = {
        id: `plan:${input.requestId}`,
        profileDigest: digestJson(profile),
        expiresAt: clock.now + 60000,
        backend: {
          target: {
            endpointRef: "endpoint:fixture",
            endpointIdentityDigest: digestJson({
              target: input.draft.target,
              origin: input.draft.origin,
              communityId: profile.identity.communityId,
            }),
            stateNamespace: `state:${input.draft.slug}`,
            deploymentId: profile.identity.deploymentId,
          },
          release: {
            sourceHead: "a88ae60e6c5b85df8799d0ad0c52333ab4f43784",
            sourceTree: "1".repeat(40),
            manifest: evidence("sealed/fixture-complete-profile.json"),
            selectedProfileDigest: digestJson(profile),
            requiredServices: [
              "application",
              "assets",
              "login",
              "publication",
              "sql",
              "objects",
              "jobs",
              "scheduler",
              "https",
              "backup",
              ...(input.draft.features.learning ? ["learning"] : []),
            ],
          },
        },
        profile,
        operatorPolicy:structuredClone(capabilities.policy),
        targetInspectionId: input.target.id,
        targetFingerprint: input.target.fingerprint,
        namespaceProofId: input.namespace.id,
        action:
          input.draft.mode === "restore"
            ? "restore"
            : input.draft.mode === "import"
              ? "adopt"
              : input.previousOperation
                ? "upgrade"
                : "create",
        changes: [
          "Full application and selected services under original identities",
        ],
        warnings: ["Mocked lifecycle receipt is not deployment acceptance."],
        requirements: input.draft.features.learning ? requirement() : [],
        restoreInspectionId: input.restore?.id ?? null,
        restoreManifestDigest: input.restore?.manifestDigest ?? null,
        restoreCiphertextDigest: input.restore?.ciphertextDigest ?? null,
        predecessorOperationId: input.previousOperation?.id ?? null,
        sessionPolicy: input.draft.recovery.sessionPolicy,
      };
      return { ...preimage, digest: digestJson(preimage) };
    },
    async bindOperation(op) {
      registered.set(op.id, structuredClone(op));
      if (op.kind === "restore")
        return {
          kind: "restore",
          intent: {
            operationId: op.id,
            journalRevision: 1,
            freshTarget: op.plan.backend.target,
            encryptedCohortManifest: {
              relativePath: "backups/cohort.json",
              sha256: op.plan.restoreManifestDigest!.replace(/^0x/, ""),
            },
            transportConfiguration: evidence("sealed/transport.json"),
            transportCredentialRef: {
              storeId: "store:fixture",
              keyId: "backup:fixture",
              generation: 1,
            },
            recoveryKeyRef: {
              storeId: "store:transient",
              keyId: "recovery:fixture",
              generation: 1,
            },
            compatibleRelease: op.plan.backend.release,
            revocationPolicyDigest: digestJson(op.plan.sessionPolicy),
            executionBoundSeconds: 1,
          },
        };
      return {
        kind: "deploy",
        intent: {
          operationId: op.id,
          journalRevision: 1,
          target: op.plan.backend.target,
          planDigest: op.plan.digest,
          draftRevision: op.draftRevision,
          release: op.plan.backend.release,
          appOrigin: op.plan.profile.settings.origin,
          importedAuthorityRefs: [evidence("authority/fixture.json")],
          desiredConfiguration: evidence("sealed/configuration.json"),
          serviceSecretRefs: [],
          resourceKeys: Object.values(op.plan.profile.identity.resources),
          executionBoundSeconds: 1,
        },
      };
    },
    async bindReconciliation({ operation }) {
      registered.set(operation.id, structuredClone(operation));
      return {
        operationId: operation.id,
        journalRevision: 2,
        target: operation.plan.backend.target,
        intents: [evidence(`intents/${operation.id}.json`)],
        executionBoundSeconds: 1,
      };
    },
    async observeResult({ operation, result: raw }) {
      return raw.outcome === "completed"
        ? success(operation)
        : {
            revision: ++facts.revision,
            custody: "held",
            state: "unknown",
            receiptRef: `receipt:${operation.id}`,
            correction: "Fixture unresolved evidence",
          };
    },
  };
  const naming: NamespaceAuthorityPort = {
    version:3,
    assertWritable(){/* Controlled fixture only; production requires real durable caller service. */},
    async begin(){throw new Error("Actual proof collector is not installed in this fixture.");},
    async complete(){throw new Error("Actual proof collector is not installed in this fixture.");},
    async recover(){return {state:"pending"};},
    async inspect({ tld }) {
      const p=fixtureProfile({...linuxDraftFrom(activeSetup.snapshot().draft!),namespace:{tld}});return facts.authority==="verified"?{...p.namespace,status:"verified",tld,correction:"Controlled external proof only."}:proof(tld);
    },
    async revalidate({ proof: p }) {
      return facts.authority==="verified"?{...p,status:"verified",tld:p.binding.issuanceTld,correction:"Controlled external proof only."}:proof(p.binding.issuanceTld);
    },
  };
  let activeSetup:Awaited<ReturnType<typeof createLinuxSetup>>;
  const open = async () => {
    const result=await createLinuxSetup(directory,backend,naming,{now:()=>clock.now,timeoutMs:options.timeoutMs??100,uploadTimeoutMs:options.uploadTimeoutMs});
    activeSetup=result;return result;
  };
  const setup = await open();
  const configure = async (value = draft) => {
    await setup.configure({
      revision: setup.snapshot().revision,
      draft: value,
    });
    await setup.inspect();
    await setup.namespace();
  };
  const review = async () => {
    await setup.review();
    return setup.snapshot().plan!;
  };
  const deploy = async (plan = setup.snapshot().plan!) => {
    await setup.deploy({
      revision: setup.snapshot().revision,
      planDigest: plan.digest,
      targetFingerprint: plan.targetFingerprint,
      approved: true,
    });
  };
  return {
    directory,
    draft,
    clock,
    facts,
    capabilities,
    backend,
    naming,
    setup,
    open,
    configure,
    review,
    deploy,
    success,
    result,
    registered,
    evidence,
    disk: () => readFile(join(directory, "linux-setup-v2.json"), "utf8"),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
