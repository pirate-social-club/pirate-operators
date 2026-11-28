import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveTxt, resolve4, resolve6 } from "node:dns/promises";
import { insist } from "../../../packages/community/common.ts";

/** Community-owned DNS verification for the paired wizard. The operator proves
 * control of an ordinary HTTPS hostname by publishing a journaled TXT value
 * before any wallet connection or enrollment preparation. The proof binds the
 * exact hostname and challenge value: changing the hostname or letting the
 * challenge expire invalidates it, so a stale proof can never be carried onto
 * a different name. Routing observation is deliberately separate from control
 * verification — the two facts never collapse into one status. */

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

const defaultResolver: DnsResolver = {
  resolveTxt: (name) => resolveTxt(name),
  resolve4: (name) => resolve4(name),
  resolve6: (name) => resolve6(name),
};

interface DnsJournal {
  schema: "pirate.web2-dns-original/1";
  revision: number;
  selection: { name: string; hostname: string } | null;
  challenge: { value: string; createdAt: number; expiresAt: number } | null;
  proof: { hostname: string; value: string; verifiedAt: number } | null;
  controlObservation: {
    at: number;
    outcome: "verified" | "mismatch" | "unanswered" | "unavailable" | "expired";
  } | null;
  routingObservation: {
    at: number;
    outcome: "answers" | "absent" | "unavailable";
    addresses: string[];
  } | null;
}

const CHALLENGE_TTL_MS = 30 * 60_000;

export function normalizeHostname(input: string): string | null {
  const candidate = input.trim().toLowerCase().replace(/\.$/, "");
  if (candidate.length === 0 || candidate.length > 253) return null;
  const labels = candidate.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  return candidate;
}

export type DnsControlStatus =
  | "unstarted"
  | "pending"
  | "verified"
  | "mismatch"
  | "unanswered"
  | "unavailable"
  | "expired";

export interface DnsView {
  selection: { name: string; hostname: string } | null;
  challenge: { txtName: string; value: string; expiresAt: number } | null;
  control: DnsControlStatus;
  verifiedHostname: string | null;
  routing: "unchecked" | "answers" | "absent" | "unavailable";
  routingAddresses: string[];
  /** The routing target the A record must point at, supplied by the packaged
   * deployment. Null means this installation does not know its public
   * address, and the screen must say so rather than invent one. */
  serverIpv4: string | null;
}

