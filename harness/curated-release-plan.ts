import { readFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { build } from "esbuild";
import { sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  cfLoginToken,
  operatorEnvironment,
  type OperatorOptions,
} from "../apps/community-wizard/server/operator.ts";
import {
  canonical,
  hashJson,
  hashText,
  insist,
} from "../packages/community/common.ts";
import {
  curatedAdmissionId,
  type CuratedAmendment,
} from "../packages/community/curated-amendment.ts";
import { registeredExecutionProfile } from "../packages/community/publication-profile.ts";
import { readMp3Probe } from "../packages/moderation/mp3-windows.ts";
import { getAdmission } from "../packages/moderation/admission-store.ts";
import {
  retainedRecognition,
  originalProviderCalls,
  selectedAdmission,
} from "../packages/moderation/curated-admission.ts";
import { curatedConfigurationPlan } from "./megaeth/curated-configuration-plan.ts";
import {
  curatedDatabases,
  readOnlyRemoteDb,
  qualifyCuratedState,
  type CuratedState,
} from "./curated-state.ts";
import { durableJson } from "./private-json.ts";
import { firstSong } from "../services/first-song-profile.ts";

export const curatedBase = join(
    homedir(),
    ".local/state/pirate-first-song-managed-20261105",
  ),
  curatedReleaseDirectory = join(curatedBase, "curated-release");
export async function curatedCloudContext() {
  const safe = operatorEnvironment(process.env),
    options: OperatorOptions = {
      directory: curatedBase,
      projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
      environment: "staging",
      secretPath: "/communities/first-song-20261105-runner",
      site: "https://app.infisical.com",
      profile: "",
      mode: "cf-login",
      cfProfile: "default",
      port: "8791",
      accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
      check: false,
    },
    token = await cfLoginToken(options, safe);
  return { token, accountId: options.accountId };
}
export async function curatedReleasePlan() {
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8")),
    prefix = "docs/deployments/first-song-managed-20261105.",
    state = (await json(prefix + "held-state.json")) as CuratedState,
    { token, accountId } = await curatedCloudContext();
  await qualifyCuratedState(token, accountId, state, "application");
  await qualifyCuratedState(token, accountId, state, "managed");
  const appDb = readOnlyRemoteDb(
      token,
      accountId,
      curatedDatabases.application,
    ),
    managedDb = readOnlyRemoteDb(token, accountId, curatedDatabases.managed),
    job = (await appDb
      .prepare("SELECT * FROM publication_jobs")
      .first<Record<string, unknown>>())!,
    row = (await appDb
      .prepare("SELECT * FROM media_submissions")
      .first<Record<string, unknown>>())!,
    operation = (await appDb
      .prepare("SELECT * FROM external_operations")
      .first<Record<string, unknown>>())!,
    original = (await managedDb
      .prepare("SELECT * FROM managed_admissions")
      .first<Record<string, unknown>>())!,
    originalAdmission = await getAdmission(
      managedDb,
      String(original.admission_id),
    ),
    calls = await originalProviderCalls(
      managedDb,
      originalAdmission.admission_id,
    ),
    grant = await json(prefix + "owner-curated-grant.json"),
    configuration = (await curatedConfigurationPlan()).profile.manifest,
    originalConfiguration = (await json(prefix + "configuration.json"))
      .configuration,
    application = await json(prefix + "application-plan.json"),
    managed = await json(prefix + "moderation-plan.json"),
    native = await json(prefix + "creator-update-plan-v5.json");
  insist(
    application.profile.releaseGrant.sha256 === grant.sha256 &&
      managed.profile.releaseGrant.sha256 === grant.sha256 &&
      application.profile.creatorProfileHash === native.profileHash &&
      application.profile.managedProfileHash === managed.profileHash,
    "curated_release_peer_plans_changed",
    409,
  );
  const keysPath = join(
      homedir(),
      ".config/pirate-operators/megaeth-testnet/keys.json",
    ),
    keyStat = await lstat(keysPath),
    keysBytes = await readFile(keysPath);
  insist(
    keyStat.isFile() &&
      !(keyStat.mode & 0o077) &&
      keyStat.uid === process.getuid!() &&
      sha256(keysBytes) === managed.profile.registrationCredential.sha256,
    "curated_recognition_key_source_changed",
    409,
  );
  const keys = JSON.parse(keysBytes.toString()),
    signer = privateKeyToAccount(keys.keys.purchaseSigner);
  insist(
    keys.chainId === 6343 &&
      signer.address.toLowerCase() === configuration.policies.moderationSigner,
    "curated_recognition_signer_changed",
    409,
  );
  const recognition = await retainedRecognition(
      managedDb,
      originalAdmission.admission_id,
      signer,
    ),
    client = { origin: firstSong.managedOrigin, configuration },
    execution = registeredExecutionProfile({
      managed: client,
      release: {
        client,
        grantHash: grant.sha256,
        registrationOperator: grant.registration.operator,
      },
      posting: {
        config: configuration,
        profile: {
          ...firstSong.posts,
          deploymentBlock: BigInt(firstSong.posts.deploymentBlock),
        },
        bounds: {
          period: "first-song-20261105-v1",
          maximumGas: "1000000",
          maximumGasPrice: "30000000",
          maximumTotalFee: "30000000000000",
          expiresAt: grant.expiresAt,
        },
      },
    }),
    metadata = JSON.parse(String(row.metadata_json)),
    creator = JSON.parse(String(row.creator_json)),
    authority = JSON.parse(String(job.authority_json));
  insist(
    creator.evm_address === grant.recipient &&
      row.audio_sha256 === grant.contentSha256 &&
      job.phase === "held" &&
      operation.status === "failed" &&
      originalAdmission.state === "held" &&
      metadata.language === "en",
    "curated_release_original_changed",
    409,
  );
  const amendment: CuratedAmendment = {
    schema: "pirate.owner-curated-amendment/1",
    communityId: configuration.communityId,
    jobId: String(job.job_id),
    submissionId: String(row.submission_id),
    postId: String(row.post_id),
    authorId: String(row.author_id),
    ownerWallet: String(row.captured_wallet),
    recipient: grant.recipient,
    contentSha256: grant.contentSha256,
    originalInputHash: String(job.input_hash),
    originalAuthorityHash: hashJson(authority),
    originalRequestHash: String(row.request_hash),
    originalAdmissionId: originalAdmission.admission_id,
    originalAdmissionRequestHash: originalAdmission.request_hash,
    originalPreparedHash: hashJson(
      JSON.parse(originalAdmission.prepared_json!),
    ),
    originalCallsHash: hashJson(calls),
    originalOperationId: String(operation.operation_id),
    originalOperationReceiptHash: hashJson(
      JSON.parse(String(operation.result_json)),
    ),
    originalGrantHash: authority.execution.grantHash,
    originalConfiguration,
    configurationSha256: hashJson(configuration),
    execution,
    recognitionSha256: hashJson(recognition),
    rating: "general",
    language: metadata.language,
    expiresAt: grant.expiresAt,
  };
  const controllerPath = join(
      homedir(),
      ".config/pirate-registry/megaeth-testnet-operator.json",
    ),
    controllerStat = await lstat(controllerPath),
    controllerKey = await json(controllerPath),
    controller = privateKeyToAccount(controllerKey.privateKey);
  insist(
    controllerStat.isFile() &&
      !(controllerStat.mode & 0o077) &&
      controllerStat.uid === process.getuid!() &&
      controllerKey.chainId === 6343 &&
      controller.address.toLowerCase() === configuration.controller,
    "curated_controller_source_changed",
    409,
  );
  const signed = {
      amendment,
      signature: await controller.signMessage({
        message: { raw: hashJson(amendment) },
      }),
    },
    amendmentSha256 = hashJson(signed),
    prepared = JSON.parse(originalAdmission.prepared_json!),
    result = {
      schema: "pirate.owner-admission/1",
      admissionId: curatedAdmissionId(
        configuration.communityId,
        String(job.job_id),
      ),
      amendmentSha256,
      automatedContent: "deferred",
      declarations: {
        source: "operator_declared",
        rating: amendment.rating,
        language: amendment.language,
      },
      evidence: [recognition],
      probe: prepared.probe,
      windows: prepared.windows.map(
        ({
          objectKey,
          byteLength,
          ...facts
        }: {
          objectKey: string;
          byteLength: number;
        }) => facts,
      ),
    };
  await selectedAdmission(managedDb, result.admissionId, configuration, {
    original_admission_id: originalAdmission.admission_id,
    signed_json: canonical(signed),
    result_json: canonical(result),
    amendment_sha256: amendmentSha256,
    created_at: Date.now(),
  });
  const stemFacts: Record<
    string,
    { sha256: string; byteLength: number; durationMs: number }
  > = {};
  for (const [slot, name] of [
    ["instrumental", "Jazzin' Baby Blues (Instrumental).mp3"],
    ["vocals", "Jazzin' Baby Blues (Vocals).mp3"],
  ]) {
    const bytes = await readFile(
        join("/media/t42/codedrive/Songs", "Jazzin' Baby Blues", name!),
      ),
      probe = await readMp3Probe(
        new Blob([bytes]).stream(),
        3600000,
        AbortSignal.timeout(30000),
      );
    stemFacts[slot!] = {
      sha256: sha256(bytes),
      byteLength: bytes.length,
      durationMs: probe.durationMs,
    };
  }
  await mkdir(curatedReleaseDirectory, { recursive: true, mode: 0o700 });
  const privatePlan = join(
    curatedReleaseDirectory,
    `amendment-${amendmentSha256.slice(2)}.json`,
  );
  await durableJson(privatePlan, { signed, result });
  const graph = await build({
      entryPoints: ["harness/curated-release.ts"],
      bundle: true,
      write: false,
      platform: "node",
      packages: "external",
      metafile: true,
      logLevel: "silent",
    }),
    paths = [
      ...new Set([
        ...Object.keys(graph.metafile!.inputs),
        "package.json",
        "package-lock.json",
        ...[
          "application-plan.json",
          "moderation-plan.json",
          "creator-update-plan-v5.json",
          "held-state.json",
          "owner-curated-grant.json",
        ].map((s) => prefix + s),
      ]),
    ]
      .filter((p) => !p.includes("node_modules/"))
      .sort(),
    sourceHashes = Object.fromEntries(
      await Promise.all(
        paths.map(async (p) => [p, hashText(await readFile(p, "utf8"))]),
      ),
    );
  const profile = {
    schema: "pirate.owner-curated-adoption-plan/1",
    communityId: configuration.communityId,
    postId: amendment.postId,
    authorId: amendment.authorId,
    contentSha256: grant.contentSha256,
    configurationSha256: hashJson(configuration),
    amendmentSha256,
    privatePlanSha256: hashJson({ signed, result }),
    applicationProfileHash: application.profileHash,
    managedProfileHash: managed.profileHash,
    nativeProfileHash: native.profileHash,
    applicationBundleSha256: application.profile.bundleSha256,
    managedBundleSha256: managed.profile.bundleSha256,
    nativeBundleSha256: native.profile.artifacts["worker/index.js"],
    nativeWasmSha256: native.profile.artifacts["worker/ika.wasm"],
    grantSha256: grant.sha256,
    state,
    stems: stemFacts,
    sourceHashes,
    bounds: {
      executionSeconds: 900,
      providerRequests: 0,
      newResources: 0,
      admissions: 1,
      publicationJobs: 1,
      publicPins: 5,
      rootRegistrations: 1,
      posts: 1,
      expiresAt: grant.expiresAt,
    },
    acceptance:
      "Explicitly adopt one preserved owner release after exact native/managed/app rollout and both creator stem uploads; queue continues its captured bounded grant.",
  };
  return {
    profile,
    profileHash: hashJson(profile),
    privatePlan,
    signed,
    result,
  };
}
