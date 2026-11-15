import { sha256, type Hex } from "viem";
import { firstSongGrant, releaseGrantPath } from "./first-song-upgrade.ts";
import { ownedModuleGraph } from "./owned-module-graph.ts";
import { lstat, realpath, readFile, copyFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { privateDirectory } from "../apps/community-wizard/server/state.ts";
import { bytes32, canonical, exact, hashJson, hashText, insist, object, text } from "../packages/community/common.ts";

export const managedPrefix = "pirate-managed-firstsong-20261105";
export const managedOrigin = `https://${managedPrefix}.piratesocialclub.workers.dev`;
import { MANAGED_MIGRATIONS, managedMigrations } from "./package-migrations.ts";
import { managedUpdate } from "./managed-update-pin.ts";
import { publishedStateRepairPath } from "./published-state.ts";
import {
  linkRetainedDependencies,
  managedDependencyModules,
  verifyManagedDependencies,
} from "./community-dependencies.ts";
import {
  managedPublishingProfile,
  publishingReleaseSelection,
  type PublishingReleaseSelection,
} from "./publishing-release-profile.ts";
/** Default builds are the deployed registered profile; owner publishing adds 0004. */
export async function managedPackage(
  options: { publishing?: PublishingReleaseSelection } = {},
) {
  const publishing = options.publishing
    ? publishingReleaseSelection(options.publishing)
    : undefined;
  const migrations = managedMigrations(!!publishing);
  // The retained binary is the one the managed deployment runs.
  const cli = await promisify(execFile)(
    join(managedDependencyModules, ".bin/alchemy"),
    ["--version"],
    {
      cwd: resolve("apps/managed-moderation"),
      timeout: 30000,
      maxBuffer: 65536,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "true",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      },
    },
  );
  insist(/2\.0\.0-beta\.85/.test(cli.stdout), "managed_cli_version_mismatch");
  const bundle = await build({
    entryPoints: ["services/managed-moderation.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2024",
    external: ["node:*"],
    minify: true,
    metafile: true,
    logLevel: "silent",
    legalComments: "none",
  });
  const bytes = bundle.outputFiles![0]!.contents;
  const operations = await build({
    entryPoints: ["harness/managed-service.ts"],
    bundle: true,
    write: false,
    platform: "node",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  const files = [
    ...(await ownedModuleGraph("harness/published-replay.ts")),
    ...Object.keys(operations.metafile!.inputs).filter(
      (p) => !p.includes("node_modules/"),
    ),
    ...Object.keys(bundle.metafile!.inputs).filter(
      (p) => !p.includes("node_modules/"),
    ),
    "harness/published-replay.ts",
    "package.json",
    "package-lock.json",
    "apps/managed-moderation/package.json",
    "apps/managed-moderation/package-lock.json",
    "apps/managed-moderation/alchemy.run.ts",
    "apps/managed-moderation/encrypted-state.ts",
    "apps/managed-moderation/protected-data.ts",
    ...migrations.map((name) => `apps/managed-moderation/migrations/${name}`),
    "docs/deployments/first-song-managed-20261105.published-state.json",
    publishedStateRepairPath,
    releaseGrantPath,
    "docs/deployments/first-song-managed-20261105.dedicated-signer-readiness.json",
    "apps/community-wizard/infra/encrypted-state.ts",
    "apps/community-wizard/infra/protected-data.ts",
    "apps/community-wizard/server/infisical-auth.ts",
    "apps/community-wizard/server/operator.ts",
    "apps/community-wizard/server/state.ts",
    "apps/community-wizard/server/model.ts",
    "apps/community-wizard/server/state-inspection.ts",
    "apps/community-wizard/server/diagnostics.ts",
    "apps/community-wizard/package-lock.json",
    "harness/managed-package.ts",
    "harness/managed-update-pin.ts",
    "harness/managed-service.ts",
    "harness/managed-inventory.ts",
    "harness/managed-update.ts",
    "harness/worker-modules.ts",
    "docs/deployments/first-song-managed-20261105.moderation-plan-v1.json",
    "docs/deployments/first-song-managed-20261105.moderation-setup.json",
    "docs/deployments/first-song-managed-20261105.moderation-plan-v9.json",
    "docs/deployments/first-song-managed-20261105.owner-publishing-rollout.json",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      [...new Set(files)]
        .sort()
        .map(async (path) => [path, hashText(await readFile(path, "utf8"))]),
    ),
  );
  const contracts = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.contracts.json",
      "utf8",
    ),
  );
  const pairings = [
    {
      communityId: contracts.communityId,
      registry: contracts.registry.address,
      directory: contracts.directory.address,
      controller: contracts.registry.admin.toLowerCase(),
      communityOrigin: contracts.profile.origin,
      serviceOrigin: managedOrigin,
      enabled: true,
      budgetPeriod: "first-song-20261105-v1",
      requestCap: 24,
    },
  ];
  const directoryProfiles = [
    {
      chainId: 6343,
      communityId: contracts.communityId,
      registry: contracts.registry.address,
      directory: contracts.directory.address,
      deploymentBlock: contracts.directory.blockNumber,
      directoryCodeHash: contracts.directory.runtimeCodeHash,
    },
  ];
  const releaseGrant = await firstSongGrant();
  const base = {
    schema: "pirate.managed-service-plan/1",
    accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
    prefix: managedPrefix,
    origin: managedOrigin,
    update: managedUpdate,
    resources: {
      worker: managedPrefix,
      database: `${managedPrefix}-db`,
      media: `${managedPrefix}-media`,
      jobs: `${managedPrefix}-jobs`,
      consumer: managedPrefix,
    },
    sourceHashes: hashes,
    releaseGrant,
    curatedState: JSON.parse(
      await readFile(
        "docs/deployments/first-song-managed-20261105.published-state.json",
        "utf8",
      ),
    ),
    // The reviewed managed-state successor; the published state stays as is.
    curatedStateRepair: JSON.parse(
      await readFile(publishedStateRepairPath, "utf8"),
    ),
    registrationCredential: {
      ...JSON.parse(
        await readFile(
          "docs/deployments/first-song-managed-20261105.dedicated-signer-readiness.json",
          "utf8",
        ),
      ).source,
      targetChain: 1315,
    },
    migrations,
    bundleSha256: hashText(bundle.outputFiles![0]!.text),
    bundleBytes: bytes.length,
    pairings,
    directoryProfiles,
    moderationSigner: "0xa67ac40bc3d5e1b25d7da5ca2e8585f335a37329",
    serviceBudgetPeriod: "first-song-20261105-v1",
    serviceRequestCap: 24,
    acrHost: "identify-eu-west-1.acrcloud.com",
    providerCredentials: {
      projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
      environment: "staging",
      sourcePath: "/services/api-next",
      targetPath: `/services/${managedPrefix}`,
    },
    stateProtection: {
      projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
      environment: "staging",
      path: "/communities/first-song-20261105-runner",
    },
    secretNames: [
      "ACRCLOUD_ACCESS_KEY",
      "ACRCLOUD_ACCESS_SECRET",
      "OPENAI_API_KEY",
      "MODERATION_SIGNER_PRIVATE_KEY",
      "FILEBASE_IPFS_TOKEN",
      "REGISTRATION_OPERATOR_PRIVATE_KEY",
    ],
    bounds: {
      executionSeconds: 900,
      healthSeconds: 60,
      providerRequests: 24,
      registrationTransactions: 1,
      publicPins: 5,
      maximumRegistrationFee: releaseGrant.registration.maximumTotalFee,
      paymentDeposits: 0,
    },
    recovery:
      "Keep the same encrypted Alchemy state and D1 provider journals. Reconcile task-owned resources after an interrupted apply. Unknown paid provider sends cannot be replayed.",
  };
  // Owner publishing replaces the registered grant and registration signer
  // requirements with the owner grant; the rest of the profile is unchanged.
  const profile = (
    publishing ? managedPublishingProfile(base, publishing) : base
  ) as typeof base & {
    ownerGrant?: PublishingReleaseSelection["ownerGrant"];
    signerSource?: Record<string, unknown>;
  };
  return { profile, profileHash: hashJson(profile), bytes };
}
export async function writeManagedPackage(
  directory: string,
  bytes: Uint8Array,
  migrations: readonly string[] = MANAGED_MIGRATIONS,
  // The retained dependency tree the preservation record names for this runner.
  dependencies: { modules: string; verify(): Promise<void> } = {
    modules: managedDependencyModules,
    verify: verifyManagedDependencies,
  },
) {
  const cwd = join(directory, "deployment");
  for (const path of [
    directory,
    cwd,
    join(cwd, "worker"),
    join(cwd, "migrations"),
  ])
    await privateDirectory(path);
  await writeFile(
    join(cwd, "package.json"),
    '{"private":true,"type":"module"}\n',
    { mode: 0o600 },
  );
  const source = await readFile(
    "apps/managed-moderation/alchemy.run.ts",
    "utf8",
  );
  await writeFile(join(cwd, "alchemy.run.ts"), source, { mode: 0o600 });
  await writeFile(join(cwd, "worker/worker.mjs"), bytes, { mode: 0o600 });
  for (const name of migrations)
    await copyFile(
      `apps/managed-moderation/migrations/${name}`,
      join(cwd, "migrations", name),
    );
  for (const file of ["encrypted-state.ts", "protected-data.ts"])
    await copyFile(`apps/managed-moderation/${file}`, join(cwd, file));
  await linkRetainedDependencies(join(cwd, "node_modules"), dependencies);
  return cwd;
}

