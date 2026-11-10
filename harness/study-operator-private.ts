import {
  readFile,
  lstat,
  readdir,
  mkdir,
  open,
  link,
  unlink,
  realpath,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  digest,
  durableJson,
  privateJson,
  replacePrivateJson,
} from "./private-json.ts";
import { privateBytes } from "./study-operator-readonly-adapter.ts";
import type { OperatorProfile } from "./study-operator-profile.ts";
export const operatorBase = () =>
  join(homedir(), ".local/state/pirate-learning-results-testnet-20261106");
export const operatorCwd = () => join(operatorBase(), "alchemy");
export const releaseDirectory = (hash: string) =>
  join(operatorBase(), "study-operator-releases", hash.slice(2));
export function operatorScope(profile: OperatorProfile) {
  const { retained, custody, execution, ...rest } = profile;
  return hashJson({
    ...rest,
    retained: {
      limits: retained.limits,
      quoteValidFrom: retained.quoteValidFrom,
      quoteValidUntil: retained.quoteValidUntil,
    },
    custody: { ownerRole: custody.ownerRole, exclusions: custody.exclusions },
    execution: {
      moduleName: execution.moduleName,
      operatorKeyFileSha256: execution.operatorKeyFileSha256,
      predecessorFiles: execution.predecessorFiles,
    },
  });
}
export async function readAdmission(profile: OperatorProfile) {
  const bytes = await privateBytes(profile.execution.runtimeEvidencePath);
  insist(
    digest(bytes) === profile.retained.runtimeEvidenceSha256,
    "study_operator_runtime_evidence_changed",
    409,
  );
  const value = object(JSON.parse(bytes.toString()));
  insist(
    value.schema === "pirate.study-operator-runtime-admission/1" &&
      value.scopeHash === operatorScope(profile),
    "study_operator_runtime_scope_changed",
    409,
  );
  return value;
}
export async function readCustody(
  profile: OperatorProfile,
  now: number,
  readOnlyRecovery = false,
) {
  const bytes = await privateBytes(profile.custody.record);
  insist(
    digest(bytes) === profile.custody.sha256,
    "study_operator_custody_bytes_changed",
    409,
  );
  const value = object(JSON.parse(bytes.toString()));
  insist(
    value.schema === "pirate.study-operator-custody/1" &&
      value.scopeHash === operatorScope(profile) &&
      value.ownerRole === "workspace_coordinator" &&
      value.inventoryCompleteForWindow === true &&
      Array.isArray(value.quiescentWriters) &&
      value.quiescentWriters.length > 0 &&
      canonical(value.exclusions) === canonical(profile.custody.exclusions) &&
      Date.parse(String(value.expiresAt)) >=
        Date.parse(profile.window.deadline) &&
      (readOnlyRecovery || now < Date.parse(String(value.expiresAt))),
    "study_operator_custody_not_qualified",
    409,
  );
  return value;
}
export async function readPlanReview(profile: OperatorProfile) {
  insist(
    typeof profile.execution.reviewedPlanPath === "string" &&
      typeof profile.execution.reviewedPlanSha256 === "string",
    "study_operator_plan_review_missing",
    409,
  );
  const bytes = await privateBytes(profile.execution.reviewedPlanPath);
  insist(
    digest(bytes) === profile.execution.reviewedPlanSha256,
    "study_operator_plan_review_changed",
    409,
  );
  const value = object(JSON.parse(bytes.toString())),
    effects = object(value.effects);
  insist(
    value.schema === "pirate.study-operator-plan-review/1" &&
      value.scopeHash === operatorScope(profile) &&
      value.reviewedBy === "independent_reviewer" &&
      canonical(effects) ===
        canonical({
          workerUpdates: 1,
          newWorkers: 0,
          newNamespaces: 0,
          namespaceUpdates: 0,
          deletes: 0,
        }),
    "study_operator_plan_not_reviewed",
    409,
  );
  insist(
    typeof value.rawPlanPath === "string" &&
      digest(await privateBytes(value.rawPlanPath)) === value.rawPlanSha256,
    "study_operator_plan_capture_changed",
    409,
  );
  insist(
    typeof value.planReceiptPath === "string" &&
      typeof value.planReceiptSha256 === "string",
    "study_operator_plan_receipt_missing",
    409,
  );
  const receiptBytes = await privateBytes(value.planReceiptPath);
  insist(
    digest(receiptBytes) === value.planReceiptSha256,
    "study_operator_plan_receipt_changed",
    409,
  );
  const receipt = object(JSON.parse(receiptBytes.toString())),
    command = object(receipt.command);
  insist(
    receipt.schema === "pirate.study-operator-cloud-plan/1" &&
      receipt.scopeHash === operatorScope(profile) &&
      receipt.rawPlanPath === value.rawPlanPath &&
      receipt.rawPlanSha256 === value.rawPlanSha256 &&
      Array.isArray(command.args) &&
      command.args[4] === "plan",
    "study_operator_cloud_plan_scope_changed",
    409,
  );
  insist(
    canonical(receipt.moduleClosure) ===
      canonical({
        modules: 1,
        module: "operator.mjs",
        bytes: profile.artifact.bytes,
        sha256: profile.artifact.sha256,
        providerVersion: "2.0.0-beta.85",
        readerSha256:
          "0xef714ea3462f9d9253445da9042647c2108b6339e18b9848aa183dc1931baa95",
      }),
    "study_operator_reviewed_upload_closure_changed",
    409,
  );
  return { ...value, receipt };
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  insist(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid!() &&
      !(s.mode & 0o077) &&
      (await realpath(path)) === path,
    "study_operator_directory_not_private",
    409,
  );
}
export async function preserveOperator(profile: OperatorProfile, hash: string) {
  const directory = releaseDirectory(hash),
    backup = join(directory, "predecessor"),
    marker = join(backup, "preservation.json");
  await privateDirectory(directory);
  await privateDirectory(backup);
  const saved = await privateJson(marker);
  if (saved) {
    insist(
      saved.scopeHash === operatorScope(profile),
      "study_operator_backup_scope_changed",
      409,
    );
    for (const [name, want] of Object.entries(object(saved.files)))
      insist(
        digest(await readFile(join(backup, name))) === want,
        "study_operator_backup_changed",
        409,
      );
    return saved;
  }
  const captures: { name: string; path: string }[] = [];
  async function walk(relative: string) {
    for (const e of await readdir(join(operatorCwd(), relative), {
      withFileTypes: true,
    })) {
      const name = join(relative, e.name);
      insist(!e.isSymbolicLink(), "study_operator_original_tree_symlink", 409);
      if (e.isDirectory()) await walk(name);
      else {
        insist(e.isFile(), "study_operator_original_tree_not_regular", 409);
        captures.push({
          name: "alchemy/" + name,
          path: join(operatorCwd(), name),
        });
      }
    }
  }
  await walk("");
  captures.push({
    name: "quote-window.json",
    path: join(operatorBase(), "quote-window.json"),
  });
  profile.execution.predecessorFiles.forEach((f, i) =>
    captures.push({ name: `source/${i}-${basename(f.path)}`, path: f.path }),
  );
  insist(
    captures.length > 0 && captures.length <= 512,
    "study_operator_preservation_count",
    409,
  );
  const files: Record<string, string> = {};
  let total = 0;
  for (const row of captures) {
    const bytes = await privateBytes(row.path);
    total += bytes.length;
    insist(total <= 64 * 1024 * 1024, "study_operator_preservation_size", 409);
    files[row.name] = digest(bytes);
  }
  for (let i = 0; i < profile.execution.predecessorFiles.length; i++) {
    const row = profile.execution.predecessorFiles[i]!;
    insist(
      files[`source/${i}-${basename(row.path)}`] === row.sha256,
      "study_operator_predecessor_source_changed",
      409,
    );
  }
  await durableJson(join(backup, "preservation-intent.json"), {
    scopeHash: operatorScope(profile),
    files,
  });
  for (const row of captures) {
    const bytes = await privateBytes(row.path);
    insist(
      digest(bytes) === files[row.name],
      "study_operator_original_changed_during_backup",
      409,
    );
    await privateDirectory(join(backup, row.name, ".."));
    const temporary = join(backup, row.name + ".tmp");
    let f;
    try {
      f = await open(temporary, "wx", 0o600);
      await f.writeFile(bytes);
      await f.sync();
    } finally {
      await f?.close();
    }
    try {
      await link(temporary, join(backup, row.name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      insist(
        digest(await readFile(join(backup, row.name))) === files[row.name],
        "study_operator_partial_backup_changed",
        409,
      );
    }
    await unlink(temporary);
  }
  const complete = {
    schema: "pirate.study-operator-preservation/1",
    scopeHash: operatorScope(profile),
    files,
  };
  await durableJson(marker, complete);
  return complete;
}
export async function verifyOperatorBackup(
  profile: OperatorProfile,
  hash: string,
) {
  const backup = join(releaseDirectory(hash), "predecessor"),
    marker = await privateJson(join(backup, "preservation.json"));
  insist(
    marker && marker.scopeHash === operatorScope(profile),
    "study_operator_backup_missing",
    409,
  );
  for (const [name, want] of Object.entries(object(marker.files)))
    insist(
      digest(await readFile(join(backup, name))) === want,
      "study_operator_backup_changed",
      409,
    );
  for (const [name, want] of Object.entries(
    profile.predecessor.encryptedStateFiles,
  ))
    insist(
      object(marker.files)["alchemy/.alchemy/state/" + name] === want,
      "study_operator_encrypted_backup_incomplete",
      409,
    );
  insist(
    object(marker.files)["quote-window.json"] ===
      profile.predecessor.quoteWindowSha256,
    "study_operator_quote_backup_missing",
    409,
  );
}
export async function changeExecution(
  hash: string,
  state: string,
  extra: Record<string, unknown> = {},
) {
  const directory = releaseDirectory(hash);
  await privateDirectory(directory);
  const path = join(directory, "execution.json"),
    old = await privateJson(path),
    next = {
      ...(old ?? {}),
      ...extra,
      ...(state === "dispatched" && !old?.dispatchedAt
        ? { dispatchedAt: new Date().toISOString() }
        : {}),
      schema: "pirate.study-operator-execution/1",
      profileHash: hash,
      state,
      updatedAt: new Date().toISOString(),
    };
  if (old) {
    insist(
      old.profileHash === hash,
      "study_operator_execution_hash_changed",
      409,
    );
    await replacePrivateJson(path, next, digest(await readFile(path)));
  } else await durableJson(path, next);
}
export async function acquireOperatorLock(hash: string) {
  const path = join(operatorBase(), "study-operator-execution.lock"),
    handle = await open(path, "wx", 0o600),
    value = JSON.stringify({ pid: process.pid, profileHash: hash });
  await handle.writeFile(value);
  await handle.sync();
  return async () => {
    await handle.close();
    insist(
      (await readFile(path, "utf8")) === value,
      "study_operator_lock_changed",
      409,
    );
    await unlink(path);
  };
}
