import type { Setup } from "../server/setup.ts";
export type Snapshot = ReturnType<Setup["snapshot"]> & {
  csrf: string;
  capabilities: { infisical: boolean; cloudflare: boolean };
};
