/** Owned durable command codec, adapted from pinned centralized owner/review
 * recovery. No auth tokens, media bytes or playback URLs. Atomic IndexedDB
 * reservation serializes competing tabs BEFORE dispatch. */
export interface DanceJournalScope {
  communityId: string;
  accountId: string;
}
export interface DanceJournalEntry {
  version: 1;
  scope: DanceJournalScope;
  commandId: string;
  subject: string;
  path: string;
  bodyJson: string;
  receiptJson?: string;
  /** Prepared metadata only; never added to the HTTP body. */
  targetKey?: string;
  requestJson?: string;
  attempted?: true;
}
export interface DanceJournal {
  reserve(entry: DanceJournalEntry): Promise<DanceJournalEntry>;
  active(scope: DanceJournalScope): Promise<DanceJournalEntry | null>;
  latest(scope: DanceJournalScope): Promise<DanceJournalEntry | null>;
  acknowledge(scope: DanceJournalScope, commandId?: string): Promise<void>;
  accept(entry: DanceJournalEntry, receiptJson: string): Promise<void>;
  definiteCaptureReset(
    scope: DanceJournalScope,
    expected?: { commandId: string; captureId: string },
  ): Promise<void>;
  rejectExpired(entry: DanceJournalEntry): Promise<void>;
  command?(
    scope: DanceJournalScope,
    commandId: string,
  ): Promise<DanceJournalEntry | null>;
  acceptedCapture?(scope: DanceJournalScope): Promise<DanceJournalEntry | null>;
  markDispatch?(entry: DanceJournalEntry): Promise<DanceJournalEntry>;
}
export interface DanceJournalState {
  active: DanceJournalEntry | null;
  accepted: Record<string, DanceJournalEntry>;
  latest?: DanceJournalEntry;
  history?: Record<string, DanceJournalEntry>;
}
const key = (s: DanceJournalScope) =>
  JSON.stringify([s.communityId, s.accountId]);
