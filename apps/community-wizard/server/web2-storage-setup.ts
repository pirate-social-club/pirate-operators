import { exact, insist } from "../../../packages/community/common.ts";
import type { CommunityMediaStorage } from "../../../deploy/linux/community-media-storage.ts";

/** Wizard-facing orchestration of the community media credential vault. The
 * vault is the durable record, so this module keeps no journal of its own:
 * refresh and restart recovery read the committed generations back exactly,
 * and an interrupted save is recovered through the operator-held request id
 * without the token ever being asked for again. No secret value appears in
 * any view or outcome. */
export interface Web2MediaStorageView {
  state: "empty" | "saved";
  generation?: number;
  savedAt?: number;
  pinCount?: number;
  checkedAt?: number;
  observation?: {
    outcome: "ok" | "declined" | "unavailable";
    checkedAt: number;
    pinCount?: number;
  };
}

export function createWeb2StorageSetup(input: {
  storage: CommunityMediaStorage | null;
}) {
  async function read(): Promise<Web2MediaStorageView | null> {
    if (!input.storage) return null;
    const status = await input.storage.status();
    if (!status) return { state: "empty" };
    return {
      state: "saved",
      generation: status.generation,
      savedAt: status.savedAt,
      pinCount: status.check.pinCount,
      checkedAt: status.check.checkedAt,
      observation: structuredClone(status.observation),
    };
  }
  return {
    read,
    async act(
      action: string,
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      insist(input.storage, "media_storage_unavailable", 503);
      if (action === "storage-save") {
        exact(body, ["token", "requestId", "baseGeneration"]);
        insist(
          typeof body.token === "string" &&
            typeof body.requestId === "string" &&
            (body.baseGeneration === null ||
              (Number.isSafeInteger(body.baseGeneration) &&
                (body.baseGeneration as number) > 0)),
          "media_storage_input_invalid",
        );
        const outcome = await input.storage.checkAndSave({
          requestId: body.requestId,
          token: body.token,
          baseGeneration: body.baseGeneration as number | null,
        });
        return { action, ...outcome };
      }
      if (action === "storage-reconcile") {
        exact(body, ["requestId"]);
        insist(typeof body.requestId === "string", "media_storage_input_invalid");
        const outcome = await input.storage.reconcile({
          requestId: body.requestId,
        });
        return { action, ...outcome };
      }
      if (action === "storage-check") {
        exact(body, []);
        const outcome = await input.storage.recheckActive();
        insist(
          outcome.state !== "missing",
          "media_storage_credential_missing",
          409,
        );
        return { action, ...outcome };
      }
      insist(false, "unknown_web2_action", 404);
    },
  };
}
export type Web2StorageSetup = ReturnType<typeof createWeb2StorageSetup>;
