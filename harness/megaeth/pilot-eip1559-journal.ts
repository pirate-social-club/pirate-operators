import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  sha256,
  type Hex,
} from "viem";
import { canonical, check } from "../../packages/protocol/index.ts";
import {
  pilotTransaction,
  pilotUnsigned,
  uint,
  type PinnedPilot,
  type PilotPreflight,
  type PilotProof,
} from "./pilot-eip1559-plan.ts";

export interface PilotOriginal {
  index: number;
  kind: string;
  nonce: number;
  unsigned: Hex;
  originalId: Hex;
  dispatch: "never-attempted" | "attempted";
  phase:
    | "prepared"
    | "signing"
    | "signed"
    | "attempted"
    | "unknown"
    | "pending"
    | "confirmed"
    | "reverted";
  preflight: PilotPreflight;
  raw: Hex | null;
  hash: Hex | null;
  proof: PilotProof | null;
  observations: { sha256: Hex; value: unknown }[];
}
export interface PilotState {
  schema: "pirate.pilot-eip1559-journal/2";
  pinHash: Hex;
  planRaw: string;
  source: string;
  fundingCapWei: string;
  fundingReservedWei: string;
  fundedWei: string | null;
  records: PilotOriginal[];
  executions: {
    startedAtMs: number;
    deadlineMs: number;
    ownerRole: string;
    pid: number;
  }[];
}
export async function verifyPilotRaw(p: PinnedPilot, index: number, raw: Hex) {
  check(/^0x02[0-9a-f]+(?![\s\S])/.test(raw), "pilot_type2_required");
  const parsed = parseTransaction(raw),
    tx = pilotTransaction(p, index);
  check(
    parsed.type === "eip1559" &&
      parsed.chainId === 6343 &&
      parsed.nonce === index &&
      parsed.to?.toLowerCase() === tx.to?.toLowerCase() &&
      parsed.data === tx.data &&
      (parsed.value ?? 0n) === 0n &&
      parsed.gas === tx.gas &&
      parsed.maxFeePerGas === tx.maxFeePerGas &&
      (parsed.maxPriorityFeePerGas ?? 0n) === 0n &&
      (!parsed.accessList || parsed.accessList.length === 0) &&
      parsed.r &&
      parsed.s &&
      (parsed.yParity === 0 || parsed.yParity === 1),
    "pilot_signed_fields_changed",
  );
  const canonicalRaw = serializeTransaction(tx, {
    r: parsed.r,
    s: parsed.s,
    yParity: parsed.yParity,
  });
  check(
    canonicalRaw === raw &&
      (
        await recoverTransactionAddress({ serializedTransaction: canonicalRaw })
      ).toLowerCase() === p.admission.wallet.toLowerCase(),
    "pilot_signed_original_changed",
  );
  return keccak256(raw);
}
export async function openPilotJournal(directory: string, p: PinnedPilot) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  check(
    (await realpath(directory)) === directory &&
      (info.mode & 0o077) === 0 &&
      (!process.getuid || info.uid === process.getuid()),
    "pilot_private_directory_required",
  );
  for (let path = directory; ; path = dirname(path)) {
    check(
      !(await access(join(path, ".git")).then(
        () => true,
        () => false,
      )),
      "pilot_journal_inside_repository",
    );
    if (dirname(path) === path) break;
  }
  const lockPath = join(directory, "pilot.lock"),
    lock = await open(lockPath, "wx", 0o600),
    path = join(directory, "pilot.json");
  await lock.writeFile(
    canonical({
      pid: process.pid,
      ownerRole: "integration_release_coordinator",
    }),
  );
  await lock.sync();
  let state: PilotState,
    poisoned = false,
    closed = false;
  const available = () => check(!poisoned && !closed, "pilot_journal_held");
  async function persist() {
    available();
    let file;
    try {
      file = await open(path + ".pending", "wx", 0o600);
      await file.writeFile(canonical(state) + "\n");
      await file.sync();
      await file.close();
      file = undefined;
      await rename(path + ".pending", path);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch (error) {
      poisoned = true;
      await file?.close().catch(() => {});
      throw error;
    }
  }
  const original = (index: number) => {
    available();
    const r = state.records[index];
    check(r && r.index === index, "pilot_original_missing");
    return r;
  };
  try {
    check(
      !(await access(path + ".pending").then(
        () => true,
        () => false,
      )),
      "pilot_partial_journal_requires_recovery",
    );
    try {
      state = JSON.parse(await readFile(path, "utf8")) as PilotState;
    } catch (error) {
      check(
        (error as NodeJS.ErrnoException).code === "ENOENT",
        "pilot_journal_unreadable",
      );
      state = {
        schema: "pirate.pilot-eip1559-journal/2",
        pinHash: p.pinHash,
        planRaw: p.rawPlan,
        source: p.plan.source,
        fundingCapWei: p.admission.walletFundingCapWei,
        fundingReservedWei: p.admission.walletFundingCapWei,
        fundedWei: null,
        records: [],
        executions: [],
      };
    }
    check(
      state.schema === "pirate.pilot-eip1559-journal/2" &&
        state.pinHash === p.pinHash &&
        state.planRaw === p.rawPlan &&
        state.source === p.plan.source &&
        state.fundingCapWei === p.admission.walletFundingCapWei &&
        state.fundingReservedWei === p.admission.walletFundingCapWei &&
        state.records.length <= 4,
      "pilot_journal_selection_changed",
    );
    for (const [index, r] of state.records.entries()) {
      check(
        (r.dispatch === "never-attempted" || r.dispatch === "attempted") &&
          (r.dispatch !== "attempted" ||
            [
              "attempted",
              "unknown",
              "pending",
              "confirmed",
              "reverted",
            ].includes(r.phase)) &&
          (r.phase !== "attempted" || r.dispatch === "attempted"),
        "pilot_dispatch_state_invalid",
      );
      check(
        r.index === index &&
          r.nonce === index &&
          r.unsigned === pilotUnsigned(p, index) &&
          r.originalId ===
            sha256(
              new TextEncoder().encode(
                canonical({ pinHash: p.pinHash, index, unsigned: r.unsigned }),
              ),
            ),
        "pilot_original_changed",
      );
      if (r.raw)
        check(
          (await verifyPilotRaw(p, index, r.raw)) === r.hash,
          "pilot_original_changed",
        );
    }
    state.executions.push({
      startedAtMs: Date.now(),
      deadlineMs: p.admission.deadlineMs,
      ownerRole: "integration_release_coordinator",
      pid: process.pid,
    });
    await persist();
    return {
      snapshot: () => structuredClone(state),
      async reserve(index: number, preflight: PilotPreflight) {
        available();
        pilotTransaction(p, index);
        const old = state.records[index];
        if (old) return structuredClone(old);
        check(
          state.records.length === index &&
            state.records.every((r) => r.phase === "confirmed"),
          "pilot_prior_original_unresolved",
        );
        const balance = uint(preflight.balanceWei);
        check(
          balance > 0n && balance <= uint(state.fundingCapWei),
          "pilot_wallet_funding_fuse",
        );
        check(
          preflight.latestNonce === index && preflight.pendingNonce === index,
          "pilot_nonce_changed",
        );
        if (index === 0) {
          check(state.fundedWei === null, "pilot_funding_already_frozen");
          state.fundedWei = String(balance);
        } else
          check(
            preflight.balanceWei ===
              state.records[index - 1]!.proof?.balanceAfterWei &&
              balance <= uint(state.fundedWei!),
            "pilot_unexplained_wallet_movement",
          );
        const unsigned = pilotUnsigned(p, index),
          r: PilotOriginal = {
            index,
            kind: p.plan.steps[index]!.kind,
            nonce: index,
            unsigned,
            dispatch: "never-attempted",
            originalId: sha256(
              new TextEncoder().encode(
                canonical({ pinHash: p.pinHash, index, unsigned }),
              ),
            ),
            phase: "prepared",
            preflight,
            raw: null,
            hash: null,
            proof: null,
            observations: [],
          };
        state.records.push(r);
        await persist();
        return structuredClone(r);
      },
      async beginSigning(index: number) {
        const r = original(index);
        check(r.phase === "prepared", "pilot_signing_unknown");
        r.phase = "signing";
        await persist();
        return structuredClone(r);
      },
      async signed(index: number, raw: Hex) {
        const r = original(index),
          hash = await verifyPilotRaw(p, index, raw);
        if (r.raw) {
          check(r.raw === raw && r.hash === hash, "pilot_first_raw_changed");
          return structuredClone(r);
        }
        check(r.phase === "signing", "pilot_signing_state_changed");
        r.raw = raw;
        r.hash = hash;
        r.phase = "signed";
        await persist();
        return structuredClone(r);
      },
      async attempted(index: number) {
        const r = original(index);
        check(
          r.raw &&
            r.hash &&
            r.phase === "signed" &&
            r.dispatch === "never-attempted",
          "pilot_original_already_attempted",
        );
        r.dispatch = "attempted";
        r.phase = "attempted";
        await persist();
        return structuredClone(r);
      },
      async audit(index: number, value: unknown) {
        const r = original(index),
          hash = sha256(new TextEncoder().encode(canonical(value)));
        if (!r.observations.some((o) => o.sha256 === hash)) {
          r.observations.push({ sha256: hash, value });
          await persist();
        }
      },
      async observe(index: number, proof: PilotProof) {
        const r = original(index);
        check(r.raw && r.hash, "pilot_original_not_signed");
        if (proof.balanceAfterWei !== undefined)
          check(
            uint(proof.balanceAfterWei) <= uint(r.preflight.balanceWei),
            "pilot_unexplained_wallet_credit",
          );
        const hash = sha256(new TextEncoder().encode(canonical(proof)));
        if (!r.observations.some((o) => o.sha256 === hash))
          r.observations.push({ sha256: hash, value: proof });
        // Absence is expected before the first send. It cannot erase the local
        // durable distinction or promote any attempted/unknown row to signed.
        const absentUnsent =
          r.phase === "signed" &&
          r.dispatch === "never-attempted" &&
          proof.phase === "unknown" &&
          proof.reason === "original_receipt_absent";
        if (!absentUnsent) r.phase = proof.phase;
        if (proof.phase === "confirmed" || proof.phase === "reverted")
          r.proof = proof;
        await persist();
        return structuredClone(r);
      },
      async close() {
        if (closed) return;
        closed = true;
        const before = await lock.stat(),
          current = await stat(lockPath);
        check(
          before.ino === current.ino && before.dev === current.dev,
          "pilot_lock_changed",
        );
        await lock.close();
        await unlink(lockPath);
      },
    };
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
}
export type PilotJournal = Awaited<ReturnType<typeof openPilotJournal>>;