export function identicalCommand(a: DanceJournalEntry, b: DanceJournalEntry) {
  return (
    key(a.scope) === key(b.scope) &&
    a.path === b.path &&
    a.bodyJson === b.bodyJson &&
    a.targetKey === b.targetKey &&
    a.subject === b.subject
  );
}
export function sameOriginalCommand(
  a: DanceJournalEntry,
  b: DanceJournalEntry,
) {
  return (
    identicalCommand(a, b) &&
    a.commandId === b.commandId &&
    a.requestJson === b.requestJson
  );
}
function state(v: unknown, s: DanceJournalScope): DanceJournalState {
  if (v === undefined) return { active: null, accepted: {} };
  if (!v || typeof v !== "object" || !("active" in v) || !("accepted" in v))
    throw Error("dance_journal_corrupt");
  const result = v as DanceJournalState;
  for (const e of [
    result.active,
    result.latest,
    ...Object.values(result.accepted),
    ...Object.values(result.history ?? {}),
  ].filter((x): x is DanceJournalEntry => !!x)) {
    if (
      e.version !== 1 ||
      key(e.scope) !== key(s) ||
      typeof e.commandId !== "string" ||
      typeof e.path !== "string" ||
      typeof e.bodyJson !== "string"
    )
      throw Error("dance_journal_corrupt");
    const body = JSON.parse(e.bodyJson);
    if (!body || typeof body !== "object" || "commandId" in body)
      throw Error("dance_journal_corrupt");
    if (
      (e.targetKey !== undefined && typeof e.targetKey !== "string") ||
      (e.requestJson !== undefined &&
        e.requestJson !==
          JSON.stringify({ ...body, commandId: e.commandId })) ||
      (e.attempted !== undefined && e.attempted !== true)
    )
      throw Error("dance_journal_corrupt");
  }
  return result;
}
export function createIndexedDanceJournal(
  factory: IDBFactory = globalThis.indexedDB,
): DanceJournal {
  let connection: Promise<IDBDatabase> | undefined;
  function db() {
    if (!factory) return Promise.reject(Error("dance_journal_unavailable"));
    return (connection ??= new Promise((resolve, reject) => {
      const r = factory.open("pirate-dance-command-journal-v1", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("commands");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  async function transact<T>(
    scope: DanceJournalScope,
    write: boolean,
    use: (s: DanceJournalState) => T,
  ): Promise<T> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("commands", write ? "readwrite" : "readonly"),
        store = tx.objectStore("commands"),
        r = store.get(key(scope));
      let value: T;
      r.onsuccess = () => {
        try {
          const s = state(r.result, scope);
          value = use(s);
          if (write) store.put(s, key(scope));
        } catch (e) {
          tx.abort();
          reject(e);
        }
      };
      tx.oncomplete = () => resolve(value!);
      tx.onerror = () => reject(tx.error ?? Error("dance_journal_unavailable"));
      tx.onabort = () => reject(tx.error ?? Error("dance_journal_unavailable"));
    });
  }
  return danceJournalOperations(transact);
}
export type DanceJournalTransaction = <T>(
  scope: DanceJournalScope,
  write: boolean,
  use: (state: DanceJournalState) => T,
) => Promise<T>;
/** Shared production operations. The browser uses the IndexedDB transaction
 * above; pure regressions inject only the durable storage boundary. */
export function danceJournalOperations(
  transact: DanceJournalTransaction,
): DanceJournal {
  const entries = (s: DanceJournalState) =>
    [
      s.active,
      s.latest,
      ...Object.values(s.accepted),
      ...Object.values(s.history ?? {}),
    ].filter((e): e is DanceJournalEntry => !!e);
  return {
    reserve: (e) =>
      transact(e.scope, true, (s) => {
        if (s.active) return s.active;
        if (s.accepted[e.subject]) return s.accepted[e.subject];
        s.active = e;
        return e;
      }),
    active: (s) => transact(s, false, (v) => v.active),
    latest: (s) => transact(s, false, (v) => v.latest ?? null),
    acknowledge: (s, commandId) =>
      transact(s, true, (v) => {
        if (commandId === undefined || v.latest?.commandId === commandId)
          v.latest = undefined;
      }),
    accept: (e, receiptJson) =>
      transact(e.scope, true, (s) => {
        if (
          !s.active ||
          s.active.commandId !== e.commandId ||
          !sameOriginalCommand(s.active, e)
        ) {
          const old = s.accepted[e.subject];
          if (
            old &&
            sameOriginalCommand(old, e) &&
            old.receiptJson === receiptJson
          )
            return;
          throw Error("dance_journal_conflict");
        }
        s.accepted[e.subject] = { ...e, receiptJson };
        s.latest = s.accepted[e.subject];
        s.active = null;
      }),
    definiteCaptureReset: (s, expected) =>
      transact(s, true, (v) => {
        if (v.active) throw Error("dance_response_unknown");
        const old = v.accepted.capture;
        if (
          expected &&
          (!old ||
            old.commandId !== expected.commandId ||
            !old.receiptJson ||
            (JSON.parse(old.receiptJson) as { captureId?: string })
              .captureId !== expected.captureId)
        )
          throw Error("dance_capture_reset_changed");
        if (old) (v.history ??= {})[old.commandId] = old;
        delete v.accepted.capture;
        const captureId =
          expected?.captureId ??
          (old?.receiptJson
            ? (JSON.parse(old.receiptJson) as { captureId?: string }).captureId
            : undefined);
        for (const e of entries(v))
          if (
            captureId &&
            (e.subject === "submission:" + captureId ||
              e.subject === "withdraw:" + captureId)
          )
            (v.history ??= {})[e.commandId] = e;
        if (
          v.latest?.subject === "capture" ||
          (captureId &&
            ["submission:" + captureId, "withdraw:" + captureId].includes(
              v.latest?.subject ?? "",
            ))
        )
          v.latest = undefined;
      }),
    rejectExpired: (e) =>
      transact(e.scope, true, (s) => {
        if (!s.active || !sameOriginalCommand(s.active, e))
          throw Error("dance_journal_conflict");
        s.active = null;
        (s.history ??= {})[e.commandId] = e;
        delete s.accepted.capture;
      }),
    command: (scope, id) =>
      transact(
        scope,
        false,
        (s) => entries(s).find((e) => e.commandId === id) ?? null,
      ),
    acceptedCapture: (scope) =>
      transact(scope, false, (s) => s.accepted.capture ?? null),
    markDispatch: (e) =>
      transact(e.scope, true, (s) => {
        const found = entries(s).find((v) => v.commandId === e.commandId);
        if (!found || !sameOriginalCommand(found, e))
          throw Error("dance_original_command_changed");
        if (found.receiptJson) return found;
        if (!s.active || !sameOriginalCommand(s.active, e))
          throw Error("dance_other_command_pending");
        s.active = { ...s.active, attempted: true };
        return s.active;
      }),
  };
}
