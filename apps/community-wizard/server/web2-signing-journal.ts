import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonical,
  exact,
  insist,
  object,
} from "../../../packages/community/common.ts";
import type {
  ConfiguredGrantSelection,
  Web2PublishingAttachment,
} from "../../../deploy/linux/web2-operator-inputs.ts";
import type {
  OwnerAuthorization,
  SignedOwnerAuthorization,
} from "../../../packages/community/owner-authorization.ts";

export interface SigningJournal {
  schema: "pirate.web2-signing-sidecar/1";
  selection: ConfiguredGrantSelection;
  custodyBindingDigest: `0x${string}`;
  authorization: OwnerAuthorization;
  accepted: SignedOwnerAuthorization | null;
  attachmentPending: boolean;
  attachment: Web2PublishingAttachment | null;
}
/** Separate immutable selection/accepted originals survive a missing or stale
 * current observation. A failed sync never permits the next external effect. */
export async function createWeb2SigningJournal(directory: string) {
  const path = join(directory, "web2-signing-sidecar.json");
  async function syncParent() {
    const file = await open(directory, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async function read<T = SigningJournal>(name: string): Promise<T | null> {
    try {
      const file = await open(
        join(directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const meta = await file.stat();
        insist(
          meta.isFile() &&
            meta.nlink === 1 &&
            meta.uid === process.getuid!() &&
            !(meta.mode & 0o077) &&
            meta.size <= 262144,
          "web2_signing_original_unreadable",
          503,
        );
        return JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function original(name: string, value: unknown) {
    const bytes = JSON.stringify(value) + "\n";
    let file;
    try {
      file = await open(join(directory, name), "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      insist(
        canonical(await read(name)) === canonical(value),
        "web2_signing_original_changed",
        409,
      );
      file = await open(
        join(directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    }
    try {
      if ((await file.stat()).size === 0) await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncParent();
  }
  async function retained() {
    const selected = await read("web2-signing-selection.json"),
      accepted = await read("web2-signing-accepted.json");
    let current = await read("web2-signing-sidecar.json");
    const marker = await read<{ schema: string; selectionDigest: string }>(
      "web2-signing-initialized.json",
    );
    if (marker) {
      exact(object(marker), ["schema", "selectionDigest"]);
      insist(
        marker.schema === "pirate.web2-signing-initialized/1" &&
          selected?.selection.selectionDigest === marker.selectionDigest,
        "web2_signing_original_changed",
        409,
      );
    }
    if (accepted)
      current = {
        ...accepted,
        attachmentPending: current?.attachmentPending ?? false,
        attachment: current?.attachment ?? null,
      };
    else if (!current && selected) current = selected;
    if (current) {
      exact(object(current), [
        "schema",
        "selection",
        "custodyBindingDigest",
        "authorization",
        "accepted",
        "attachmentPending",
        "attachment",
      ]);
      insist(
        current.schema === "pirate.web2-signing-sidecar/1" &&
          selected &&
          canonical({
            ...current,
            accepted: null,
            attachmentPending: false,
            attachment: null,
          }) === canonical(selected),
        "web2_signing_original_changed",
        409,
      );
    }
    return current;
  }
  let value = await retained();
  return {
    get value() {
      return value ? structuredClone(value) : null;
    },
    async reload() {
      const next = await retained();
      if (value) {
        insist(
          next &&
            canonical({
              ...next,
              accepted: null,
              attachmentPending: false,
              attachment: null,
            }) ===
              canonical({
                ...value,
                accepted: null,
                attachmentPending: false,
                attachment: null,
              }),
          "web2_signing_original_changed",
          409,
        );
        if (value.accepted)
          insist(
            !next.accepted ||
              canonical(next.accepted) === canonical(value.accepted),
            "web2_original_authorization_changed",
            409,
          );
        if (value.attachment)
          insist(
            canonical(next.attachment) === canonical(value.attachment),
            "web2_publishing_attachment_changed",
            409,
          );
        // A failed local persistence attempt cannot release its candidate fence.
        value = { ...next, accepted: value.accepted ?? next.accepted };
      } else value = next;
    },
    async save(next: SigningJournal) {
      if (value) {
        insist(
          canonical({
            ...next,
            accepted: null,
            attachmentPending: false,
            attachment: null,
          }) ===
            canonical({
              ...value,
              accepted: null,
              attachmentPending: false,
              attachment: null,
            }),
          "web2_signing_original_changed",
          409,
        );
        if (value.accepted)
          insist(
            canonical(next.accepted) === canonical(value.accepted),
            "web2_original_authorization_changed",
            409,
          );
        if (value.attachment)
          insist(
            canonical(next.attachment) === canonical(value.attachment),
            "web2_publishing_attachment_changed",
            409,
          );
      }
      // Fence a submitted/verified candidate in memory even if persistence
      // fails. This runner can only re-sync these same accepted bytes.
      value = structuredClone(next);
      await original("web2-signing-selection.json", {
        ...next,
        accepted: null,
        attachmentPending: false,
        attachment: null,
      });
      await original("web2-signing-initialized.json", {
        schema: "pirate.web2-signing-initialized/1",
        selectionDigest: next.selection.selectionDigest,
      });
      if (next.accepted)
        await original("web2-signing-accepted.json", {
          ...next,
          attachmentPending: false,
          attachment: null,
        });
      const temporary = path + "." + randomUUID(),
        file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next) + "\n");
        await file.sync();
        await file.close();
        await rename(temporary, path);
        await syncParent();
        value = structuredClone(next);
      } finally {
        await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    },
  };
}
