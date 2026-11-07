import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import { digest } from "./private-json.ts";
import {
  privateBytes,
  inspectExistingJournalReadOnly,
  observeWalletsAndCommitments,
  type WalletAdmission,
} from "./study-operator-readonly-adapter.ts";
import {
  readAdmission,
  readCustody,
  operatorScope,
} from "./study-operator-private.ts";
import {
  retainedLearningOperator,
  retainedLearningController,
} from "./study-release-profile.ts";
import type { OperatorProfile } from "./study-operator-profile.ts";
export async function counterEvidence(
  profile: OperatorProfile,
  value: unknown,
  phase: "before" | "after" = "before",
) {
  insist(
    value && typeof value === "object",
    "study_operator_authenticated_store_export_required",
    409,
  );
  const selected = object(value);
  if (selected.kind === "reviewed-persistence-proof") {
    insist(
      typeof selected.reviewPath === "string" &&
        typeof selected.reviewSha256 === "string",
      "study_operator_persistence_review_missing",
      409,
    );
    const bytes = await privateBytes(selected.reviewPath);
    insist(
      digest(bytes) === selected.reviewSha256,
      "study_operator_persistence_review_changed",
      409,
    );
    const review = object(JSON.parse(bytes.toString()));
    insist(
      review.schema === "pirate.study-operator-preservation-review/1" &&
        review.decision === "accept-preservation-basis" &&
        review.ownerRole === "independent_reviewer" &&
        review.scopeHash === operatorScope(profile) &&
        review.oldModuleSha256 === profile.predecessor.moduleSha256 &&
        review.newModuleSha256 === profile.artifact.sha256 &&
        canonical(review.namespaces) === canonical(profile.objects) &&
        canonical(review.sourceHashes) ===
          canonical(profile.artifact.sourceHashes) &&
        review.noStorageMigration === true &&
        review.liveCounterValuesObserved === false &&
        typeof review.reportPath === "string" &&
        typeof review.localProofPath === "string",
      "study_operator_persistence_basis_not_accepted",
      409,
    );
    insist(
      digest(await privateBytes(review.reportPath)) === review.reportSha256 &&
        digest(await privateBytes(review.localProofPath)) ===
          review.localProofSha256,
      "study_operator_persistence_proof_changed",
      409,
    );
    return {
      mode: "reviewed-persistence-proof" as const,
      basisHash: hashJson(review),
      observability: "live counter and opaque journal values are not observed",
    };
  }

  insist(
    typeof selected.operatorPath === "string" &&
      typeof selected.speechPath === "string" &&
      typeof selected.operatorSha256 === "string" &&
      typeof selected.speechSha256 === "string",
    "study_operator_counter_export_paths_missing",
    409,
  );
  const operatorBytes = await privateBytes(selected.operatorPath),
    speechBytes = await privateBytes(selected.speechPath);
  insist(
    digest(operatorBytes) === selected.operatorSha256 &&
      digest(speechBytes) === selected.speechSha256,
    "study_operator_counter_export_changed",
    409,
  );
  const operator = object(JSON.parse(operatorBytes.toString())),
    speech = object(JSON.parse(speechBytes.toString()));
  for (const item of [operator, speech])
    insist(
      item.scopeHash === operatorScope(profile) &&
        item.workerTag === profile.worker.tag &&
        item.moduleSha256 ===
          (phase === "after"
            ? profile.artifact.sha256
            : profile.predecessor.moduleSha256) &&
        Date.parse(String(item.observedAt)) >=
          Date.parse(profile.window.notBefore),
      "study_operator_counter_export_provenance_missing",
      409,
    );
  insist(
    operator.schema === "pirate.operator-store-export/1" &&
      operator.namespaceId === profile.objects.STATE.namespaceId &&
      Array.isArray(operator.records) &&
      operator.records.length > 0 &&
      operator.records.length <= 10000,
    "study_operator_state_export_unqualified",
    409,
  );
  insist(
    speech.schema === "pirate.speech-days-export/1" &&
      speech.namespaceId === profile.objects.SPEECH_BUDGET.namespaceId &&
      Array.isArray(speech.days) &&
      speech.days.length <= 3650,
    "study_operator_speech_export_unqualified",
    409,
  );
  const records = operator.records.map(object),
    keys = records.map((x) => String(x.key));
  insist(
    new Set(keys).size === keys.length,
    "study_operator_duplicate_export_record",
    409,
  );
  const ledgerRow = records.find((x) => x.key === "sponsor:ledger");
  insist(ledgerRow, "study_operator_ledger_missing", 409);
  const ledger = object(
      typeof ledgerRow.value === "string"
        ? JSON.parse(ledgerRow.value)
        : ledgerRow.value,
    ),
    limits = profile.retained.limits;
  insist(
    ledger.cap === limits.sponsorCapWei &&
      ledger.gasPrice === limits.gasPriceWei &&
      ledger.gas === limits.gasLimit &&
      ledger.dataFee === limits.dataFeeWei &&
      typeof ledger.spent === "string" &&
      /^\d+$/.test(ledger.spent) &&
      typeof ledger.reserved === "string" &&
      /^\d+$/.test(ledger.reserved) &&
      BigInt(ledger.spent) + BigInt(ledger.reserved) <=
        BigInt(limits.sponsorCapWei),
    "study_operator_ledger_limits_changed",
    409,
  );
  const days = speech.days.map(object);
  for (const day of days)
    insist(
      Number.isSafeInteger(day.day) &&
        Number.isSafeInteger(day.used) &&
        Number(day.used) >= 0 &&
        Number.isSafeInteger(day.cap) &&
        Number(day.cap) >= 0,
      "study_operator_speech_day_invalid",
      409,
    );
  return {
    mode: "authenticated-export" as const,
    operatorRecordsSha256: hashJson(records),
    speechDaysSha256: hashJson(days),
    ledgerSha256: hashJson(ledger),
    operatorPath: selected.operatorPath,
    speechPath: selected.speechPath,
  };
}
async function rawRows(entry: Record<string, unknown>) {
  const path = String(entry.path),
    bytes = await privateBytes(path);
  insist(
    digest(bytes) === entry.sha256,
    "study_operator_native_inventory_changed",
    409,
  );
  if (entry.format === "activation-journal") {
    await inspectExistingJournalReadOnly(path, String(entry.sha256));
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const saved = (
        db.prepare("SELECT key,value FROM records ORDER BY key").all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => ({
        key: row.key,
        value: JSON.parse(row.value) as unknown,
      }));
      const rows: Record<string, unknown>[] = [];
      for (const row of saved) {
        if (row.key.startsWith("tx:")) {
          const tx = object(row.value);
          insist(
            /^tx:\d{10}$/.test(row.key) &&
              Number(row.key.slice(3)) === tx.nonce,
            "study_operator_native_transaction_key_changed",
            409,
          );
          rows.push(tx);
        } else if (row.key === "deployment" || row.key === "correction") {
          const own = object(row.value);
          insist(
            entry.signer === retainedLearningController &&
              typeof own.profileHash === "string" &&
              /^0x[0-9a-f]{64}$/.test(own.profileHash),
            "study_operator_controller_journal_profile_changed",
            409,
          );
          rows.push(own);
        } else if (
          row.key.startsWith("intent:") ||
          row.key === "sponsor:ledger" ||
          row.key.startsWith("sponsor:reservation:")
        ) {
          object(row.value); // Explicitly classified non-transaction metadata.
        } else if (row.key === "run:profile") {
          insist(
            typeof row.value === "string" &&
              /^0x[0-9a-f]{64}$/.test(row.value) &&
              BigInt(row.value) !== 0n,
            "study_operator_journal_run_profile_invalid",
            409,
          );
        } else if (row.key === "op:nonce") {
          insist(
            Number.isSafeInteger(row.value) && Number(row.value) >= 0,
            "study_operator_journal_nonce_invalid",
            409,
          );
        } else insist(false, "study_operator_journal_key_unsupported", 409);
      }
      for (const { value } of saved.filter((row) =>
        row.key.startsWith("intent:"),
      )) {
        const intent = object(value),
          allocated = rows.find((row) => row.nonce === intent.nonce);
        insist(
          allocated?.raw && allocated.hash,
          "study_operator_intent_transaction_missing",
          409,
        );
        const tx = parseTransaction(allocated.raw as Hex);
        insist(
          (intent.to === undefined ||
            tx.to?.toLowerCase() === String(intent.to).toLowerCase()) &&
            (intent.data === undefined || tx.data === intent.data),
          "study_operator_intent_transaction_changed",
          409,
        );
      }
      insist(rows.length > 0, "study_operator_native_inventory_empty", 409);
      return rows;
    } finally {
      db.close();
    }
  }
  const value = object(JSON.parse(bytes.toString()));
  if (entry.format === "deployment-journal-v1") {
    insist(
      value.chainId === 6343 &&
        value.schema === "pirate.testnet-deployment-journal/1",
      "study_operator_native_journal_profile",
      409,
    );
    return Object.values(object(value.transactions)).map(object);
  }
  if (entry.format === "deploy-results-v2-custom")
    return Object.values(object(value.intents)).map(object);
  if (entry.format === "operator-store-export") {
    insist(
      value.schema === "pirate.operator-store-export/1" &&
        Array.isArray(value.records),
      "study_operator_native_export_profile",
      409,
    );
    return value.records
      .map(object)
      .filter((x) => String(x.key).startsWith("tx:"))
      .map((x) =>
        object(typeof x.value === "string" ? JSON.parse(x.value) : x.value),
      );
  }
  insist(false, "study_operator_native_inventory_format_unsupported", 409);
}
export async function qualifyOperatorRuntime(
  profile: OperatorProfile,
  token: string,
  client: PublicClient,
  now = Date.now(),
  readOnlyRecovery = false,
) {
  await readCustody(profile, now, readOnlyRecovery);
  const admission = await readAdmission(profile);
  insist(
    Date.parse(String(admission.observedAt)) >=
      Date.parse(profile.window.notBefore) &&
      Date.parse(String(admission.observedAt)) <= now,
    "study_operator_runtime_inventory_not_current",
    409,
  );
  const counters = await counterEvidence(profile, admission.counterEvidence);
  if (counters.mode === "reviewed-persistence-proof")
    insist(
      admission.opaqueOperatorState ===
        "preserved-by-unchanged-namespace-and-reviewed-retention-proof",
      "study_operator_opaque_state_exclusion_missing",
      409,
    );
  const wallets = await observeWalletsAndCommitments(
    profile,
    token,
    client,
    object(admission.wallets) as unknown as WalletAdmission,
    Math.floor(now / 1000),
  );
  const latest = await client.getTransactionCount({
      address: retainedLearningOperator.publisher,
      blockTag: "latest",
    }),
    pending = await client.getTransactionCount({
      address: retainedLearningOperator.publisher,
      blockTag: "pending",
    }),
    controller = await client.getTransactionCount({
      address: retainedLearningController,
      blockTag: "latest",
    }),
    controllerPending = await client.getTransactionCount({
      address: retainedLearningController,
      blockTag: "pending",
    });
  const native = object(admission.native);
  insist(
    latest === pending &&
      controller === controllerPending &&
      latest === native.operatorNonce &&
      controller === native.controllerNonce,
    "study_operator_native_nonce_drift",
    409,
  );
  insist(
    Array.isArray(admission.journals) &&
      admission.journals.length > 0 &&
      admission.journals.length <= 64,
    "study_operator_native_inventory_missing",
    409,
  );
  const seen = new Map<string, string>();
  const head = await client.getBlockNumber({ cacheTime: 0 });
  for (const unknown of admission.journals) {
    const entry = object(unknown);
    insist(
      [retainedLearningOperator.publisher, retainedLearningController].includes(
        String(entry.signer) as any,
      ),
      "study_operator_inventory_signer_invalid",
      409,
    );
    const rows = await rawRows(entry);
    insist(
      rows.length <= 10000,
      "study_operator_native_inventory_too_large",
      409,
    );
    for (const row of rows) {
      insist(
        typeof row.raw === "string" &&
          typeof row.hash === "string" &&
          keccak256(row.raw as Hex) === row.hash &&
          Number.isSafeInteger(row.nonce),
        "study_operator_native_transaction_missing",
        409,
      );
      const tx = parseTransaction(row.raw as Hex),
        signer = await recoverTransactionAddress({
          serializedTransaction: row.raw as TransactionSerialized,
        });
      insist(
        tx.chainId === 6343 &&
          tx.nonce === row.nonce &&
          signer.toLowerCase() === entry.signer,
        "study_operator_native_signer_changed",
        409,
      );
      const key = signer.toLowerCase() + ":" + row.nonce;
      insist(
        !seen.has(key) || seen.get(key) === row.hash,
        "study_operator_native_conflicting_nonce",
        409,
      );
      seen.set(key, String(row.hash));
      const receipt = await client.getTransactionReceipt({
        hash: row.hash as Hex,
      });
      insist(
        receipt.transactionHash === row.hash &&
          ["success", "reverted"].includes(receipt.status) &&
          receipt.blockNumber + 11n <= head &&
          (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
            receipt.blockHash,
        "study_operator_native_not_canonical",
        409,
      );
      insist(
        Number(row.nonce) <
          (entry.signer === retainedLearningOperator.publisher
            ? latest
            : controller),
        "study_operator_native_future_nonce",
        409,
      );
    }
    insist(
      digest(await readFile(String(entry.path))) === entry.sha256,
      "study_operator_native_inventory_changed_during_read",
      409,
    );
  }
  return {
    wallets,
    counters,
    operatorNonce: latest,
    controllerNonce: controller,
    inventoryHash: hashJson([...seen].sort()),
  };
}
