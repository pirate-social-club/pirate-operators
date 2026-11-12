import type { CommunityOwner } from "./community-contracts.ts";
export class CommunityPortError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export function communityHttp(
  owner: CommunityOwner,
  transport: typeof fetch = fetch,
) {
  return async <T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> => {
    owner.assert();
    if (
      !path.startsWith("/api/") ||
      path.startsWith("//") ||
      /[\\\r\n]/.test(path)
    )
      throw new Error("Invalid community service path");
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.method && !["GET", "HEAD"].includes(init.method))
      headers.set("x-csrf-token", owner.current.session.csrf);
    const signals = [
      owner.signal,
      AbortSignal.timeout(init.method === "PUT" ? 120000 : 30000),
      ...(signal ? [signal] : []),
    ];
    const response = await transport(path, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any(signals),
    });
    const body = await response.json();
    if (!response.ok)
      throw new CommunityPortError(
        response.status,
        typeof body?.error === "string"
          ? body.error
          : "community_service_unavailable",
      );
    // A late reply is returned for durable reconciliation. The operation owner
    // must persist it, then fence notifications and every subsequent command.
    return body as T;
  };
}
export type CommunityHttp = ReturnType<typeof communityHttp>;
export const jsonWrite = (body: unknown, extra?: HeadersInit): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...Object.fromEntries(new Headers(extra)),
  },
  body: JSON.stringify(body),
});