import { managedPublishingConfiguration, type ManagedPublishingConfiguration } from "../packages/release/managed-publishing-admission.ts";
import { trustedRecognitionConfiguration, type SharedRecognitionConfiguration } from "../services/shared-recognition-configuration.ts";
import type { SignedRecord, TrustAnchor } from "../deploy/linux/installed-records.ts";

/** Separate fresh-service selection. The deployed historical plan above is never
 * rewritten. Migration names are supplied by integration after ordinal review. */
export async function managedWeb2ServicesPackage(input: {
  prefix: string; planId: Hex; operatorSigning?: OperatorSigningBuildInputs; publishing: ManagedPublishingConfiguration;
  recognition: SignedRecord<SharedRecognitionConfiguration>; trust: TrustAnchor;
  admissionMigrationName: string; recognitionMigrationName: string;
}) {
  const selected = structuredClone(input), identity = managedFreshStackIdentity({ prefix: input.prefix, planId: input.planId,
    packageProfile: "managed-web2", state: { store: "pirate-encrypted-local", stack: input.prefix } });
  await verifyManagedDependencies();
  const publishing = managedPublishingConfiguration(selected.publishing, selected.trust),
    recognition = trustedRecognitionConfiguration(selected.recognition, selected.trust);

  for (const name of [selected.admissionMigrationName, selected.recognitionMigrationName])
    insist(/^[0-9]{4}_[a-z0-9_-]+\.sql(?![\s\S])/.test(name), "reviewed_schema_migration_name_required");
  const migrations = managedMigrations(true);
  insist(!migrations.includes(selected.admissionMigrationName), "managed_migration_name_conflict");
  insist(recognition.communities.every(r => publishing.registrations.some(p => hashJson(p) === hashJson(r))),
    "managed_recognition_admission_changed");
  const bundles = await Promise.all(["services/managed-publishing-worker.ts", "services/shared-recognition-worker.ts"].map(entry => build({
    entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "esm", target: "es2024",
    external: ["node:*"], minify: true, metafile: true, logLevel: "silent", legalComments: "none",
  })));
  const helper = selected.operatorSigning ? await pinnedOperatorSigningAssets(selected.operatorSigning) : null;
  const sources = [...new Set([
    ...(await ownedModuleGraph("harness/managed-package.ts")),
    ...bundles.flatMap(b => Object.keys(b.metafile!.inputs).filter(p => !p.includes("node_modules/"))),
    "packages/release/schema/managed-publishing-admission.sql", "packages/recognition/schema.sql",
    "apps/managed-moderation/alchemy.run.ts", "apps/managed-moderation/encrypted-state.ts", "apps/managed-moderation/protected-data.ts",
    "apps/managed-moderation/package.json", "apps/managed-moderation/package-lock.json", "package.json", "package-lock.json",
    ...migrations.map(name => "apps/managed-moderation/migrations/" + name),
    "docs/self-hosting/managed-first-song-services.md",
  ])].sort();
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async p => [p, hashText(await readFile(p, "utf8"))])));
  const profile = { schema: "pirate.managed-web2-services-package/1", packageProfile: "managed-web2" as const, prefix: selected.prefix, identity,
    operatorSigning: helper?.closure ?? null, operatorSigningSources: helper?.sourceHashes ?? {},
    publishing, recognition: selected.recognition, trust: selected.trust,
    admissionMigrationName: selected.admissionMigrationName, recognitionMigrationName: selected.recognitionMigrationName,
    migrations, sourceHashes, dependencies: { manifest: sourceHashes["apps/managed-moderation/package.json"],
      lock: sourceHashes["apps/managed-moderation/package-lock.json"], verifier: "verifyManagedDependencies" },
    bundles: bundles.map((b, i) => ({ path: i === 0 ? "worker/worker.mjs" : "worker/recognition.mjs",
      sha256: hashText(b.outputFiles![0]!.text), bytes: b.outputFiles![0]!.contents.length })),
    compatibilityDate: "2026-11-15", provisioning: "separate explicit signed admission and journal provisioning required",
    recovery: "Retain exact D1 journals and encrypted Alchemy state; unknown provider sends never authorize a replacement.",
  };
  return { profile, profileHash: hashJson(profile), bytes: bundles[0]!.outputFiles![0]!.contents,
    recognitionBytes: bundles[1]!.outputFiles![0]!.contents, signingAssets: helper?.files ?? [] };
}
export async function writeManagedWeb2ServicesPackage(directory: string, pkg: Awaited<ReturnType<typeof managedWeb2ServicesPackage>>,
  dependencies?: Parameters<typeof writeManagedPackage>[3]) {
  insist(hashJson(pkg.profile) === pkg.profileHash && pkg.profile.packageProfile === "managed-web2" &&
    hashText(new TextDecoder("utf-8", { fatal: true }).decode(pkg.bytes)) === pkg.profile.bundles[0]!.sha256 &&
    hashText(new TextDecoder("utf-8", { fatal: true }).decode(pkg.recognitionBytes)) === pkg.profile.bundles[1]!.sha256, "managed_web2_package_changed");
  managedFreshStackIdentity(pkg.profile.identity);
  await newManagedPackageDirectory(directory);
  const cwd = await writeManagedPackage(directory, pkg.bytes, pkg.profile.migrations, dependencies);
  await privateDirectory(join(cwd, "recognition-migrations"));
  await writeFile(join(cwd, "worker/recognition.mjs"), pkg.recognitionBytes, { mode: 0o600 });
  await copyFile("packages/release/schema/managed-publishing-admission.sql", join(cwd, "migrations", pkg.profile.admissionMigrationName));
  await copyFile("packages/recognition/schema.sql", join(cwd, "recognition-migrations", pkg.profile.recognitionMigrationName));
  if (pkg.profile.operatorSigning) await writeSigningAssets(cwd, pkg.profile.operatorSigning, pkg.signingAssets);
  await writeFile(join(cwd, "managed-web2-package.json"), canonical(pkg.profile), { mode: 0o600 });
  return cwd;
}


