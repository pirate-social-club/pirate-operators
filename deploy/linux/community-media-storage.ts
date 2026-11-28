import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import {
  readPrivateJSON,
  immutableRecord,
  canonicalDigest,
  evidenceId,
} from "./installed-records.ts";
import { privateDirectory, type OperationLease } from "./backend-state.ts";
import {
  checkPinListAccess,
  type IpfsTransport,
} from "../../packages/community/ipfs.ts";
import { insist } from "../../packages/community/common.ts";
import type { createManagedKeyClient } from "./managed-key-channel.ts";

/** Community-owned media credential custody. The paired VPS holds the
 * operator's bucket-scoped Filebase IPFS RPC token in this encrypted store;
 * only the local publication component resolves the active generation, and no
 * token value ever leaves the host in a response, journal or evidence record.
 *
 * Ordering is the contract: the read-only pin-list check runs against the
 * submitted plaintext first, and only a passing check is committed as a new
 * generation. Because the provider interaction is read-only, the sole mutation
 * is the local immutable record — a lost reply is recovered by requestId
 * without repeating anything, and a failed replacement never disturbs the
 * previous committed generation. */
export interface CommunityMediaStorageInputs {
  directory: string;
  lease: OperationLease;
  channel: Awaited<ReturnType<typeof createManagedKeyClient>>;
  keyRef: string;
  keyGeneration: number;
  installationId: string;
  send?: IpfsTransport;
  now?: () => number;
}
export interface CommunityMediaGeneration {
  generation: number;
  savedAt: number;
  check: { pinCount: number; responseSha256: string; checkedAt: number };
}
interface CipherRecord extends CommunityMediaGeneration {
  schema: "pirate.community-media-credential/1";
  requestId: string;
  id: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
const CREDENTIAL_ID = "filebase-ipfs-rpc";
const fileName = (generation: number) =>
  evidenceId(CREDENTIAL_ID) + "-" + generation + ".json";

export async function createCommunityMediaStorage(
  input: CommunityMediaStorageInputs,
) {
  await privateDirectory(input.directory);
  const send = input.send ?? ((request: Request) => fetch(request)),
    now = input.now ?? (() => Math.floor(Date.now() / 1000));
  let disposed = false;
  assert(
    input.keyRef.length > 0 &&
      input.keyGeneration > 0 &&
      input.installationId.length > 0,
  );
  const aad = (generation: number) =>
    Buffer.from(
      canonicalDigest({
        id: CREDENTIAL_ID,
        generation,
        installationId: input.installationId,
      }),
    );
  async function generations(): Promise<number[]> {
    const prefix = evidenceId(CREDENTIAL_ID) + "-";
    const result: number[] = [];
    for (const name of await readdir(input.directory)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const digits = name.slice(prefix.length, -".json".length);
      if (!/^[0-9]{1,9}$/.test(digits)) continue;
      const value = Number(digits);
      if (Number.isSafeInteger(value) && value > 0) result.push(value);
    }
    return result.sort((a, b) => a - b);
  }
  async function load(generation: number): Promise<CipherRecord> {
    const record = await readPrivateJSON<CipherRecord>(
      join(input.directory, fileName(generation)),
    );
    assert(
      record.schema === "pirate.community-media-credential/1" &&
        record.id === CREDENTIAL_ID &&
        record.generation === generation,
      "community_media_credential_changed",
    );
    return record;
  }
  async function active(): Promise<CipherRecord | null> {
    const list = await generations();
    if (!list.length) return null;
    return load(list[list.length - 1]!);
  }
  function metadata(record: CipherRecord): CommunityMediaGeneration {
    return {
      generation: record.generation,
      savedAt: record.savedAt,
      check: structuredClone(record.check),
    };
  }
  const api = {
    /** Check the submitted token read-only, then commit that same generation.
     * A declined or unavailable check writes nothing and keeps any previously
     * committed generation active. The plaintext is zeroized on every path. */
    async checkAndSave({
      requestId,
      token,
    }: {
      requestId: string;
      token: string;
    }): Promise<
      | { state: "saved"; generation: number }
      | { state: "declined" }
      | { state: "unavailable" }
    > {
      assert(!disposed);
      await input.lease.assertHeld();
      insist(
        /^[a-f0-9]{16,128}$/.test(requestId),
        "media_storage_request_invalid",
      );
      insist(
        token.length > 0 && token.length <= 1024 && !/[\s\x00-\x1f]/.test(token),
        "media_storage_token_invalid",
      );
      const outcome = await checkPinListAccess(token, send);
      if (outcome.state === "declined") return { state: "declined" };
      if (outcome.state === "unavailable") return { state: "unavailable" };
      const list = await generations();
      const generation = (list[list.length - 1] ?? 0) + 1;
      const value = Buffer.from(token, "utf8");
      const iv = randomBytes(12);
      try {
        await input.channel.withKey(
          input.keyRef,
          input.keyGeneration,
          async (key) => {
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            cipher.setAAD(aad(generation));
            const ciphertext = Buffer.concat([
              cipher.update(value),
              cipher.final(),
            ]);
            const record: CipherRecord = {
              schema: "pirate.community-media-credential/1",
              requestId,
              id: CREDENTIAL_ID,
              generation,
              iv: iv.toString("base64url"),
              tag: cipher.getAuthTag().toString("base64url"),
              ciphertext: ciphertext.toString("base64url"),
              savedAt: now(),
              check: {
                pinCount: outcome.pinCount,
                responseSha256: outcome.responseSha256,
                checkedAt: now(),
              },
            };
            await immutableRecord(
              input.directory,
              evidenceId(CREDENTIAL_ID) + "-" + generation,
              record,
              input.lease,
            );
          },
        );
      } finally {
        value.fill(0);
      }
      return { state: "saved", generation };
    },
    /** Recover a possibly-completed save after a lost reply. The request id is
     * the only handle; no secret is ever required or returned. */
    async reconcile({ requestId }: { requestId: string }): Promise<
      | { state: "saved"; generation: number }
      | { state: "not-saved" }
    > {
      assert(!disposed);
      await input.lease.assertHeld();
      for (const generation of await generations()) {
        const record = await load(generation);
        if (record.requestId === requestId)
          return { state: "saved", generation };
      }
      return { state: "not-saved" };
    },
    /** Secret-free state for wizard display and refresh recovery. */
    async status(): Promise<CommunityMediaGeneration | null> {
      assert(!disposed);
      await input.lease.assertHeld();
      const record = await active();
      return record ? metadata(record) : null;
    },
    /** Resolve the active generation for local publication use only. The
     * plaintext exists inside the action callback and is zeroized after. */
    async useToken<T>(action: (token: string) => Promise<T>): Promise<T> {
      assert(!disposed);
      await input.lease.assertHeld();
      const record = await active();
      insist(record, "media_storage_credential_missing", 409);
      return input.channel.withKey(
        input.keyRef,
        input.keyGeneration,
        async (key) => {
          const decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            Buffer.from(record.iv, "base64url"),
          );
          decipher.setAAD(aad(record.generation));
          decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
          const value = Buffer.concat([
            decipher.update(Buffer.from(record.ciphertext, "base64url")),
            decipher.final(),
          ]);
          try {
            return await action(value.toString("utf8"));
          } finally {
            value.fill(0);
          }
        },
      );
    },
    /** Re-probe the committed credential read-only. The generation itself is
     * never mutated by a check: a declined result is the operator's signal to
     * replace, while the previous generation stays usable until one passes. */
    async recheckActive(): Promise<
      | { state: "missing" }
      | { state: "ok"; pinCount: number }
      | { state: "declined" }
      | { state: "unavailable" }
    > {
      assert(!disposed);
      await input.lease.assertHeld();
      if (!(await active())) return { state: "missing" };
      return api.useToken(async (token) => {
        const outcome = await checkPinListAccess(token, send);
        return outcome.state === "ok"
          ? { state: "ok" as const, pinCount: outcome.pinCount }
          : outcome.state === "declined"
            ? { state: "declined" as const }
            : { state: "unavailable" as const };
      });
    },
    /** Current active generation number, for journal binding without any
     * secret material. Null before the first committed generation. */
    async activeGeneration(): Promise<number | null> {
      assert(!disposed);
      const record = await active();
      return record ? record.generation : null;
    },
    dispose() {
      disposed = true;
    },
  };
  return api;
}
export type CommunityMediaStorage = Awaited<
  ReturnType<typeof createCommunityMediaStorage>
>;
