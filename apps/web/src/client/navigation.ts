// Pure client decisions: deployment mode, routes, the public record store and
// the data source.
import { clientRoutes, isSlug, paths, type CommunityConfig, type PostRecord, type PublicCommunity, type PublicPost } from "../model.ts";

export type Mode = "canonical" | "mirror";

/**
 * A page is canonical only on the configured canonical origin. Any other
 * origin (an IPFS subdomain or DNSLink gateway, another host) is a read-only
 * mirror: no session or mutation requests, actions link to the canonical origin.
 */
export function resolveMode(pageOrigin: string, config: Pick<CommunityConfig, "canonicalOrigin">): Mode {
  return pageOrigin === new URL(config.canonicalOrigin).origin ? "canonical" : "mirror";
}

/**
 * The same path on the canonical origin. The path is assigned to a URL that
 * already carries the canonical origin, after collapsing leading slashes and
 * backslashes, so a network-path reference such as //other.example/x cannot
 * change the host whatever the serving gateway's normalization. The result's
 * origin is checked before it is returned.
 */
export function canonicalHref(config: Pick<CommunityConfig, "canonicalOrigin">, pathname: string): string {
  const canonical = new URL(config.canonicalOrigin).origin;
  const url = new URL(canonical);
  url.pathname = `/${pathname.replace(/^[/\\]+/, "")}`;
  return url.origin === canonical ? url.href : `${canonical}/`;
}

export type Route =
  | { readonly kind: "community" }
  | { readonly kind: "post"; readonly slug: string }
  | { readonly kind: "about" }
  | { readonly kind: "not-found" };

export function matchRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "/index.html") return { kind: "community" };
  if ((clientRoutes as readonly string[]).includes(pathname)) return { kind: "about" };
  const post = /^\/posts\/([^/]+)\/?(?:index\.html)?$/.exec(pathname);
  if (post !== null && isSlug(post[1])) return { kind: "post", slug: post[1] };
  return { kind: "not-found" };
}

const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isPublicCommunity(value: unknown): value is PublicCommunity {
  const record = value as PublicCommunity | null;
  return typeof record === "object" && record !== null && isRevision(record.revision)
    && typeof record.name === "string" && Array.isArray(record.posts);
}

export function isPostRecord(value: unknown, slug: string): value is PostRecord {
  const record = value as PostRecord | null;
  if (typeof record !== "object" || record === null || record.slug !== slug || !isRevision(record.revision)) return false;
  return record.kind === "removed" || (record.kind === "post" && typeof record.title === "string" && typeof record.body === "string");
}

/** Store keys: the community, and one per post slug. */
export const recordKey = { community: "community", post: (slug: string) => `post:${slug}` } as const;

interface Slot {
  readonly record?: { readonly revision: number };
  /** An authoritative source answered 404. */
  readonly missing: boolean;
}

/**
 * The newest public records this page has seen, from any source. Revisions
 * only move forward: a removal is itself a revision, so an older snapshot or
 * a lagging source can never bring removed or superseded content back. An
 * authoritative 404 is remembered too, and only an authoritative record
 * clears it. Every change is announced to subscribers, so whichever read
 * delivers a record, every view waiting for it updates.
 */
export class PublicRecords {
  readonly #slots = new Map<string, Slot>();
  readonly #listeners = new Set<(key: string) => void>();

  community(): PublicCommunity | undefined {
    const slot = this.#slots.get(recordKey.community);
    return slot?.missing ? undefined : slot?.record as PublicCommunity | undefined;
  }

  post(slug: string): PostRecord | undefined {
    const slot = this.#slots.get(recordKey.post(slug));
    return slot?.missing ? undefined : slot?.record as PostRecord | undefined;
  }

  isMissing(key: string): boolean {
    return this.#slots.get(key)?.missing === true;
  }

  /** Returns true when the store changed. */
  accept(key: string, record: { readonly revision: number }, authoritative: boolean): boolean {
    const slot = this.#slots.get(key);
    if (slot?.missing) {
      if (!authoritative) return false;
    } else if (slot?.record !== undefined && record.revision <= slot.record.revision) {
      return false;
    }
    this.#slots.set(key, { record, missing: false });
    this.#announce(key);
    return true;
  }

