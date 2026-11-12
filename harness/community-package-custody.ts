// Private package location is execution metadata, never public profile intent.
import { lstat, readdir, readFile, open, mkdir, symlink, realpath, readlink } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { canonical, hashJson, insist, object } from "../packages/community/common.ts";
import { digest, durableJson, privateJson } from "./private-json.ts";
import type { ReviewedUpdate } from "./reviewed-update.ts";
import { confinedName, privateNode, regularTree } from "./community-state.ts";
import { applicationInfrastructureSources } from "./community-infrastructure.ts";
export interface CurrentCommunityState {
  files: Record<string, string>;
  identities: Record<string, string>;
}
export type AuthenticateState = (cwd: string) => Promise<CurrentCommunityState>;
export interface CommunityPackageBinding {
  schema: "pirate.community-package-binding/1";
  profileHash: string;
  relativePath: string;
  manifestSha256: string;
}
type Ready = {
  schema: "pirate.community-package-ready/1";
  profileHash: string;
  files: Record<string, string>;
  modules: { path: string; dev: number; ino: number };
  state: CurrentCommunityState;
  predecessor: { relativePath: string; executionSha256: string; preservationSha256: string };
};
const readyName = ".custody-ready.json";
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
/** Capture selected bytes once, checking the public profile rather than absorbing leftovers. */
export async function communityArtifactInputs(
  bytes: Uint8Array,
  profile: {
    bundleSha256: string;
    assets: Record<string, string>;
    migrations: string[];
    sourceHashes: Record<string, string>;
  },
) {
  insist(digest(bytes) === profile.bundleSha256, "community_package_worker_changed", 409);
  const files: Record<string, Uint8Array> = {
    "worker/worker.mjs": bytes,
    "package.json": Buffer.from('{"private":true,"type":"module"}\n'),
  };
  const names = (await regularTree("apps/web/dist/live", false)).filter((p) => !p.endsWith("/"));
  insist(
    canonical(names) === canonical(Object.keys(profile.assets).sort()),
    "community_package_asset_inputs_changed",
    409,
  );
  const read = async (path: string, expected: string) => {
    const stat = await lstat(path);
    insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "community_package_input_link", 409);
    const data = await readFile(path);
    insist(digest(data) === expected, "community_package_copy_input_changed", 409);
    return data;
  };
  for (const name of names)
    files[`assets/${confinedName(name)}`] = await read(`apps/web/dist/live/${name}`, profile.assets[name]!);
  insist(
    new Set(profile.migrations).size === profile.migrations.length,
    "community_package_migrations_changed",
    409,
  );
  for (const name of profile.migrations) {
    insist(/^\d{4}_[a-z0-9_]+\.sql$/.test(name), "community_package_migrations_changed", 409);
    const path = `apps/community-wizard/infra/migrations/${name}`;
    files[`migrations/${name}`] = await read(path, profile.sourceHashes[path]!);
  }
  for (const path of applicationInfrastructureSources) {
    const name = path.split("/").at(-1)!;
    files[name === "application-alchemy.run.ts" ? "alchemy.run.ts" : name] = await read(
      path,
      profile.sourceHashes[path]!,
    );
  }
  return files;
}
async function modulesIdentity(modules: string) {
  const path = await realpath(modules),
    stat = await lstat(path);
  insist(stat.isDirectory() && stat.uid === process.getuid!(), "community_package_dependency_identity", 409);
  return { path, dev: stat.dev, ino: stat.ino };
}
async function manifestAt(cwd: string, binding: CommunityPackageBinding): Promise<Ready> {
  await privateNode(cwd, true);
  const ready = await privateJson(join(cwd, readyName));
  insist(
    ready?.schema === "pirate.community-package-ready/1" &&
      ready.profileHash === binding.profileHash &&
      hashJson(ready) === binding.manifestSha256,
    "community_package_ready_unverified",
    409,
  );
  return ready as unknown as Ready;
}
async function verifyArtifacts(cwd: string, ready: Ready) {
  const names = Object.keys(ready.files).sort(),
    expected = new Set(names);
  for (const name of names) {
    confinedName(name);
    insist(
      ![".alchemy", "node_modules", readyName].includes(name.split("/")[0]!),
      "community_package_manifest_invalid",
      409,
    );
    await privateNode(join(cwd, name));
    insist(
      digest(await readFile(join(cwd, name))) === ready.files[name],
      "community_package_artifact_changed",
      409,
    );
    for (let parent = dirname(name); parent !== "."; parent = dirname(parent)) expected.add(parent + "/");
  }
  const actual: string[] = [];
  for (const entry of await readdir(cwd, { withFileTypes: true })) {
    if (entry.name === readyName) continue;
    if (entry.name === "node_modules") {
      insist(
        entry.isSymbolicLink() &&
          (await readlink(join(cwd, entry.name))) === ready.modules.path &&
          canonical(await modulesIdentity(join(cwd, entry.name))) === canonical(ready.modules),
        "community_package_dependencies_changed",
        409,
      );
      continue;
    }
    if (entry.name === ".alchemy") {
      await regularTree(join(cwd, entry.name));
      continue;
    }
    insist(
      !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()),
      "community_package_unexpected_link_or_special",
      409,
    );
    if (entry.isDirectory()) {
      actual.push(
        entry.name + "/",
        ...(await regularTree(join(cwd, entry.name))).map((p) => `${entry.name}/${p}`),
      );
    } else actual.push(entry.name);
  }
  insist(
    canonical(actual.sort()) === canonical([...expected].sort()) &&
      (await lstat(join(cwd, "node_modules"))).isSymbolicLink(),
    "community_package_inventory_changed",
    409,
  );
}
function pathFor(directory: string, binding: CommunityPackageBinding) {
  insist(
    binding.schema === "pirate.community-package-binding/1" &&
      validHash(binding.profileHash) &&
      validHash(binding.manifestSha256) &&
      binding.relativePath === `deployment-${binding.profileHash.slice(2)}`,
    "community_package_binding_invalid",
    409,
  );
  const cwd = resolve(directory, confinedName(binding.relativePath));
  insist(dirname(cwd) === resolve(directory), "community_package_path_invalid", 409);
  return cwd;
}
/** Only an exact recorded predecessor may use historical deployment without a binding. */
async function resolveCommunityPackage(
  directory: string,
  profileHash: string,
  policy: ReviewedUpdate,
) {
  await privateNode(directory, true);
  const path = join(directory, "execution.json"),
    execution = await privateJson(path);
  insist(
    execution &&
      (execution.profileHash === profileHash || execution.profileHash === policy.previousProfileHash),
    "community_package_execution_missing_or_foreign",
    409,
  );
  if (execution.packageBinding) {
    const binding = object(execution.packageBinding) as unknown as CommunityPackageBinding;
    insist(binding.profileHash === execution.profileHash, "community_package_profile_substitution", 409);
    const cwd = pathFor(directory, binding),
      ready = await manifestAt(cwd, binding);
    await verifyArtifacts(cwd, ready);
    return { cwd, binding, ready, execution };
  }
  insist(
    execution.profileHash === policy.previousProfileHash &&
      digest(await readFile(path)) === policy.expectedExecutionSha256,
    "community_package_binding_missing",
    409,
  );
  const cwd = join(directory, "deployment");
  await privateNode(cwd, true);
  return { cwd, binding: null, ready: null, execution };
}
/** No mutable ciphertext digest is pinned after Alchemy starts; identities remain pinned. */
export async function verifyCommunityPackage(
  directory: string,
  profileHash: string,
  policy: ReviewedUpdate,
  authenticate: AuthenticateState,
) {
  const current = await resolveCommunityPackage(directory, profileHash, policy);
  const state = await authenticate(current.cwd);
  if (current.ready)
    insist(
      canonical(state.identities) === canonical(current.ready.state.identities),
      "community_package_state_identity_changed",
      409,
    );
  return { ...current, state };
}
/** The actual plan/apply runner receives only this freshly verified cwd. */
export async function runCommunityPackageCommand<T>(
  directory: string,
  binding: CommunityPackageBinding,
  policy: ReviewedUpdate,
  authenticate: AuthenticateState,
  command: (cwd: string) => Promise<T>,
) {
  const current = await verifyCommunityPackage(directory, binding.profileHash, policy, authenticate);
  insist(canonical(current.binding) === canonical(binding), "community_package_command_binding_changed", 409);
  await durableJson(join(directory, `package-started-${binding.profileHash.slice(2)}.json`), {
    profileHash: binding.profileHash,
    packageBinding: binding,
  });
  return command(current.cwd);
}
async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function exclusiveFile(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Preparation never overwrites an existing partial directory or predecessor. */
export async function prepareCommunityPackage(options: {
  directory: string;
  profileHash: string;
  policy: ReviewedUpdate;
  files: Record<string, Uint8Array>;
  modules: string;
  authenticate: AuthenticateState;
  boundary?: (phase: "created" | "copied" | "ready") => Promise<void>;
}) {
  const { directory, profileHash, policy, authenticate } = options;
  insist(validHash(profileHash), "community_package_profile_invalid", 409);
  const source = await verifyCommunityPackage(directory, profileHash, policy, authenticate);
  insist(
    source.execution.profileHash === policy.previousProfileHash,
    "community_package_preparation_after_adoption",
    409,
  );
  const backup = join(directory, `before-update-${profileHash.slice(2)}`),
    preservation = await privateJson(join(backup, "preservation.json"));
  insist(preservation?.successor === profileHash, "community_package_predecessor_not_preserved", 409);
  const saved = object(preservation.files);
  await regularTree(backup, false);
  insist(
    saved["execution.json"] === policy.expectedExecutionSha256 &&
      digest(await readFile(join(backup, "execution.json"))) === policy.expectedExecutionSha256,
    "community_package_predecessor_changed",
    409,
  );
  const sourcePath = relative(directory, source.cwd);
  for (const [name, hash] of Object.entries(source.state.files))
    insist(
      saved[`${sourcePath}/.alchemy/state/${name}`] === hash &&
        digest(await readFile(join(backup, sourcePath, ".alchemy/state", name))) === hash,
      "community_package_current_state_not_preserved",
      409,
    );
  const files: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(options.files)) {
    confinedName(name);
    insist(
      ![".alchemy", "node_modules", readyName].includes(name.split("/")[0]!),
      "community_package_input_invalid",
      409,
    );
    files[name] = digest(bytes);
  }
  const ready: Ready = {
    schema: "pirate.community-package-ready/1",
    profileHash,
    files,
    modules: await modulesIdentity(options.modules),
    state: source.state,
    predecessor: {
      relativePath: sourcePath,
      executionSha256: policy.expectedExecutionSha256,
      preservationSha256: digest(await readFile(join(backup, "preservation.json"))),
    },
  };
  const binding: CommunityPackageBinding = {
    schema: "pirate.community-package-binding/1",
    profileHash,
    relativePath: `deployment-${profileHash.slice(2)}`,
    manifestSha256: hashJson(ready),
  };
  const cwd = pathFor(directory, binding);
  try {
    await mkdir(cwd, { mode: 0o700 });
    await syncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await manifestAt(cwd, binding);
    await verifyArtifacts(cwd, ready);
    insist(
      canonical(await authenticate(cwd)) === canonical(source.state),
      "community_package_prepared_state_changed",
      409,
    );
    return binding;
  }
  await options.boundary?.("created");
  for (const [name, bytes] of Object.entries(options.files)) {
    insist(digest(bytes) === files[name], "community_package_copy_input_changed", 409);
    await exclusiveFile(join(cwd, name), bytes);
  }
  for (const [name, hash] of Object.entries(source.state.files)) {
    const bytes = await readFile(join(source.cwd, ".alchemy/state", confinedName(name)));
    insist(digest(bytes) === hash, "community_package_copy_state_changed", 409);
    await exclusiveFile(join(cwd, ".alchemy/state", name), bytes);
    insist(
      digest(await readFile(join(cwd, ".alchemy/state", name))) === hash,
      "community_package_copy_state_changed",
      409,
    );
  }
  await symlink(ready.modules.path, join(cwd, "node_modules"), "dir");
  await options.boundary?.("copied");
  await verifyArtifacts(cwd, ready);
  insist(
    canonical(await authenticate(cwd)) === canonical(source.state) &&
      canonical(await authenticate(source.cwd)) === canonical(source.state),
    "community_package_copy_state_changed",
    409,
  );
  // Flush child directory entries as well as file contents before readiness.
  async function flush(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await flush(join(path, entry.name));
    await syncDirectory(path);
  }
  await flush(cwd);
  await durableJson(join(cwd, readyName), ready);
  await syncDirectory(directory);
  await options.boundary?.("ready");
  return binding;
}
/** Used immediately before atomic adoption; never writes/restores package state. */
export async function verifyPreparedCommunityPackage(
  directory: string,
  binding: CommunityPackageBinding,
  policy: ReviewedUpdate,
  authenticate: AuthenticateState,
) {
  const cwd = pathFor(directory, binding),
    ready = await manifestAt(cwd, binding);
  insist(
    ["deployment", `deployment-${policy.previousProfileHash.slice(2)}`].includes(
      ready.predecessor.relativePath,
    ),
    "community_package_predecessor_path_changed",
    409,
  );
  await verifyArtifacts(cwd, ready);
  const backup = join(directory, `before-update-${binding.profileHash.slice(2)}`);
  await regularTree(backup, false);
  insist(
    ready.predecessor.executionSha256 === policy.expectedExecutionSha256 &&
      digest(await readFile(join(backup, "preservation.json"))) === ready.predecessor.preservationSha256 &&
      digest(await readFile(join(directory, "execution.json"))) === policy.expectedExecutionSha256,
    "community_package_predecessor_changed",
    409,
  );
  const state = await authenticate(cwd),
    source = await authenticate(join(directory, confinedName(ready.predecessor.relativePath)));
  insist(
    canonical(state) === canonical(ready.state) && canonical(source) === canonical(ready.state),
    "community_package_prepared_state_changed",
    409,
  );
  return cwd;
}
