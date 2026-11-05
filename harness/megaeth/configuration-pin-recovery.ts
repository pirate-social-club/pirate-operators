import { access, copyFile, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  canonical,
  hashJson,
  hashText,
  insist,
} from "../../packages/community/common.ts";
import {
  reconcilePin,
  type IpfsTransport,
} from "../../packages/community/ipfs.ts";
import { saveConfigurationState } from "./configuration-state.ts";
import type { configurationPlan } from "./configuration-plan.ts";

type Planned = Awaited<ReturnType<typeof configurationPlan>>;
/** Exact pin-only predecessor adoption. No upload, signing, broadcast,
 * credential creation or EVM state adoption exists in this recovery path. */
export async function adoptConfigurationPin(
  directory: string,
  planned: Planned,
  token: string,
  transport?: IpfsTransport,
) {
  const recovery = planned.profile.pinRecovery;
  const previous = JSON.parse(
    await readFile(recovery.previousPlanPath, "utf8"),
  );
  insist(
    previous.profileHash === recovery.previousProfileHash &&
      hashJson(previous.profile) === recovery.previousProfileHash,
    "configuration_predecessor_plan_mismatch",
  );
  const comparable = (profile: Record<string, unknown>, successor: boolean) => {
    const { sourceHashes, retrievalGateways, pinRecovery, ...rest } = profile;
    return {
      ...rest,
      bounds: {
        ...(rest.bounds as Record<string, unknown>),
        pinAdds: successor
          ? 1
          : (rest.bounds as Record<string, unknown>).pinAdds,
      },
    };
  };
  insist(
    planned.profile.bounds.pinAdds === 0 &&
      canonical(comparable(previous.profile, false)) ===
        canonical(comparable(planned.profile, true)),
    "configuration_pin_recovery_changes_intent",
  );
  insist(
    !(await access(join(directory, "evm/transactions.json")).then(
      () => true,
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      },
    )),
    "configuration_pin_recovery_has_evm_journal",
    409,
  );
  const originalBytes = await readFile(join(directory, "pin.json"), "utf8"),
    original = JSON.parse(originalBytes);
  insist(
    original.profileHash === recovery.previousProfileHash &&
      original.state === "running" &&
      !original.result,
    "configuration_pin_predecessor_state_changed",
    409,
  );
  const receiptBytes = await readFile(
      join(directory, "pin-receipt.json"),
      "utf8",
    ),
    receipt = JSON.parse(receiptBytes);
  insist(
    hashText(receiptBytes) === recovery.expectedReceiptFileSha256 &&
      receipt.profileHash === recovery.previousProfileHash &&
      receipt.status === 200 &&
      receipt.requestId === recovery.expectedProviderRequestId &&
      hashText(receipt.body) === receipt.bodySha256 &&
      receipt.bodySha256 === recovery.expectedBodySha256,
    "configuration_pin_predecessor_receipt_changed",
    409,
  );
  const body = JSON.parse(receipt.body);
  insist(
    `ipfs://${body.Hash}` === planned.profile.pin.uri &&
      Number(body.Size) === planned.profile.pin.byteLength,
    "configuration_pin_predecessor_identity_changed",
    409,
  );
  // Current retention and independently fetched bytes must pass before any
  // local adoption. Read failure leaves the predecessor untouched.
  const result = await reconcilePin(planned.profile.pin, token, transport);
  const backup = join(directory, "pin-before-gateway-update.json");
  try {
    await copyFile(
      join(directory, "pin.json"),
      backup,
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    insist(
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
        (await readFile(backup, "utf8")) === originalBytes,
      "configuration_pin_recovery_backup_conflict",
      409,
    );
  }
  const saved = await open(backup, "r");
  try {
    await saved.sync();
  } finally {
    await saved.close();
  }
  const successor = {
    profileHash: planned.profileHash,
    state: "confirmed",
    result,
    adoption: {
      previousProfileHash: recovery.previousProfileHash,
      originalStateSha256: hashText(originalBytes),
      originalReceiptFileSha256: hashText(receiptBytes),
      at: new Date().toISOString(),
    },
  };
  await saveConfigurationState(directory, "pin.json", successor);
  return successor;
}
