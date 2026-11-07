// Draft actual read-only adapters. No function is called at module import.
// This file intentionally has no managed-secret loader or deploy implementation.
import { readFile, lstat, readdir, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { PublicClient } from "viem";
import {
  hashJson,
  canonical,
  insist,
  object,
} from "../packages/community/common.ts";
import { readBounded } from "../packages/community/ipfs.ts";
import { resultsAbi } from "../packages/protocol/learning-results.ts";
import { readOnlyRemoteDb, curatedDatabases } from "./curated-state.ts";
import { fetchWorkerModuleDigests } from "./worker-modules.ts";
import { unseal } from "../apps/community-wizard/infra/protected-data.ts";
import {
  operatorProfile,
  type OperatorProfile,
} from "./study-operator-profile.ts";
const digest = (v: Uint8Array | string) =>
  "0x" + createHash("sha256").update(v).digest("hex");
const operatorBase = () =>
  join(homedir(), ".local/state/pirate-learning-results-testnet-20261106");
export async function privateBytes(path: string, maximum = 16 * 1024 * 1024) {
  const stat = await lstat(path);
  insist(
    resolve(path) === path &&
      (await realpath(path)) === path &&
      stat.isFile() &&
      stat.uid === process.getuid!() &&
      !(stat.mode & 0o077) &&
      stat.size <= maximum,
    "study_operator_private_file_invalid",
    409,
  );
  const bytes = await readFile(path);
  insist(bytes.length <= maximum, "study_operator_private_file_too_large", 409);
  return bytes;
}
export async function observeOperatorCloud(
  profile: OperatorProfile,
  token: string,
  moduleName?: string,
) {
  profile = operatorProfile(profile);
  insist(
    moduleName && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(moduleName),
    "study_operator_missing_reviewed_module_name",
    409,
  );
  const target = `https://api.cloudflare.com/client/v4/accounts/${profile.worker.accountId}/workers/scripts/${profile.worker.name}`;
  const response = await fetch(target + "/settings", {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  insist(response.ok, "study_operator_settings_unavailable", 503);
  const body = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBounded(response, 1024 * 1024),
        ),
      ),
    ),
    settings = object(body.result);
  insist(
    body.success === true && Array.isArray(settings.bindings),
    "study_operator_settings_invalid",
    503,
  );
  const bindings = settings.bindings.map(object),
    byName = (name: string) => bindings.filter((x) => x.name === name);
  const objects: Record<string, { className: string; namespaceId: string }> =
    {};
  for (const name of ["STATE", "SPEECH_BUDGET"] as const) {
    const found = byName(name);
    insist(
      found.length === 1 && found[0]!.type === "durable_object_namespace",
      "study_operator_durable_binding_missing",
      409,
    );
    const binding = found[0]!;
    insist(
      binding.class_name === profile.objects[name].className &&
        binding.namespace_id === profile.objects[name].namespaceId &&
        (!binding.script_name || binding.script_name === profile.worker.name),
      "study_operator_live_namespace_changed",
      409,
    );
    objects[name] = {
      className: String(binding.class_name),
      namespaceId: String(binding.namespace_id),
    };
  }
  const modules = await fetchWorkerModuleDigests(
    token,
    profile.worker.accountId,
    profile.worker.name,
    [moduleName],
  );
  insist(
    Object.keys(modules).length === 1,
    "study_operator_extra_modules",
    409,
  );
  const moduleSha256 = Object.values(modules)[0]!;
  insist(
    moduleSha256 === profile.predecessor.moduleSha256 ||
      moduleSha256 === profile.artifact.sha256,
    "study_operator_live_module_changed",
    409,
  );
  const successor = moduleSha256 === profile.artifact.sha256;
  const value = (name: string) => {
    const values = byName(name);
    insist(
      values.length === 1 && values[0]!.type === "plain_text",
      "study_operator_binding_changed",
      409,
    );
    return values[0]!.text;
  };
  insist(
    value("RESULTS_V2_CONTRACT") === profile.selection.resultsV2.contract &&
      value("OPERATOR_PROFILE") ===
        (successor
          ? "pirate-learning-testnet-v3"
          : "pirate-karaoke-testnet-v2"),
    "study_operator_result_bindings_changed",
    409,
  );
  insist(
    successor
      ? value("RESULTS_V3_CONTRACT") === profile.selection.resultsV3.contract
      : byName("RESULTS_V3_CONTRACT").length === 0,
    "study_operator_v3_binding_changed",
    409,
  );
  const invariant = {
    ...settings,
    bindings: bindings
      .filter(
        (x) =>
          !["OPERATOR_PROFILE", "RESULTS_V3_CONTRACT"].includes(String(x.name)),
      )
      .map((x) =>
        x.type === "secret_text" ? { name: x.name, type: x.type } : x,
      )
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
  // Root must qualify which Cloudflare metadata fields are stable before pinning this digest.
  const publicSettingsInvariantSha256 = hashJson(invariant);
  insist(
    publicSettingsInvariantSha256 ===
      profile.predecessor.publicSettingsInvariantSha256,
    "study_operator_settings_invariant_changed",
    409,
  );
  const metadataResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${profile.worker.accountId}/workers/scripts?per_page=100&page=1`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    },
  );
  insist(metadataResponse.ok, "study_operator_metadata_unavailable", 503);
  const metadata = object(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBounded(metadataResponse, 1024 * 1024),
      ),
    ),
  );
  insist(
    metadata.success === true &&
      Array.isArray(metadata.result) &&
      metadata.result.length < 100,
    "study_operator_metadata_pagination_or_shape",
    409,
  );
  const matches = metadata.result
    .map(object)
    .filter((x) => x.id === profile.worker.name);
  insist(
    matches.length === 1 && matches[0]!.tag === profile.worker.tag,
    "study_operator_worker_tag_changed",
    409,
  );
  const activation = byName("APPROVED_ACTIVATION_ACCOUNT");
  insist(
    activation.length <= 1 &&
      (!activation.length ||
        (activation[0]!.type === "plain_text" &&
          typeof activation[0]!.text === "string" &&
          /^0x[0-9a-f]{40}$/.test(activation[0]!.text))),
    "study_operator_activation_binding_changed",
    409,
  );
  return {
    activationAccount: activation[0]?.text as string | undefined,
    workerName: profile.worker.name,
    workerTag: String(matches[0]!.tag),
    objects,
    moduleSha256,
    publicSettingsInvariantSha256,
  };
}
export async function authenticateOperatorFiles(
  profile: OperatorProfile,
  password: string,
) {
  profile = operatorProfile(profile);
  const base = operatorBase(),
    state = join(base, "alchemy/.alchemy/state"),
    found: string[] = [];
  async function walk(relative: string) {
    for (const entry of await readdir(join(state, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, entry.name);
      insist(!entry.isSymbolicLink(), "study_operator_state_symlink", 409);
      if (entry.isDirectory()) await walk(path);
      else {
        insist(
          entry.isFile() && path.endsWith(".json"),
          "study_operator_unclassified_state_file",
          409,
        );
        found.push(path);
      }
    }
  }
  await walk("");
  insist(
    canonical(found.sort()) ===
      canonical(Object.keys(profile.predecessor.encryptedStateFiles).sort()),
    "study_operator_encrypted_inventory_changed",
    409,
  );
  const hashes: Record<string, string> = {};
  let total = 0;
  for (const path of found) {
    const bytes = await privateBytes(join(state, path));
    total += bytes.length;
    insist(
      total <= 64 * 1024 * 1024,
      "study_operator_state_inventory_too_large",
      409,
    );
    hashes[path] = digest(bytes);
    insist(
      hashes[path] === profile.predecessor.encryptedStateFiles[path],
      "study_operator_encrypted_state_changed",
      409,
    );
    const record = object(
      JSON.parse(unseal(bytes.toString(), password, "alchemy-state:" + path)),
    );
    if (path === "pirate-learning-testnet-v2/testnet/Operator.json") {
      const attr = object(record.attr);
      insist(
        ["created", "updated"].includes(String(record.status)) &&
          record.resourceType === "Cloudflare.Worker" &&
          record.logicalId === "Operator" &&
          attr.accountId === profile.worker.accountId &&
          attr.workerId === profile.worker.tag &&
          attr.workerName === profile.worker.name,
        "study_operator_owned_worker_state_changed",
        409,
      );
    }
  }
  const quoteBytes = await privateBytes(join(base, "quote-window.json"), 65536),
    quote = object(JSON.parse(quoteBytes.toString()));
  insist(
    digest(quoteBytes) === profile.predecessor.quoteWindowSha256 &&
      quote.validFrom === profile.retained.quoteValidFrom &&
      quote.validUntil === profile.retained.quoteValidUntil,
    "study_operator_quote_window_changed",
    409,
  );
  return {
    ciphertextHashes: hashes,
    quoteWindowSha256: digest(quoteBytes),
    ownership: "authenticated original encrypted operator state",
  };
}
export interface WalletAdmission {
  expectedRows: number;
  expectedStateSha256: string;
  knownPublished: {
    ticketId: string;
    sessionId: `0x${string}`;
    commitment: `0x${string}`;
    revision: number;
  }[];
}
export async function observeWalletsAndCommitments(
  profile: OperatorProfile,
  token: string,
  client: Pick<
    PublicClient,
    "getChainId" | "readContract" | "getBlockNumber" | "getBlock"
  >,
  admission: WalletAdmission,
  now = Math.floor(Date.now() / 1000),
) {
  profile = operatorProfile(profile);
  insist(
    (await client.getChainId()) === 6343,
    "study_operator_wrong_runtime_chain",
    409,
  );
  insist(
    Number.isSafeInteger(admission.expectedRows) &&
      admission.expectedRows >= 0 &&
      admission.expectedRows <= 10000 &&
      admission.knownPublished.length > 0 &&
      admission.knownPublished.length <= 128,
    "study_operator_runtime_admission_missing",
    409,
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > 0n, "study_operator_runtime_head_missing", 409);
  const blockNumber = head - 1n;
  const before = await client.getBlock({ blockNumber });
  const db = readOnlyRemoteDb(
      token,
      profile.worker.accountId,
      curatedDatabases.application,
    ),
    wallets = (
      await db
        .prepare(
          "SELECT value FROM karaoke_state WHERE key LIKE 'wallet:%' ORDER BY key",
        )
        .all<{ value: string }>()
    ).results;
  insist(
    wallets.length === admission.expectedRows &&
      hashJson(wallets) === admission.expectedStateSha256,
    "study_operator_wallet_inventory_changed",
    409,
  );
  const opens = wallets
    .map((x) => object(JSON.parse(x.value)).open)
    .filter(Boolean)
    .map(object);
  for (const open of opens)
    insist(
      Number.isSafeInteger(open.expiresAt) &&
        Number(open.expiresAt) <= now &&
        admission.knownPublished.some((x) => x.ticketId === open.ticketId),
      "study_operator_active_or_unclassified_take",
      409,
    );
  for (const expected of admission.knownPublished) {
    const response = await fetch(profile.worker.origin + "/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: expected.ticketId }),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    insist(response.ok, "study_operator_retained_record_unavailable", 503);
    const record = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readBounded(response, 65536),
          ),
        ),
      ),
      publication = object(record.publication);
    insist(
      publication.state === "published" &&
        publication.confirmed === true &&
        publication.revision === expected.revision,
      "study_operator_publication_recovery_changed",
      409,
    );
    insist(
      (await client.readContract({
        address: profile.selection.resultsV2.contract,
        abi: resultsAbi,
        functionName: "commitments",
        args: [expected.sessionId],
        blockNumber,
      })) === expected.commitment,
      "study_operator_retained_commitment_changed",
      409,
    );
  }
  const after = await client.getBlock({ blockNumber });
  insist(
    before.hash && before.hash === after.hash,
    "study_operator_runtime_reorganized",
    409,
  );
  return {
    blockNumber: blockNumber.toString(),
    blockHash: before.hash,
    walletRows: wallets.length,
    walletStateSha256: hashJson(wallets),
    openPointers: opens.length,
    classification: opens.length
      ? "known expired published pointers retained"
      : "none",
    knownPublished: admission.knownPublished.length,
  };
}
export async function inspectExistingJournalReadOnly(
  path: string,
  expectedSha256: string,
) {
  const bytes = await privateBytes(path);
  insist(
    digest(bytes) === expectedSha256,
    "study_operator_journal_changed",
    409,
  );
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
      insist(false, "study_operator_journal_sidecar_unreviewed", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // node:sqlite rows have null prototypes. Copy typed columns before hashing.
    const rows = (
      db.prepare("SELECT key,value FROM records ORDER BY key").all() as {
        key: string;
        value: string;
      }[]
    ).map((row) => {
      insist(
        typeof row.key === "string" && typeof row.value === "string",
        "study_operator_journal_row_invalid",
        409,
      );
      return { key: row.key, value: row.value };
    });
    insist(rows.length <= 10000, "study_operator_journal_too_large", 409);
    const parsed = rows.map((x) => ({
      key: x.key,
      value: JSON.parse(x.value) as unknown,
    }));
    for (const row of parsed.filter((x) => x.key.startsWith("tx:")))
      insist(
        object(row.value).mined &&
          ["success", "reverted"].includes(
            String(object(object(row.value).mined).status),
          ),
        "study_operator_journal_pending_transaction",
        409,
      );
    for (const row of parsed.filter((x) => x.key === "sponsor:ledger"))
      insist(
        BigInt(String(object(row.value).reserved ?? "0")) === 0n,
        "study_operator_journal_reserved_spending",
        409,
      );
    for (const row of parsed.filter((x) =>
      x.key.startsWith("sponsor:reservation:"),
    ))
      insist(
        object(row.value).state !== "reserved",
        "study_operator_journal_reserved_spending",
        409,
      );
    for (const row of parsed.filter((x) => x.key.startsWith("intent:")))
      insist(
        Number.isSafeInteger(object(row.value).nonce),
        "study_operator_unallocated_intent",
        409,
      );
    return {
      qualification:
        "byte inventory and terminal-state checks only; signer/nonce reconciliation remains required",
      fileSha256: expectedSha256,
      rowCount: rows.length,
      recordsSha256: hashJson(rows),
    };
  } finally {
    db.close();
  }
}
export function executionAdapterUnavailable(): never {
  throw new Error(
    "study_operator_live_apply_adapter_unreviewed: exact package writer, custody evidence schema, managed-secret references, Worker-ID metadata, preserved successor and bounded Alchemy executor are not yet supplied",
  );
}