export async function createWeb2DnsSetup(input: {
  directory: string;
  resolver?: DnsResolver;
  now?: () => number;
  serverIpv4?: string;
}) {
  const resolver = input.resolver ?? defaultResolver;
  const now = input.now ?? (() => Date.now());
  const path = join(input.directory, "web2-dns-original.json");
  const tmp = join(input.directory, "web2-dns-original.json.tmp");

  async function persist(state: DnsJournal) {
    const file = await open(tmp, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    const dir = await open(input.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  let state: DnsJournal;
  try {
    const file = await open(path, "r");
    try {
      state = JSON.parse(await file.readFile("utf8"));
      insist(state.schema === "pirate.web2-dns-original/1", "web2_dns_original_unknown", 503);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = {
      schema: "pirate.web2-dns-original/1",
      revision: 0,
      selection: null,
      challenge: null,
      proof: null,
      controlObservation: null,
      routingObservation: null,
    };
    await persist(state);
  }

  function txtName(hostname: string) {
    return `_pirate-challenge.${hostname}`;
  }

  function freshChallenge() {
    const at = now();
    return {
      value: `pirate-verify=${randomUUID()}`,
      createdAt: at,
      expiresAt: at + CHALLENGE_TTL_MS,
    };
  }

  function control(): DnsControlStatus {
    if (!state.selection) return "unstarted";
    if (
      state.proof &&
      state.proof.hostname === state.selection.hostname &&
      state.challenge &&
      state.proof.value === state.challenge.value
    ) {
      return "verified";
    }
    if (!state.controlObservation) return "pending";
    return state.controlObservation.outcome === "verified"
      ? "pending"
      : state.controlObservation.outcome;
  }

  function snapshot(): DnsView {
    return {
      selection: state.selection ? { ...state.selection } : null,
      challenge:
        state.selection && state.challenge
          ? {
              txtName: txtName(state.selection.hostname),
              value: state.challenge.value,
              expiresAt: state.challenge.expiresAt,
            }
          : null,
      control: control(),
      verifiedHostname:
        control() === "verified" ? state.selection!.hostname : null,
      routing: state.routingObservation?.outcome ?? "unchecked",
      routingAddresses: state.routingObservation?.addresses ?? [],
      serverIpv4: input.serverIpv4 ?? null,
    };
  }

  async function select(body: { name?: unknown; hostname?: unknown }) {
    insist(typeof body.name === "string" && body.name.trim().length > 0, "community_name_required", 400);
    insist(typeof body.hostname === "string", "hostname_required", 400);
    const hostname = normalizeHostname(body.hostname);
    insist(hostname !== null, "hostname_invalid", 400);
    const changed = state.selection?.hostname !== hostname;
    // The in-memory state is published only after persistence succeeds: a
    // failed write must never leave the running wizard displaying state the
    // disk does not hold, because a restart would silently rewrite history.
    const next: DnsJournal = {
      ...state,
      revision: state.revision + 1,
      selection: { name: body.name.trim(), hostname },
      challenge: changed || !state.challenge ? freshChallenge() : state.challenge,
      proof: changed ? null : state.proof,
      controlObservation: changed ? null : state.controlObservation,
      routingObservation: changed ? null : state.routingObservation,
    };
    await persist(next);
    state = next;
    return snapshot();
  }

  async function check() {
    insist(state.selection && state.challenge, "dns_selection_required", 409);
    const at = now();
    // An expired challenge can never verify: renew before any observation so
    // the operator is told to copy the new value rather than chase a dead one.
    if (at >= state.challenge.expiresAt) {
      const next: DnsJournal = {
        ...state,
        revision: state.revision + 1,
        challenge: freshChallenge(),
        proof: null,
        controlObservation: { at, outcome: "expired" },
      };
      await persist(next);
      state = next;
      return snapshot();
    }
    const hostname = state.selection.hostname;
    // Routing observation is independent: its failure must never mask the
    // control outcome and vice versa.
    const empty = (error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      return code === "ENOTFOUND" || code === "ENODATA";
    };
    const attempt = async (lookup: () => Promise<string[]>) => {
      try {
        return { records: await lookup(), outage: false };
      } catch (error) {
        return { records: [] as string[], outage: !empty(error) };
      }
    };
    const [v4, v6] = await Promise.all([
      attempt(() => resolver.resolve4(hostname)),
      attempt(() => resolver.resolve6(hostname)),
    ]);
    const addresses = [...v4.records, ...v6.records];
    const routingOutcome: "answers" | "absent" | "unavailable" =
      addresses.length > 0
        ? "answers"
        : v4.outage || v6.outage
          ? "unavailable"
          : "absent";
    let outcome: "verified" | "mismatch" | "unanswered" | "unavailable";
    let records: string[] = [];
    try {
      const found = await resolver.resolveTxt(txtName(hostname));
      records = found.map((chunks) => chunks.join(""));
      outcome = records.includes(state.challenge.value)
        ? "verified"
        : records.length > 0
          ? "mismatch"
          : "unanswered";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only a definitive empty answer counts as unanswered; anything
      // uncertain is unavailable so the operator is never told a record is
      // absent when the resolver simply could not find out.
      outcome =
        code === "ENOTFOUND" || code === "ENODATA" ? "unanswered" : "unavailable";
    }
    // Time is sampled again after resolution: a code that expired while the
    // resolver was being asked can never accept a verification.
    const answeredAt = now();
    if (answeredAt >= state.challenge.expiresAt) {
      const next: DnsJournal = {
        ...state,
        revision: state.revision + 1,
        challenge: freshChallenge(),
        proof: null,
        controlObservation: { at: answeredAt, outcome: "expired" },
        routingObservation: { at: answeredAt, outcome: routingOutcome, addresses },
      };
      await persist(next);
      state = next;
      return snapshot();
    }
    const proof =
      outcome === "verified"
        ? { hostname, value: state.challenge.value, verifiedAt: at }
        : null;
    const next: DnsJournal = {
      ...state,
      revision: state.revision + 1,
      proof: outcome === "verified" ? proof : state.proof?.hostname === hostname && state.challenge.value === state.proof.value ? state.proof : null,
      controlObservation: { at, outcome },
      routingObservation: { at, outcome: routingOutcome, addresses },
    };
    await persist(next);
    state = next;
    return snapshot();
  }

  return { snapshot, select, check };
}

export type Web2DnsSetup = Awaited<ReturnType<typeof createWeb2DnsSetup>>;
