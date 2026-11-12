// Original c7 retain/restore/removeLocal controller, adapted to the actual V5
// capture receipt and asynchronous durable journal (no central/localStorage API).
import type { DanceRecordedTake } from "./dance-capture.ts";
import type { DancePreparationView } from "./dance-preparation-controller.ts";
import {
  assertCapture,
  assertCurrent,
  danceTargetKey,
  type DanceSourcePorts,
} from "./ports.ts";

export interface DanceRecordingMetadata {
  readonly version: 1;
  readonly accountId: string;
  readonly targetKey: string;
  readonly sessionId: string;
  readonly termsHash: string;
  readonly captureHash: string;
  readonly consentReceiptId: string;
  readonly durationMs: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly storedAtMs: number;
  readonly expiresAtMs: number;
}
export interface StoredDanceRecording {
  readonly metadataJson: string;
  readonly blob: Blob;
}
export interface DanceRecordingStorage {
  exclusive<T>(sessionId: string, use: () => Promise<T>): Promise<T>;
  load(
    sessionId: string,
    guard: () => void,
  ): Promise<StoredDanceRecording | null>;
  add(record: StoredDanceRecording, guard: () => void): Promise<void>;
  remove(sessionId: string, guard: () => void): Promise<void>;
  pruneExpired(nowMs: number, guard: () => void): Promise<void>;
}
export function decodeDanceRecordingMetadata(
  raw: string,
  accountId: string,
): DanceRecordingMetadata {
  try {
    const m = JSON.parse(raw) as DanceRecordingMetadata;
    if (
      !m ||
      Object.keys(m).length !== 12 ||
      m.version !== 1 ||
      m.accountId !== accountId ||
      ![
        m.accountId,
        m.targetKey,
        m.sessionId,
        m.termsHash,
        m.captureHash,
        m.consentReceiptId,
      ].every((v) => typeof v === "string" && v.length > 0) ||
      !/^[a-f0-9]{64}$/.test(m.sha256) ||
      ![m.durationMs, m.byteLength, m.expiresAtMs].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      !Number.isSafeInteger(m.storedAtMs) ||
      m.storedAtMs < 0 ||
      m.expiresAtMs <= m.storedAtMs
    )
      throw Error();
    return m;
  } catch {
    throw Error("dance_recording_corrupt");
  }
}
export function decodeStoredDanceRecording(
  value: unknown,
  accountId: string,
): StoredDanceRecording {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 2 ||
    !("metadataJson" in value) ||
    typeof value.metadataJson !== "string" ||
    !("blob" in value) ||
    !(value.blob instanceof Blob)
  )
    throw Error("dance_recording_corrupt");
  const metadata = decodeDanceRecordingMetadata(value.metadataJson, accountId);
  if (
    value.blob.size !== metadata.byteLength ||
    value.blob.type !== "video/mp4"
  )
    throw Error("dance_recording_corrupt");
  return { metadataJson: value.metadataJson, blob: value.blob };
}
export async function danceRecordingDigest(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function createDanceRecordingController(
  options: DanceSourcePorts & { readonly storage: DanceRecordingStorage },
) {
  const scope = Object.freeze({ ...options.scope }),
    key = danceTargetKey(scope),
    storage = options.storage,
    now = options.nowMs ?? Date.now;
  const current = (signal: AbortSignal) => assertCurrent(options, signal);
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw Error("dance_recording_clock_unavailable");
    return value;
  };
  const matches = async (
    metadata: DanceRecordingMetadata,
    guard: () => void,
  ) => {
    const entry = await options.journal.read(scope, guard);
    guard();
    const c = entry.capture;
    if (!c) throw Error("dance_recording_target_changed");
    assertCapture(c, scope);
    if (
      metadata.targetKey !== key ||
      metadata.sessionId !== c.captureId ||
      metadata.termsHash !== c.termsHash ||
      metadata.captureHash !== c.captureHash ||
      metadata.consentReceiptId !== c.consent?.receiptId ||
      metadata.expiresAtMs !== c.expiresAtMs ||
      metadata.durationMs !== c.durationSamples / 48
    )
      throw Error("dance_recording_target_changed");
  };
  const verify = async (
    record: StoredDanceRecording,
    sessionId: string,
    guard: () => void,
  ) => {
    guard();
    record = decodeStoredDanceRecording(record, scope.accountId);
    const metadata = decodeDanceRecordingMetadata(
      record.metadataJson,
      scope.accountId,
    );
    if (metadata.sessionId !== sessionId || metadata.targetKey !== key)
      throw Error("dance_recording_target_changed");
    const digest = await danceRecordingDigest(record.blob);
    guard();
    if (digest !== metadata.sha256) throw Error("dance_recording_corrupt");
    return { metadata, blob: record.blob };
  };
  return {
    async cleanupExpired(signal: AbortSignal) {
      const guard = () => current(signal);
      guard();
      await storage.pruneExpired(time(), guard);
      guard();
    },
    async retain(
      ready: Extract<DancePreparationView, { kind: "capture_ready" }>,
      take: DanceRecordedTake,
      signal: AbortSignal,
    ) {
      take = { ...take };
      const session = ready.session,
        c = session.capture,
        file = take.file;
      const guard = () => {
        current(signal);
        ready.assertCurrent();
        if (time() >= session.expires_at_ms)
          throw Error("dance_recording_expired");
      };
      guard();
      assertCapture(c, scope);
      if (
        take.sessionId !== c.captureId ||
        take.termsHash !== c.termsHash ||
        take.durationMs !== c.durationSamples / 48 ||
        file.type !== "video/mp4" ||
        file.size === 0 ||
        file.size > session.maximum_bytes
      )
        throw Error("dance_recording_target_changed");
      await storage.pruneExpired(time(), guard);
      guard();
      const sha256 = await danceRecordingDigest(file);
      guard();
      return storage.exclusive(session.session_id, async () => {
        guard();
        const metadata: DanceRecordingMetadata = {
          version: 1,
          accountId: scope.accountId,
          targetKey: key,
          sessionId: c.captureId,
          termsHash: c.termsHash,
          captureHash: c.captureHash,
          consentReceiptId: c.consent!.receiptId,
          durationMs: take.durationMs,
          byteLength: file.size,
          sha256,
          storedAtMs: time(),
          expiresAtMs: c.expiresAtMs,
        };
        await matches(metadata, guard);
        guard();
        let retained = await storage.load(c.captureId, guard);
        guard();
        if (retained === null) {
          retained = { metadataJson: JSON.stringify(metadata), blob: file };
          decodeStoredDanceRecording(retained, scope.accountId);
          await storage.add(retained, guard);
          guard();
          retained = await storage.load(c.captureId, guard);
          guard();
          if (!retained) throw Error("dance_recording_storage_unconfirmed");
        }
        const original = await verify(retained, c.captureId, guard);
        await matches(original.metadata, guard);
        guard();
        if (
          original.metadata.sha256 !== sha256 ||
          original.metadata.byteLength !== file.size ||
          original.metadata.durationMs !== take.durationMs ||
          original.metadata.expiresAtMs !== c.expiresAtMs
        )
          throw Error("dance_recording_original_required");
        return original;
      });
    },
    async restore(sessionId: string, signal: AbortSignal) {
      const guard = () => current(signal);
      guard();
      await storage.pruneExpired(time(), guard);
      guard();
      return storage.exclusive(sessionId, async () => {
        guard();
        const retained = await storage.load(sessionId, guard);
        guard();
        if (!retained) return null;
        const original = await verify(retained, sessionId, guard);
        if (time() >= original.metadata.expiresAtMs) {
          await storage.remove(sessionId, guard);
          guard();
          return null;
        }
        await matches(original.metadata, guard);
        guard();
        return original;
      });
    },
    async removeLocal(sessionId: string, signal: AbortSignal) {
      const guard = () => current(signal);
      guard();
      await storage.exclusive(sessionId, async () => {
        const record = await storage.load(sessionId, guard);
        guard();
        if (!record) return;
        const metadata = decodeDanceRecordingMetadata(
          record.metadataJson,
          scope.accountId,
        );
        if (metadata.sessionId !== sessionId || metadata.targetKey !== key)
          throw Error("dance_recording_target_changed");
        await storage.remove(sessionId, guard);
        guard();
      });
    },
  };
}