/** Identity is checked before selecting the encrypted Alchemy namespace. */
export function managedFreshStackIdentity(input: {
  prefix: string; packageProfile: "managed-web2" | "operator-signing-only"; planId: Hex;
  state: { store: "pirate-encrypted-local"; stack: string };
}) {
  const i = structuredClone(input); exact(object(i), ["prefix", "packageProfile", "planId", "state"]); exact(object(i.state), ["store", "stack"]);
  insist(/^pirate-[a-z0-9-]{1,48}(?![\s\S])/.test(i.prefix) && !i.prefix.startsWith(managedPrefix) &&
    ["managed-web2", "operator-signing-only"].includes(i.packageProfile) && i.planId.length === 66 &&
    i.state.store === "pirate-encrypted-local" && i.state.stack === i.prefix, "fresh_managed_stack_identity_required");
  bytes32(i.planId); return i;
}
/** Bounded intake for W1's committed moss-signing.html / manifest contract.
 * Root must supply and verify the actual emitted artifact/manifest pin before
 * any package gate. No artifact is built or inferred by this declaration. */
export interface OperatorSigningBuildInputs {
  directory: string; manifestPath: string; manifestSha256: Hex; entryKey: string; htmlFile: string;
  origin: string; contentSecurityPolicy: string;
}
async function pinnedOperatorSigningAssets(input: OperatorSigningBuildInputs) {
  const i = structuredClone(input), root = await realpath(resolve("."));
  const relativeFile = (value: string) => { text(value, 1024); insist(value.length > 0 && !isAbsolute(value) &&
    !/[\\\x00-\x1f\x7f\u2028\u2029]/.test(value) && value.split("/").every(part => part !== ".." && part !== "." && part.length > 0), "operator_signing_build_path_invalid"); return value; };
  const directory = await realpath(resolve(relativeFile(i.directory)));
  insist(!relative(root, directory).startsWith("..") && directory !== root, "operator_signing_build_outside_repository");
  async function file(path: string) {
    const source = resolve(directory, relativeFile(path)), info = await lstat(source);
    insist(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2 * 1024 * 1024 &&
      (await realpath(source)).startsWith(directory + "/"), "operator_signing_build_asset_invalid");
    return { bytes: new Uint8Array(await readFile(source)), source: relative(root, source) };
  }
  const manifestFile = await file(i.manifestPath); insist(i.manifestSha256.length === 66, "operator_signing_manifest_pin_required"); bytes32(i.manifestSha256);
  insist(sha256(manifestFile.bytes) === i.manifestSha256 && manifestFile.bytes.length <= 512 * 1024,
    "operator_signing_manifest_changed");
  const manifest = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes))), entry = object(manifest[i.entryKey]);
  insist(basename(relativeFile(i.entryKey)) === "moss-signing.html" && basename(relativeFile(i.htmlFile)) === "moss-signing.html" &&
    entry.src === i.entryKey && entry.isEntry === true, "operator_signing_entry_contract_unavailable");
  const pending = [i.entryKey], visited = new Set<string>(), paths = new Set<string>();
  while (pending.length) {
    const key = pending.pop()!; if (visited.has(key)) continue; visited.add(key); insist(visited.size <= 64, "operator_signing_manifest_limit");
    const chunk = object(manifest[key]); paths.add(relativeFile(text(chunk.file, 1024)));
    for (const field of ["imports", "dynamicImports", "css", "assets"]) {
      if (chunk[field] === undefined) continue;
      const values = chunk[field]; insist(Array.isArray(values) && values.length <= 64, "operator_signing_manifest_invalid");
      for (const value of values) { const name = relativeFile(text(value, 1024)); if (field === "imports" || field === "dynamicImports") pending.push(name); else paths.add(name); }
    }
  }
  insist(paths.size <= 63, "operator_signing_manifest_limit");
  const html = await file(i.htmlFile), files = [{ path: "/operator-signing", bytes: html.bytes }],
    sourceHashes: Record<string, string> = { [manifestFile.source]: i.manifestSha256, [html.source]: sha256(html.bytes) };
  for (const path of paths) { const asset = await file(path); files.push({ path: "/" + path, bytes: asset.bytes }); sourceHashes[asset.source] = sha256(asset.bytes); }
  const contentType = (path: string) => path === "/operator-signing" ? "text/html" : path.endsWith(".js") ? "text/javascript" :
    path.endsWith(".css") ? "text/css" : path.endsWith(".png") ? "image/png" : path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".woff2") ? "font/woff2" : "unavailable";
  insist(files.reduce((total, file) => total + file.bytes.length, 0) <= 32 * 1024 * 1024, "operator_signing_closure_limit");
  const { operatorSigningClosure } = await import("../services/managed-publishing-worker.ts");
  const closure = operatorSigningClosure({ schema: "pirate.operator-signing-closure/1", origin: i.origin, contentSecurityPolicy: i.contentSecurityPolicy,
    files: files.map(f => ({ path: f.path, sha256: sha256(f.bytes), contentType: contentType(f.path) })) });
  return { closure, files, sourceHashes };
}
async function writeSigningAssets(cwd: string, closure: import("../services/managed-publishing-worker.ts").OperatorSigningClosure,
  files: { path: string; bytes: Uint8Array }[]) {
  insist(files.length === closure.files.length && new Set(files.map(file => file.path)).size === files.length, "operator_signing_closure_changed");
  for (const file of files) {
    insist(closure.files.some(pin => pin.path === file.path && pin.sha256 === sha256(file.bytes)), "operator_signing_asset_changed");
    const target = join(cwd, "operator-signing", file.path.slice(1)); await privateDirectory(resolve(target, ".."));
    await writeFile(target, file.bytes, { mode: 0o600 });
  }
}
export async function managedSigningHelperPackage(input: { identity: Parameters<typeof managedFreshStackIdentity>[0]; assets: OperatorSigningBuildInputs }) {
  const identity = managedFreshStackIdentity(input.identity); insist(identity.packageProfile === "operator-signing-only", "operator_signing_profile_required");
  await verifyManagedDependencies(); const helper = await pinnedOperatorSigningAssets(input.assets),
    bundle = await build({ entryPoints: ["services/managed-publishing-worker.ts"], bundle: true, write: false, platform: "browser", format: "esm",
      target: "es2024", external: ["node:*"], metafile: true, logLevel: "silent" });
  const sourceHashes = { ...helper.sourceHashes, ...Object.fromEntries(await Promise.all([
    ...(await ownedModuleGraph("harness/managed-package.ts")),
    ...Object.keys(bundle.metafile!.inputs).filter(path => !path.includes("node_modules/")), "apps/managed-moderation/alchemy.run.ts",
    "apps/managed-moderation/encrypted-state.ts", "apps/managed-moderation/protected-data.ts", "apps/managed-moderation/package.json",
    "apps/managed-moderation/package-lock.json", "package.json", "package-lock.json",
  ].map(async path => [path, sha256(new Uint8Array(await readFile(path)))]))) };
  const bytes = bundle.outputFiles![0]!.contents, profile = { schema: "pirate.managed-signing-helper-package/1", packageProfile: identity.packageProfile,
    prefix: identity.prefix, identity, operatorSigning: helper.closure, sourceHashes, bundleSha256: sha256(bytes), compatibilityDate: "2026-11-15" };
  return { profile, profileHash: hashJson(profile), bytes, signingAssets: helper.files };
}
export async function writeManagedSigningHelperPackage(directory: string, pkg: Awaited<ReturnType<typeof managedSigningHelperPackage>>,
  dependencies?: Parameters<typeof writeManagedPackage>[3]) {
  managedFreshStackIdentity(pkg.profile.identity);
  insist(pkg.profile.packageProfile === "operator-signing-only" && hashJson(pkg.profile) === pkg.profileHash && sha256(pkg.bytes) === pkg.profile.bundleSha256,
    "operator_signing_package_changed");
  await newManagedPackageDirectory(directory);
  const cwd = await writeManagedPackage(directory, pkg.bytes, [], dependencies);
  await writeSigningAssets(cwd, pkg.profile.operatorSigning, pkg.signingAssets);
  await writeFile(join(cwd, "managed-web2-package.json"), canonical(pkg.profile), { mode: 0o600 }); return cwd;
}

async function newManagedPackageDirectory(directory: string) {
  try { await lstat(join(directory, "deployment")); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("fresh_managed_package_directory_required");
}
