import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  Transaction,
  coinWithBalance,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import {
  IkaClient,
  getNetworkConfig,
  CoordinatorInnerModule as C,
  SessionsManagerModule,
} from "@ika.xyz/sdk";
import type { BcsType } from "@mysten/bcs";
import { b64, unb64, suiUrl } from "../shared.ts";
import { insist, type Env } from "./store.ts";

export const config = getNetworkConfig("testnet");
export const ikaType = `${config.packages.ikaPackage}::ika::IKA`;
export const operatorAddress =
  "0xe80513f6f72a375ef3fc279f74e904ba4ab244554abbd468559a13a811a82ea6";
export const gasBudget = 100_000_000;
export const feeBudget = {
  dkg: 4_000_000_000n,
  presign: 13_000_000_000n,
  sign: 5_000_000_000n,
  sui: 50_000_000n,
};
export function clients() {
  const sui = new SuiGrpcClient({ network: "testnet", baseUrl: suiUrl });
  return { sui, ika: new IkaClient({ suiClient: sui, config, cache: false }) };
}
export function operator(env: Env) {
  insist(env.SUI_OPERATOR_SECRET_KEY, "operator_not_configured", 503);
  const key = Ed25519Keypair.fromSecretKey(env.SUI_OPERATOR_SECRET_KEY);
  insist(key.toSuiAddress() === operatorAddress, "unexpected_operator", 503);
  return key;
}
export function coordinator(tx: Transaction) {
  return tx.sharedObjectRef({
    objectId: config.objects.ikaDWalletCoordinator.objectID,
    initialSharedVersion:
      config.objects.ikaDWalletCoordinator.initialSharedVersion,
    mutable: true,
  });
}
export function fees(tx: Transaction, amount: bigint) {
  return {
    ika: tx.add(coinWithBalance({ balance: amount, type: ikaType })),
    sui: tx.splitCoins(tx.gas, [feeBudget.sui])[0]!,
  };
}
export function refund(
  tx: Transaction,
  coins: { ika: TransactionObjectArgument; sui: TransactionObjectArgument },
  address: string,
) {
  tx.transferObjects([coins.ika, coins.sui], address);
}
export interface Receipt {
  digest: string;
  events: { type: string; bcs: string }[];
  objects: { id: string; type: string; owner?: string }[];
}
interface Submission {
  bytes: string;
  signatures: string;
  digest: string;
  status: string;
  receipt: string | null;
}
const include = { events: true, effects: true, objectTypes: true } as const;

