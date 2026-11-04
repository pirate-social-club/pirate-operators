// Pure client decisions: deployment mode, routes and the data source.
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

export function canonicalHref(config: Pick<CommunityConfig, "canonicalOrigin">, pathname: string): string {
  return new URL(pathname, config.canonicalOrigin).href;
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

export interface DataSource {
  readonly community: () => Promise<PublicCommunity | null>;
  readonly post: (slug: string) => Promise<PostRecord | null>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson<T>(fetcher: Fetch, url: string): Promise<T | null> {
  const response = await fetcher(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`read_failed:${response.status}`);
  return await response.json() as T;
}

/**
 * Mirror mode reads only the snapshot. Canonical mode reads the community API
 * and falls back to the snapshot shipped with the same release when the API
 * fails, so public reading never depends on the service being up.
 */
export function createDataSource(mode: Mode, fetcher: Fetch = globalThis.fetch.bind(globalThis)): DataSource {
  const snapshot = {
    community: () => readJson<PublicCommunity>(fetcher, paths.snapshot.community),
    post: (slug: string) => readJson<PostRecord>(fetcher, paths.snapshot.post(slug)),
  };
  if (mode === "mirror") return snapshot;
  return {
    community: () => readJson<PublicCommunity>(fetcher, paths.api.community).catch(snapshot.community),
    post: (slug: string) => readJson<PostRecord>(fetcher, paths.api.post(slug)).catch(() => snapshot.post(slug)),
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
