import { canonical, bytes32, hashJson, insist } from "../community/common.ts";
import {
  configureBudget,
  reserveBudget,
  settleBudget,
} from "../community/budgets.ts";
import {
  addPin,
  preparePin,
  reconcilePin,
  type PinIntent,
  type IpfsTransport,
} from "../community/ipfs.ts";

interface PinRow {
  operation_id: string;
  request_hash: string;
  grant_hash: string;
  intent_json: string;
  state: "prepared" | "running" | "uncertain" | "confirmed";
  result_json: string | null;
}
export interface PinGrant {
  sha256: string;
  period: string;
  maximumAdds: number;
}
export type RetainedPin = Awaited<ReturnType<typeof reconcilePin>>;
export type PinStatus =
  | { state: "confirmed"; pin: RetainedPin }
  | { state: "uncertain" };
/** One add attempt for an immutable pin operation. Unknown responses keep their
 * quota reservation. Every later wakeup is retention/retrieval reconciliation;
 * absence from pin/ls never authorizes another non-idempotent add. */
export async function fundedPin(
  db: D1Database,
  id: string,
  grant: PinGrant,
  intent: PinIntent,
  bytes: Uint8Array,
  credential: string,
  send?: IpfsTransport,
): Promise<PinStatus> {
  bytes32(id);
  bytes32(grant.sha256);
  insist(
    Number.isSafeInteger(grant.maximumAdds) &&
      grant.maximumAdds >= 1 &&
      grant.maximumAdds <= 10,
    "invalid_pin_grant",
    503,
  );
  insist(
    canonical(await preparePin(bytes, intent.mediaType)) === canonical(intent),
    "funded_pin_input_changed",
    409,
  );
  const requestHash = hashJson({ grant, intent });
  const keys = [
    {
      scope: `release:pins:${grant.sha256}`,
      period: grant.period,
      asset: "ipfs_add_attempts",
    },
  ];
  await configureBudget(db, keys[0]!, String(grant.maximumAdds));
  await reserveBudget(db, id, requestHash, keys, "1");
  await db
    .prepare(
      "INSERT INTO funded_pins(operation_id,request_hash,grant_hash,intent_json,state,created_at) VALUES(?,?,?,?,'prepared',?) ON CONFLICT DO NOTHING",
    )
    .bind(id, requestHash, grant.sha256, canonical(intent), Date.now())
    .run();
  const load = async () => {
    const row = await db
      .prepare("SELECT * FROM funded_pins WHERE operation_id=?")
      .bind(id)
      .first<PinRow>();
    insist(
      row &&
        row.request_hash === requestHash &&
        row.grant_hash === grant.sha256 &&
        row.intent_json === canonical(intent),
      "funded_pin_intent_changed",
      409,
    );
    return row;
  };
  const row = await load();
  if (row.state === "confirmed") {
    insist(row.result_json, "funded_pin_receipt_missing", 503);
    try {
      await reconcilePin(intent, credential, send);
    } catch {
      return { state: "uncertain" };
    }
    await settleBudget(db, id, keys, "1");
    return {
      state: "confirmed",
      pin: JSON.parse(row.result_json) as RetainedPin,
    };
  }
  const claimed =
    row.state === "prepared"
      ? await db
          .prepare(
            "UPDATE funded_pins SET state='running' WHERE operation_id=? AND state='prepared' RETURNING operation_id",
          )
          .bind(id)
          .first()
      : null;
  try {
    const pin = claimed
      ? await addPin(
          intent,
          bytes,
          credential,
          async (receipt) => {
            const saved = canonical(receipt);
            await db
              .prepare(
                "UPDATE funded_pins SET provider_receipt_json=? WHERE operation_id=? AND provider_receipt_json IS NULL",
              )
              .bind(saved, id)
              .run();
            const retained = await db
              .prepare(
                "SELECT provider_receipt_json FROM funded_pins WHERE operation_id=?",
              )
              .bind(id)
              .first<{ provider_receipt_json: string }>();
            insist(
              retained?.provider_receipt_json === saved,
              "funded_pin_provider_receipt_changed",
              409,
            );
          },
          send,
        )
      : await reconcilePin(intent, credential, send);
    await db
      .prepare(
        "UPDATE funded_pins SET state='confirmed',result_json=? WHERE operation_id=? AND state IN ('running','uncertain')",
      )
      .bind(canonical(pin), id)
      .run();
    const saved = await load();
    insist(
      saved.state === "confirmed" && saved.result_json,
      "funded_pin_result_uncommitted",
      503,
    );
    await settleBudget(db, id, keys, "1");
    return {
      state: "confirmed",
      pin: JSON.parse(saved.result_json) as RetainedPin,
    };
  } catch {
    await db
      .prepare(
        "UPDATE funded_pins SET state='uncertain' WHERE operation_id=? AND state='running'",
      )
      .bind(id)
      .run();
    return { state: "uncertain" };
  }
}