// A single durable lock protects the operator's gas/IKA objects. An uncertain
// broadcast keeps it locked until the same signed bytes have been reconciled.
export async function submit(
  env: Env,
  attemptId: string,
  kind: string,
  build: () => Promise<{ tx: Transaction; userSignature?: string }>,
): Promise<Receipt> {
  const id = `${attemptId}:${kind}`;
  let saved = await env.DB.prepare("SELECT * FROM submissions WHERE id=?")
    .bind(id)
    .first<Submission>();
  if (saved?.receipt) {
    insist(saved.status === "confirmed", "transaction_failed", 409);
    return JSON.parse(saved.receipt);
  }
  await env.DB.prepare(
    "INSERT INTO operator_lock(id,holder) VALUES(1,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id)
    .run();
  const lock = await env.DB.prepare(
    "SELECT holder FROM operator_lock WHERE id=1",
  ).first<{ holder: string }>();
  insist(lock?.holder === id, "operator_busy_reconciling_transaction", 409);
  const { sui } = clients();
  try {
    if (!saved) {
      const { tx, userSignature } = await build();
      const raw = await tx.build({ client: sui });
      const digest = await tx.getDigest();
      const signature = await operator(env).signTransaction(raw);
      const signatures = [
        ...(userSignature ? [userSignature] : []),
        signature.signature,
      ];
      const inserted = await env.DB.prepare(
        "INSERT INTO submissions(id,attempt_id,kind,digest,bytes,signatures,status,created) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
        .bind(
          id,
          attemptId,
          kind,
          digest,
          b64(raw),
          JSON.stringify(signatures),
          "pending",
          Date.now(),
        )
        .run();
      // Concurrent retries must use the first persisted bytes, never their own build.
      saved = await env.DB.prepare("SELECT * FROM submissions WHERE id=?")
        .bind(id)
        .first<Submission>();
      insist(saved, "submission_not_persisted", 503);
      void inserted;
    }
    let result;
    try {
      result = await sui.getTransaction({
        digest: saved.digest,
        include,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      result = await sui.executeTransaction({
        transaction: unb64(saved.bytes),
        signatures: JSON.parse(saved.signatures),
        include,
        signal: AbortSignal.timeout(25_000),
      });
    }
    const tx = result.Transaction ?? result.FailedTransaction;
    insist(tx.digest === saved.digest, "receipt_digest_mismatch", 503);
    const receipt: Receipt = {
      digest: tx.digest,
      events: (tx.events ?? []).map((e) => ({
        type: e.eventType,
        bcs: b64(e.bcs),
      })),
      objects: (tx.effects?.changedObjects ?? [])
        .filter((o) => o.outputState === "ObjectWrite")
        .map((o) => ({
          id: o.objectId,
          type: tx.objectTypes?.[o.objectId] ?? "",
          owner:
            o.outputOwner?.$kind === "AddressOwner"
              ? o.outputOwner.AddressOwner
              : undefined,
        })),
    };
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE submissions SET status=?,receipt=? WHERE id=?",
      ).bind(
        tx.status.success ? "confirmed" : "failed",
        JSON.stringify(receipt),
        id,
      ),
      env.DB.prepare("DELETE FROM operator_lock WHERE id=1 AND holder=?").bind(
        id,
      ),
    ]);
    insist(tx.status.success, "transaction_failed", 409);
    return receipt;
  } catch (error) {
    if (!saved)
      await env.DB.prepare(
        "DELETE FROM operator_lock WHERE id=1 AND holder=? AND NOT EXISTS(SELECT 1 FROM submissions WHERE id=?)",
      )
        .bind(id, id)
        .run();
    throw error;
  }
}
export function event<T, Input>(
  receipt: Receipt,
  name: string,
  parser: BcsType<T, Input>,
): T {
  const allowed = [
    config.packages.ikaDwallet2pcMpcPackage,
    config.packages.ikaDwallet2pcMpcOriginalPackage,
  ].map(
    (p) =>
      `${config.packages.ikaDwallet2pcMpcOriginalPackage}::sessions_manager::DWalletSessionEvent<${p}::coordinator_inner::${name}>`,
  );
  const found = receipt.events.filter((e) => allowed.includes(e.type));
  insist(found.length === 1, "unexpected_transaction_event", 503);
  return SessionsManagerModule.DWalletSessionEvent(parser).parse(
    unb64(found[0]!.bcs),
  ).event_data;
}
export async function verifyWallet(
  dWalletId: string,
  capId: string,
  shareId: string,
  owner: string,
  active = true,
) {
  const { sui, ika } = clients();
  const [dwallet, share, cap] = await Promise.all([
    ika.getDWallet(dWalletId),
    ika.getEncryptedUserSecretKeyShare(shareId),
    sui.getObject({ objectId: capId, include: { content: true } }),
  ]);
  insist(
    cap.object.owner.$kind === "AddressOwner" &&
      cap.object.owner.AddressOwner === owner,
    "creator_does_not_own_cap",
    409,
  );
  insist(
    cap.object.type ===
      `${config.packages.ikaDwallet2pcMpcOriginalPackage}::coordinator_inner::DWalletCap`,
    "invalid_cap_type",
    409,
  );
  insist(
    C.DWalletCap.parse(cap.object.content).dwallet_id === dWalletId &&
      dwallet.dwallet_cap_id === capId,
    "cap_wallet_mismatch",
    409,
  );
  insist(
    dwallet.curve === 0 &&
      dwallet.public_user_secret_key_share === null &&
      !dwallet.is_imported_key_dwallet &&
      share.dwallet_id === dWalletId,
    "invalid_zero_trust_wallet",
    409,
  );
  if (active)
    insist(
      dwallet.state.$kind === "Active" &&
        share.state.$kind === "KeyHolderSigned",
      "wallet_not_active_yet",
      409,
    );
  return { dwallet, share, ika };
}
