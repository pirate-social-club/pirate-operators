import type { Address, Hex } from "viem";
import { check } from "../../packages/protocol/index.ts";
import {
  pilotSpendWindow,
  pilotTransaction,
  type PinnedPilot,
} from "./pilot-eip1559-plan.ts";
import {
  pilotPreflight,
  pilotReceipt,
  type PilotRpc,
} from "./pilot-eip1559-reader.ts";
import type { PilotJournal } from "./pilot-eip1559-journal.ts";

export interface ManagedPilotSigner {
  address: Address;
  signTransaction(tx: ReturnType<typeof pilotTransaction>): Promise<Hex>;
}
/** Root installs the existing managed sign-only workflow. No secret reader,
 * funding, host provisioning, replacement, fee bump or auto-resend exists. */
export function pilotRunner(
  p: PinnedPilot,
  journal: PilotJournal,
  rpc: PilotRpc,
  clock: () => number = Date.now,
) {
  let busy = false,
    lastNow = 0;
  const time = () => {
    const now = clock();
    check(Number.isSafeInteger(now) && now >= lastNow, "pilot_clock_invalid");
    lastNow = now;
    return now;
  };
  const live = () =>
    check(time() < p.admission.deadlineMs, "pilot_execution_deadline_reached");
  const locked = async <T>(work: () => Promise<T>) => {
    check(!busy, "pilot_writer_busy");
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };
  const reconcile = async (index: number) => {
    const row = journal.snapshot().records[index];
    check(row?.raw && row.hash, "pilot_original_not_signed");
    try {
      return await journal.observe(
        index,
        await pilotReceipt(p, rpc, row, time),
      );
    } catch {
      return journal.observe(index, {
        phase: "unknown",
        reason: "original_canonical_evidence_unavailable",
      });
    }
  };
  return {
    prepare: (index: number, signer: ManagedPilotSigner) =>
      locked(async () => {
        live();
        pilotTransaction(p, index);
        const existing = journal.snapshot().records[index];
        if (existing?.raw) return existing;
        if (existing)
          check(existing.phase === "prepared", "pilot_signing_unknown");
        for (let i = 0; i < index; i++)
          check(
            (await reconcile(i)).phase === "confirmed",
            "pilot_prior_original_unresolved",
          );
        check(
          signer.address.toLowerCase() === p.admission.wallet.toLowerCase(),
          "pilot_signer_changed",
        );
        const preflight = await pilotPreflight(p, rpc, index, time);
        live();
        if (existing)
          check(
            preflight.balanceWei === existing.preflight.balanceWei,
            "pilot_unexplained_wallet_movement",
          );
        await journal.reserve(index, preflight);
        await journal.audit(index, {
          kind: "before-original-signing",
          preflight,
        });
        await journal.beginSigning(index);
        pilotSpendWindow(p, time(), preflight.anchor);
        // A throw/lost signer response leaves durable signing state, never a
        // new nonce or an automatic second signature request.
        const raw = await signer.signTransaction(pilotTransaction(p, index));
        return journal.signed(index, raw);
      }),
    broadcast: (index: number) =>
      locked(async () => {
        const row = journal.snapshot().records[index];
        check(row?.raw && row.hash, "pilot_original_not_signed");
        if (row.phase !== "signed" || row.dispatch !== "never-attempted")
          return reconcile(index);
        for (let i = 0; i < index; i++)
          check(
            (await reconcile(i)).phase === "confirmed",
            "pilot_prior_original_unresolved",
          );
        live();
        const fresh = await pilotPreflight(p, rpc, index, time);
        live();
        check(
          fresh.balanceWei === row.preflight.balanceWei,
          "pilot_unexplained_wallet_movement",
        );
        await journal.audit(index, {
          kind: "before-original-broadcast",
          preflight: fresh,
        });
        await journal.attempted(index);
        pilotSpendWindow(p, time(), fresh.anchor);
        try {
          const returned = await rpc.request("eth_sendRawTransaction", [
            row.raw,
          ]);
          check(returned === row.hash, "pilot_send_hash_changed");
        } catch {
          return journal.observe(index, {
            phase: "unknown",
            reason: "original_send_response_unavailable",
          });
        }
        return reconcile(index);
      }),
    reconcile: (index: number) => locked(() => reconcile(index)),
  };
}
