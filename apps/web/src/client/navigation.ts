// Pure client decisions: deployment mode, routes, the public record store and
// the data source.
import { clientRoutes, isSlug, paths, type CommunityConfig, type PostRecord, type PublicCommunity } from "../model.ts";

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

/**
 * The newest public records this page has seen, from any source. Revisions
 * only move forward: a removal is itself a revision, so an older snapshot or
 * a lagging source can never bring removed or superseded content back.
 */
export class PublicRecords {
  #community: PublicCommunity | undefined;
  readonly #posts = new Map<string, PostRecord>();
  onCommunity: ((community: PublicCommunity) => void) | undefined;

  community(): PublicCommunity | undefined {
    return this.#community;
  }

  post(slug: string): PostRecord | undefined {
    return this.#posts.get(slug);
  }

  /** Returns true when the record is newer than the one held. */
  acceptCommunity(next: PublicCommunity): boolean {
    if (this.#community !== undefined && next.revision <= this.#community.revision) return false;
    this.#community = next;
    this.onCommunity?.(next);
    return true;
  }

  acceptPost(next: PostRecord): boolean {
    const held = this.#posts.get(next.slug);
    if (held !== undefined && next.revision <= held.revision) return false;
    this.#posts.set(next.slug, next);
    return true;
  }
}

export type ReadStatus = "found" | "missing" | "unavailable";

export interface DataSource {
  readonly records: PublicRecords;
  /** Reads every source; reports each record that advances the store. */
  readonly refreshCommunity: (signal: AbortSignal, onAdvance: (community: PublicCommunity) => void) => Promise<ReadStatus>;
  readonly refreshPost: (slug: string, signal: AbortSignal, onAdvance: (record: PostRecord) => void) => Promise<ReadStatus>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Upper bound for any public read; navigation also aborts reads it supersedes. */
export const READ_TIMEOUT_MS = 4000;

async function readJson(fetcher: Fetch, url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`read_failed:${response.status}`);
  return await response.json();
}

interface Read {
  /** A 404 from an authoritative source means the record does not exist. */
  readonly authoritative: boolean;
  readonly url: string;
}

async function refresh<T>(
  fetcher: Fetch,
  reads: readonly Read[],
  signal: AbortSignal,
  timeoutMs: number,
  valid: (value: unknown) => value is T,
  accept: (record: T) => boolean,
  held: () => T | undefined,
  onAdvance: (record: T) => void,
): Promise<ReadStatus> {
  let missing = false;
  let failed = false;
  await Promise.all(reads.map(async read => {
    try {
      const value = await readJson(fetcher, read.url, signal, timeoutMs);
      if (signal.aborted) return;
      if (value === null) {
        if (read.authoritative) missing = true;
        return;
      }
      if (!valid(value)) {
        failed = true;
        return;
      }
      if (accept(value)) onAdvance(value);
    } catch {
      failed = true;
    }
  }));
  if (missing) return "missing";
  if (held() !== undefined) return "found";
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
    refreshCommunity: (signal, onAdvance) => refresh(
      fetcher, communityReads, signal, timeoutMs, isPublicCommunity,
      record => records.acceptCommunity(record), () => records.community(), onAdvance,
    ),
    refreshPost: (slug, signal, onAdvance) => refresh(
      fetcher, postReads(slug), signal, timeoutMs, (value): value is PostRecord => isPostRecord(value, slug),
      record => records.acceptPost(record), () => records.post(slug), onAdvance,
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
