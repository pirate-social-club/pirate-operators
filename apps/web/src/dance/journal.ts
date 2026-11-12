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
  /** Actual HTTP refusal bound to this original preimage, never a local clock. */
  outcome?: DanceExpiredOutcome;
}
export interface DanceExpiredOutcome {
  version: "pirate.dance-command-outcome/1";
  status: 410;
  code: "dance_capture_expired";
}
export function hasDanceExpiredOutcome(entry: DanceJournalEntry): boolean {
  const outcome = entry.outcome;
  return (
    !!outcome &&
    Object.keys(outcome).length === 3 &&
    outcome.version === "pirate.dance-command-outcome/1" &&
    outcome.status === 410 &&
    outcome.code === "dance_capture_expired" &&
    !entry.receiptJson &&
    ["captures", "reviews"].includes(entry.path)
  );
}
export type DanceCaptureReset =
  | { commandId: string; captureId: string }
  | { captureId: string; keepUnrelated: true };
export interface DanceJournal {
  reserve(entry: DanceJournalEntry): Promise<DanceJournalEntry>;
  active(scope: DanceJournalScope): Promise<DanceJournalEntry | null>;
  latest(scope: DanceJournalScope): Promise<DanceJournalEntry | null>;
  acknowledge(scope: DanceJournalScope, commandId?: string): Promise<void>;
  accept(entry: DanceJournalEntry, receiptJson: string): Promise<void>;
  definiteCaptureReset(
    scope: DanceJournalScope,
    expected?: DanceCaptureReset,
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
    if (e.outcome !== undefined && !hasDanceExpiredOutcome(e))
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
  const captureId = (entry: DanceJournalEntry, scope: DanceJournalScope) => {
    if (
      entry.path !== "captures" ||
      entry.subject !== "capture" ||
      !entry.receiptJson ||
      entry.outcome ||
      key(entry.scope) !== key(scope)
    )
      throw Error("dance_capture_reset_changed");
    const capture = JSON.parse(entry.receiptJson) as {
      captureId?: unknown;
      communityId?: unknown;
      learner?: { accountId?: unknown };
    };
    if (
      typeof capture.captureId !== "string" ||
      !capture.captureId ||
      capture.communityId !== scope.communityId ||
      capture.learner?.accountId !== scope.accountId
    )
      throw Error("dance_capture_reset_changed");
    return capture.captureId;
  };
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
        const oldId = old ? captureId(old, s) : undefined;
        if (
          expected &&
          (typeof expected.captureId !== "string" ||
            !expected.captureId ||
            ("keepUnrelated" in expected && expected.keepUnrelated !== true))
        )
          throw Error("dance_capture_reset_changed");
        if (
          expected &&
          "commandId" in expected &&
          (!old ||
            old.commandId !== expected.commandId ||
            oldId !== expected.captureId)
        )
          throw Error("dance_capture_reset_changed");
        const requestedId = expected?.captureId ?? oldId;
        if (old && oldId === requestedId) {
          (v.history ??= {})[old.commandId] = old;
          delete v.accepted.capture;
        }
        for (const e of entries(v))
          if (
            requestedId &&
            (e.subject === "submission:" + requestedId ||
              e.subject === "withdraw:" + requestedId)
          )
            (v.history ??= {})[e.commandId] = e;
        if (
          (v.latest?.subject === "capture" &&
            (v.latest.outcome
              ? v.latest.commandId === old?.commandId
              : captureId(v.latest, s) === requestedId)) ||
          (requestedId &&
            ["submission:" + requestedId, "withdraw:" + requestedId].includes(
              v.latest?.subject ?? "",
            ))
        )
          v.latest = undefined;
      }),
    rejectExpired: (e) =>
      transact(e.scope, true, (s) => {
        const previous = entries(s).find(
          (row) => row.commandId === e.commandId,
        );
        if (
          previous &&
          sameOriginalCommand(previous, e) &&
          hasDanceExpiredOutcome(previous)
        )
          return;
        if (
          !s.active ||
          !sameOriginalCommand(s.active, e) ||
          s.active.outcome ||
          e.receiptJson ||
          !["captures", "reviews"].includes(e.path)
        )
          throw Error("dance_journal_conflict");
        const expired: DanceJournalEntry = {
          ...s.active,
          outcome: {
            version: "pirate.dance-command-outcome/1",
            status: 410,
            code: "dance_capture_expired",
          },
        };
        s.active = null;
        (s.history ??= {})[e.commandId] = expired;
        s.latest = expired;
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
        if (found.receiptJson || hasDanceExpiredOutcome(found)) return found;
        if (!s.active || !sameOriginalCommand(s.active, e))
          throw Error("dance_other_command_pending");
        s.active = { ...s.active, attempted: true };
        return s.active;
      }),
  };
}