  markMissing(key: string): void {
    if (this.#slots.get(key)?.missing) return;
    this.#slots.set(key, { missing: true });
    this.#announce(key);
  }

  subscribe(listener: (key: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #announce(key: string) {
    for (const listener of [...this.#listeners]) listener(key);
  }
}

export type View =
  | { readonly kind: "loading" }
  | { readonly kind: "community"; readonly community: PublicCommunity }
  | { readonly kind: "post"; readonly post: PublicPost; readonly updated: boolean }
  | { readonly kind: "about"; readonly community: PublicCommunity | null }
  | { readonly kind: "removed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-found" };

/** The view the stored records give a route, or undefined while unknown. */
export function viewFor(route: Route, records: PublicRecords, updated: boolean): View | undefined {
  switch (route.kind) {
    case "community": {
      if (records.isMissing(recordKey.community)) return { kind: "not-found" };
      const community = records.community();
      return community === undefined ? undefined : { kind: "community", community };
    }
    case "about":
      return { kind: "about", community: records.community() ?? null };
    case "post": {
      if (records.isMissing(recordKey.post(route.slug))) return { kind: "not-found" };
      const record = records.post(route.slug);
      if (record === undefined) return undefined;
      return record.kind === "removed" ? { kind: "removed" } : { kind: "post", post: record, updated };
    }
    case "not-found":
      return { kind: "not-found" };
  }
}

/** Same view over the same records: re-rendering would only lose DOM state and focus. */
export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "community" && b.kind === "community") return a.community === b.community;
  if (a.kind === "about" && b.kind === "about") return a.community === b.community;
  if (a.kind === "post" && b.kind === "post") return a.post === b.post && a.updated === b.updated;
  return true;
}

export type ReadStatus = "found" | "missing" | "unavailable";

export interface DataSource {
  readonly records: PublicRecords;
  /** Reads every source for the record; results reach views through the store. */
  readonly refreshCommunity: (signal: AbortSignal) => Promise<ReadStatus>;
  readonly refreshPost: (slug: string, signal: AbortSignal) => Promise<ReadStatus>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Upper bound for any public read; navigation also aborts reads it supersedes. */
export const READ_TIMEOUT_MS = 4000;

/**
 * One bounded read. The caller's signal and the timeout are joined by hand:
 * AbortSignal.any is missing from Safari before 17.4 and Firefox before 124.
 */
async function readJson(fetcher: Fetch, url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" }, credentials: "same-origin", signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`read_failed:${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

interface Read {
  /** A 404 from an authoritative source means the record does not exist. */
  readonly authoritative: boolean;
  readonly url: string;
}

async function refresh(
  fetcher: Fetch,
  records: PublicRecords,
  key: string,
  reads: readonly Read[],
  signal: AbortSignal,
  timeoutMs: number,
  valid: (value: unknown) => value is { readonly revision: number },
): Promise<ReadStatus> {
  let failed = false;
  await Promise.all(reads.map(async read => {
    try {
      const value = await readJson(fetcher, read.url, signal, timeoutMs);
      if (signal.aborted) return;
      if (value === null) {
        if (read.authoritative) records.markMissing(key);
        return;
      }
      if (!valid(value)) {
        failed = true;
        return;
      }
      records.accept(key, value, read.authoritative);
    } catch {
      failed = true;
    }
  }));
  if (records.isMissing(key)) return "missing";
  const held = key === recordKey.community ? records.community() : records.post(key.slice("post:".length));
  if (held !== undefined) return "found";
  return failed ? "unavailable" : "missing";
}

/**
 * Mirror mode reads only the snapshot. Canonical mode reads the community API
 * and the snapshot shipped with the same release in parallel, each bounded;
 * whichever answers first is shown and the store keeps only newer revisions,
 * so a stalled or failing API never blanks or rolls back public reading.
 */
export function createDataSource(
  mode: Mode,
  fetcher: Fetch = globalThis.fetch.bind(globalThis),
  timeoutMs = READ_TIMEOUT_MS,
  records = new PublicRecords(),
): DataSource {
  const communityReads: Read[] = mode === "mirror"
    ? [{ authoritative: true, url: paths.snapshot.community }]
    : [{ authoritative: true, url: paths.api.community }, { authoritative: false, url: paths.snapshot.community }];
  const postReads = (slug: string): Read[] => mode === "mirror"
    ? [{ authoritative: true, url: paths.snapshot.post(slug) }]
    : [{ authoritative: true, url: paths.api.post(slug) }, { authoritative: false, url: paths.snapshot.post(slug) }];
  return {
    records,
    refreshCommunity: signal => refresh(fetcher, records, recordKey.community, communityReads, signal, timeoutMs, isPublicCommunity),
    refreshPost: (slug, signal) => refresh(
      fetcher, records, recordKey.post(slug), postReads(slug), signal, timeoutMs,
      (value): value is PostRecord => isPostRecord(value, slug),
    ),
  };
}

export type SessionState = "checking" | "signed-out" | "signed-in" | "unavailable";

export async function readSession(fetcher: Fetch, timeoutMs = 5000): Promise<SessionState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(paths.api.session, { signal: controller.signal, credentials: "same-origin" });
    if (response.status === 401) return "signed-out";
    return response.ok ? "signed-in" : "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
