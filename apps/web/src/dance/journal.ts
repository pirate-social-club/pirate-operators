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
}
export interface DanceJournal {
  reserve(entry: DanceJournalEntry): Promise<DanceJournalEntry>;
  active(scope: DanceJournalScope): Promise<DanceJournalEntry | null>;
  latest(scope: DanceJournalScope): Promise<DanceJournalEntry | null>;
  acknowledge(scope: DanceJournalScope): Promise<void>;
  accept(entry: DanceJournalEntry, receiptJson: string): Promise<void>;
  definiteCaptureReset(scope: DanceJournalScope): Promise<void>;
  rejectExpired(entry: DanceJournalEntry): Promise<void>;
}
interface State {
  active: DanceJournalEntry | null;
  accepted: Record<string, DanceJournalEntry>;
  latest?: DanceJournalEntry;
}
const key = (s: DanceJournalScope) =>
  JSON.stringify([s.communityId, s.accountId]);
export function identicalCommand(a: DanceJournalEntry, b: DanceJournalEntry) {
  return (
    key(a.scope) === key(b.scope) &&
    a.path === b.path &&
    a.bodyJson === b.bodyJson &&
    a.subject === b.subject
  );
}
function state(v: unknown, s: DanceJournalScope): State {
  if (v === undefined) return { active: null, accepted: {} };
  if (!v || typeof v !== "object" || !("active" in v) || !("accepted" in v))
    throw Error("dance_journal_corrupt");
  const result = v as State;
  for (const e of [result.active, ...Object.values(result.accepted)].filter(
    (x): x is DanceJournalEntry => !!x,
  )) {
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
    use: (s: State) => T,
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
    acknowledge: (s) =>
      transact(s, true, (v) => {
        v.latest = undefined;
      }),
    accept: (e, receiptJson) =>
      transact(e.scope, true, (s) => {
        if (
          !s.active ||
          s.active.commandId !== e.commandId ||
          !identicalCommand(s.active, e)
        )
          throw Error("dance_journal_conflict");
        s.accepted[e.subject] = { ...e, receiptJson };
        s.latest = s.accepted[e.subject];
        s.active = null;
      }),
    definiteCaptureReset: (s) =>
      transact(s, true, (v) => {
        if (v.active) throw Error("dance_response_unknown");
        delete v.accepted.capture;
        if (v.latest?.subject === "capture") v.latest = undefined;
      }),
    rejectExpired: (e) =>
      transact(e.scope, true, (s) => {
        if (s.active?.commandId !== e.commandId)
          throw Error("dance_journal_conflict");
        s.active = null;
        delete s.accepted.capture;
      }),
  };
}
