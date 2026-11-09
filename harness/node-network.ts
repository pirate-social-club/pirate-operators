// Release tools run under Node. Its default dual-stack connect gives each
// address family only 250 ms, which intermittently times out the MegaETH RPC
// on hosts with a slow IPv6 path before any request is sent. Prefer IPv4 and
// allow each family three seconds. Import this first, for its effect only.
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

export const releaseNetwork = {
  resultOrder: "ipv4first",
  familyAttemptTimeoutMs: 3000,
} as const;
setDefaultResultOrder(releaseNetwork.resultOrder);
setDefaultAutoSelectFamilyAttemptTimeout(releaseNetwork.familyAttemptTimeoutMs);
