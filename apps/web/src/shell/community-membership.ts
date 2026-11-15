import type { CommunityJoinView, MemberNameView } from "../api-contract.ts";

export interface MemberOwner {
  /** Local generation identity only. Never sent as ownership authority. */
  readonly key: string;
  readonly csrf: string;
  readonly wallet: string;
}
export interface MembershipState {
  readonly ownerKey: string | null;
  readonly join: CommunityJoinView | null;
  readonly name: MemberNameView | null;
  readonly joining: boolean;
  readonly naming: boolean;
  readonly nameOpen: boolean;
  readonly joinUncertain: boolean;
  readonly nameUncertain: boolean;
  readonly error: string | null;
}
export type PreparedName = Extract<MemberNameView, { state: "awaiting_consent" }>;
export class MemberActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
class MemberRefusal extends Error {
  readonly view: CommunityJoinView | MemberNameView;
  constructor(view: CommunityJoinView | MemberNameView) {
    super(view.state === "blocked" ? view.correction : "The original request was refused.");
    this.view = view;
  }
}
export const canonicalMemberLabel = (value: string): boolean =>
  value.length >= 8 && value.length <= 63 &&
  /^(?!..--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
export const acceptedJoin = (value: MembershipState): boolean =>
  value.join?.state === "accepted";

/** Recovery copy never turns expiry/unknown into authority for replacement. */
export function memberNameRecoveryCopy(value: MemberNameView | null, uncertain: boolean): string | null {
  if (value?.state === "expired_unconsumed")
    return "The original name consent expired. Check or reconcile that original request. No replacement is authorized.";
  if (value?.state === "unknown")
    return "The original name outcome is unknown. Check or reconcile that original request. No replacement is authorized.";
  if (uncertain) return "Check the original name request before continuing. No replacement is authorized.";
  if (value?.state === "queued" || value?.state === "pending")
    return "The original name request is " + value.state + ".";
  return null;
}

const empty = (key: string | null): MembershipState => ({
  ownerKey: key, join: null, name: null, joining: false, naming: false,
  nameOpen: false, joinUncertain: false, nameUncertain: false, error: null,
});
const address = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function base(value: unknown, schema: string): asserts value is Record<string, unknown> {
  if (!record(value) || value.schema !== schema || !text(value.ownerScope) ||
    !integer(value.revision)) throw Error("The community response could not be verified.");
}
export function decodeJoin(value: unknown): CommunityJoinView {
  base(value, "pirate.community-join/1");
  const valid = value.state === "not_joined" ||
    (value.state === "accepted" && record(value.receipt) &&
      text(value.receipt.joinId) && integer(value.receipt.acceptedAtMs)) ||
    (value.state === "unknown" && integer(value.retryAfterMs)) ||
    (value.state === "blocked" &&
      ["admission_refused", "policy_unavailable", "service_unavailable"].includes(String(value.reason)) &&
      text(value.correction));
  if (!valid) throw Error("The membership response could not be verified.");
  return value as unknown as CommunityJoinView;
}
const bytes32 = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const decimal = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) &&
  BigInt(value) < 2n ** 256n;
function claim(value: unknown, tld: string): boolean {
  return record(value) && bytes32(value.requestId) && bytes32(value.planDigest) &&
    typeof value.label === "string" && canonicalMemberLabel(value.label) &&
    value.name === value.label + "." + tld;
}
function terms(value: unknown): boolean {
  return record(value) && value.initialPriceAtomic === "0" && value.initialTermDays === 365 &&
    record(value.annualRenewal) && typeof value.annualRenewal.token === "string" &&
    address(value.annualRenewal.token) && decimal(value.annualRenewal.amountAtomic) &&
    record(value.gas) && typeof value.gas.payerAddress === "string" &&
    address(value.gas.payerAddress) && decimal(value.gas.maxTotalWei);
}
export function decodeName(value: unknown): MemberNameView {
  base(value, "pirate.member-name/1");
  if (!text(value.recipient) || !address(value.recipient) || !text(value.tld) ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(value.tld))
    throw Error("The name response could not be verified.");
  if (value.state === "idle" && value.claim === null) return value as unknown as MemberNameView;
  if (value.state === "blocked" || value.state === "expired_unconsumed") {
    if ((value.claim === null || claim(value.claim, value.tld)) &&
      ["invalid_label", "name_taken", "name_reserved", "not_free", "budget_exhausted",
        "authority_changed", "issuer_unavailable", "recipient_unsupported", "request_conflict",
        "service_unavailable"].includes(String(value.reason)) && text(value.correction))
      return value as unknown as MemberNameView;
    throw Error("The original refusal could not be verified.");
  }
  if (!claim(value.claim, value.tld) || !terms(value.terms))
    throw Error("The original name request or its terms are unavailable.");
  if (value.state === "awaiting_consent") {
    const consent = value.consent;
    if (!record(consent) || !bytes32(consent.digest) || !integer(consent.expiresAtMs) ||
      !record(consent.typedData) || consent.typedData.primaryType !== "ClaimAcceptance" ||
      !record(consent.typedData.domain) || !text(consent.typedData.domain.name) ||
      !text(consent.typedData.domain.version) ||
      (consent.typedData.domain.chainId !== 6343 && consent.typedData.domain.chainId !== 31337) ||
      typeof consent.typedData.domain.verifyingContract !== "string" ||
      !address(consent.typedData.domain.verifyingContract) ||
      !record(consent.typedData.types) || !Object.keys(consent.typedData.types).length ||
      !Object.values(consent.typedData.types).every(fields => Array.isArray(fields) &&
        fields.every(field => record(field) && text(field.name) && text(field.type))) ||
      !record(consent.typedData.message))
      throw Error("The original claim acceptance is unavailable.");
  } else if (["queued", "pending", "unknown"].includes(String(value.state))) {
    if (!integer(value.retryAfterMs)) throw Error("The name retry time is unavailable.");
  } else if (value.state === "consumed") {
    const receipt = value.receipt;
    if (!record(receipt) || !bytes32(receipt.transactionHash) || !decimal(receipt.tokenId) ||
      !decimal(receipt.generation) || !integer(receipt.expiryMs) ||
      !decimal(receipt.blockNumber) || !bytes32(receipt.blockHash) ||
      !["not_checked", "usable", "not_usable", "unknown"].includes(String(value.usability)))
      throw Error("The canonical claim result is unavailable.");
  } else {
    throw Error("The name state could not be verified.");
  }
  return value as unknown as MemberNameView;
}

/** One small owner-scoped controller. Server intent/journal owns durability.
 * No persistence, SDK construction, ownership parameters or automatic writes. */
export function createCommunityMembership(options: {
  owner: () => MemberOwner | null;
  fetch: typeof fetch;
  newKey: () => string;
  sign: (prepared: PreparedName, assertCurrent: () => void) => Promise<string>;
  authLost: (status: 401 | 403 | "scope_changed") => void;
  changed: (state: MembershipState) => void;
  now?: () => number;
}) {
  let owner: MemberOwner | null = null, generation = 0, nameGeneration = 0, disposed = false;
  let state = empty(null), ownerScope: string | null = null;
  let joinTask: Promise<void> | null = null;
  let joinKey: string | null = null;
  let prepare: { idempotencyKey: string; label: string } | null = null;
  let original: { requestId: string; planDigest: string } | null = null;
  let joinReadAt = 0, nameReadAt = 0, joinRevision = -1, nameRevision = -1;
  const requests = new Set<AbortController>();
  const now = options.now ?? Date.now;
  const publish = (next: MembershipState) => { state = next; options.changed(next); };
  const update = (next: Partial<MembershipState>) => publish({ ...state, ...next });
  function sync() {
    if (disposed) return;
    const next = options.owner();
    if (next?.key === owner?.key && next?.csrf === owner?.csrf &&
      next?.wallet.toLowerCase() === owner?.wallet.toLowerCase()) return;
    generation++; nameGeneration++; joinTask = null;
    for (const request of requests) request.abort();
    requests.clear();
    owner = next ? { ...next } : null;
    ownerScope = null; joinKey = null; prepare = null; original = null;
    joinReadAt = 0; nameReadAt = 0; joinRevision = -1; nameRevision = -1;
    publish(empty(owner?.key ?? null));
  }
  function capture(nameOnly = false) {
    sync();
    if (!owner) throw new MemberActionError("sign_in", "Sign in to join this community.");
    const current = { ...owner }, g = generation, n = nameGeneration;
    return () => {
      sync();
      if (!owner || g !== generation || current.key !== owner.key ||
        current.csrf !== owner.csrf || (nameOnly && n !== nameGeneration))
        throw new MemberActionError("stale", "This account or view changed. Check the original request.");
      return current;
    };
  }
  async function request(path: string, guard: () => MemberOwner, body?: unknown) {
    const current = guard(), abort = new AbortController();
    requests.add(abort);
    const timeout = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await options.fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort.signal,
        headers: body === undefined ? { Accept: "application/json" } :
          { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": current.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      guard();
      if (abort.signal.aborted) throw new MemberActionError("unavailable", "The response is unknown. Check the original request.");
      // Mask private state at the HTTP boundary, even for HTML/empty bodies.
      if (response.status === 401 || response.status === 403) {
        const status = response.status;
        clear(); ownerScope = null;
        options.authLost(status);
        throw new MemberActionError("sign_in", "Sign in again to check the original request.");
      }
      const unavailable = () => new MemberActionError("unavailable",
        response.status === 429 ? "Please wait, then check the original request." :
          "The community service is unavailable. Check the original request again.");
      const result: unknown = await response.json().catch(() => { throw unavailable(); });
      guard();
      if (abort.signal.aborted) throw new MemberActionError("unavailable", "The response is unknown. Check the original request.");
      if (!response.ok) {
        // Actual producer refusals use 503/422, not success status. No other
        // error-status body may manufacture accepted/queued/consumed facts.
        try {
          const value = path === "/api/community/join" ? decodeJoin(result) : decodeName(result);
          if (response.status >= 400 && value.state === "blocked") throw new MemberRefusal(value);
        } catch (error) { if (error instanceof MemberRefusal) throw error; }
        throw unavailable();
      }
      return result;
    } finally { clearTimeout(timeout); requests.delete(abort); }
  }
  function acceptScope(value: CommunityJoinView | MemberNameView) {
    if (ownerScope !== null && value.ownerScope !== ownerScope) {
      clear(); ownerScope = null;
      options.authLost("scope_changed");
      throw new MemberActionError("sign_in", "The owner scope changed. Sign in again before continuing.");
    }
    const previous = value.schema === "pirate.community-join/1" ? joinRevision : nameRevision;
    if (value.revision < previous) throw Error("The community returned an older revision. Check again.");
    ownerScope = value.ownerScope;
    if (value.schema === "pirate.community-join/1") joinRevision = value.revision;
    else nameRevision = value.revision;
  }
  const message = (error: unknown) => error instanceof Error ? error.message : "Check the original request again.";
  const stale = (error: unknown) => error instanceof MemberActionError &&
    (error.code === "stale" || error.code === "sign_in");
  async function readJoin(guard: () => MemberOwner) {
    if (now() < joinReadAt) return;
    const value = decodeJoin(await request("/api/community/join", guard));
    guard(); acceptScope(value);
    if (state.join?.state === "accepted" && value.state !== "accepted")
      throw Error("Membership could not be reconciled. Check again.");
    joinReadAt = value.state === "unknown" ? now() + value.retryAfterMs : 0;
    update({ join: value, joinUncertain: value.state === "unknown" });
  }
  function acceptName(value: MemberNameView, guard: () => MemberOwner) {
    guard(); acceptScope(value);
    if (original && (!value.claim || value.claim.requestId !== original.requestId ||
      value.claim.planDigest !== original.planDigest))
      throw Error("The original name request could not be reconciled.");
    if (value.recipient.toLowerCase() !== guard().wallet.toLowerCase())
      throw new MemberActionError("recipient_mismatch", "This name belongs to another recipient. Use its connected account.");
    if (value.claim) original = { requestId: value.claim.requestId, planDigest: value.claim.planDigest };
  }
  async function readName(guard: () => MemberOwner) {
    if (now() < nameReadAt) return;
    const path = original ? "/api/member-name/claims/" + encodeURIComponent(original.requestId) :
      "/api/member-name";
    const value = decodeName(await request(path, guard));
    acceptName(value, guard);
    nameReadAt = ["queued", "pending", "unknown"].includes(value.state) && "retryAfterMs" in value
      ? now() + value.retryAfterMs : 0;
    update({ name: value, nameUncertain: value.state === "unknown" ||
      (prepare !== null && value.state === "idle") });
  }
  function failure(error: unknown, guard: () => MemberOwner, fields: Partial<MembershipState>) {
    if (stale(error)) return;
    try {
      guard();
      if (error instanceof MemberRefusal && error.view.state === "blocked") {
        const value = error.view;
        if (value.schema === "pirate.member-name/1") {
          acceptName(value, guard);
          update({ name: value, nameUncertain: false, error: null });
        } else {
          acceptScope(value);
          update({ join: acceptedJoin(state) ? state.join : value, error: value.correction });
        }
      } else update({ ...fields, error: message(error) });
    } catch (validation) {
      if (stale(validation)) return;
      try { guard(); update({ ...fields, error: message(validation) }); }
      catch { /* No obsolete owner/view or foreign refusal can install data. */ }
    }
  }
  async function loadJoinAction() {
    let guard: () => MemberOwner;
    try { guard = capture(); } catch { return; }
    if (state.joining) return;
    update({ joining: true, error: null });
    try { await readJoin(guard); }
    catch (error) { failure(error, guard, { joinUncertain: true }); }
    finally { try { guard(); update({ joining: false }); } catch { /* obsolete read */ } }
  }
  async function joinAction() {
    let guard: () => MemberOwner;
    try { guard = capture(); } catch { return; }
    if (state.joining) return;
    if (state.join?.state === "accepted" || state.join?.state === "unknown") return loadJoinAction();
    update({ joining: true, error: null });
    try {
      // Confirm current policy/state before the explicit first write.
      await readJoin(guard);
      if (state.join?.state !== "not_joined") return;
      joinKey ??= options.newKey();
      update({ joinUncertain: true });
      try { await request("/api/community/join", guard, { idempotencyKey: joinKey }); }
      catch (error) { if (stale(error) || error instanceof MemberRefusal) throw error; /* lost ACK: read, never reissue */ }
      guard();
      await readJoin(guard); // Only this observational accepted readback sets Joined.
    } catch (error) { failure(error, guard, { joinUncertain: true }); }
    finally { try { guard(); update({ joining: false }); } catch { /* obsolete write */ } }
  }
  async function loadJoin() {
    sync();
    if (joinTask) return joinTask;
    const task = loadJoinAction(); joinTask = task;
    try { await task; } finally { if (joinTask === task) joinTask = null; }
  }
  async function join() {
    let guard: () => MemberOwner;
    try { guard = capture(); } catch { return; }
    // An explicit click may arrive while sign-in's observational read is in
    // flight. Wait for that read, then keep this same explicit intent.
    if (joinTask) await joinTask;
    try { guard(); } catch { return; }
    if (joinTask) return joinTask;
    const task = joinAction(); joinTask = task;
    try { await task; } finally { if (joinTask === task) joinTask = null; }
  }
  async function checkName() {
    let guard: () => MemberOwner;
    try { guard = capture(true); } catch { return; }
    if (!state.nameOpen || state.naming || !acceptedJoin(state)) return;
    update({ naming: true, error: null });
    try { await readName(guard); }
    catch (error) { failure(error, guard, { nameUncertain: true }); }
    finally { try { guard(); update({ naming: false }); } catch { /* dismissed */ } }
  }
  async function openName() {
    sync();
    if (!owner || !acceptedJoin(state) || state.nameOpen) return;
    update({ nameOpen: true, error: null });
    await checkName();
  }
  function dismissName() {
    nameGeneration++;
    // Abort outstanding reads locally. The server keeps the original operation.
    for (const request of requests) request.abort();
    update({ nameOpen: false, naming: false, error: null,
      nameUncertain: state.nameUncertain || state.name?.state === "awaiting_consent" });
  }
  async function prepareName(label: string) {
    let guard: () => MemberOwner;
    try { guard = capture(true); } catch { return; }
    if (!state.nameOpen || state.naming || !acceptedJoin(state)) return;
    if (!canonicalMemberLabel(label)) { update({ error: "Use 8–63 lowercase ASCII letters, digits or hyphens; begin and end with a letter or digit. Hyphens cannot occupy both positions 3 and 4." }); return; }
    // A lost prepare response never authorizes another label/key, even if a
    // delayed current lookup still says idle. Only observe the original.
    if (prepare || original || state.nameUncertain || state.name?.state !== "idle") return checkName();
    prepare = { idempotencyKey: options.newKey(), label };
    update({ naming: true, nameUncertain: true, error: null });
    try {
      try {
        const value = decodeName(await request("/api/member-name/claims", guard, prepare));
        guard(); acceptScope(value);
        if (value.state === "idle") throw Error("The original claim has not been located.");
        if (value.claim) original = { requestId: value.claim.requestId, planDigest: value.claim.planDigest };
      } catch (error) { if (stale(error) || error instanceof MemberRefusal) throw error; }
      guard(); await readName(guard);
    } catch (error) { failure(error, guard, { nameUncertain: true }); }
    finally { try { guard(); update({ naming: false }); } catch { /* dismissed */ } }
  }
  async function consent() {
    let guard: () => MemberOwner;
    try { guard = capture(true); } catch { return; }
    const prepared = state.name;
    if (!state.nameOpen || state.naming || prepared?.state !== "awaiting_consent" ||
      !acceptedJoin(state) || state.nameUncertain || !original) return;
    const assertCurrent = () => {
      const current = guard();
      if (!state.nameOpen || original?.requestId !== prepared.claim.requestId ||
        original?.planDigest !== prepared.claim.planDigest ||
        current.wallet.toLowerCase() !== prepared.recipient.toLowerCase())
        throw new MemberActionError("stale", "The original consent changed. Check its status.");
      if (prepared.consent.expiresAtMs <= now())
        throw new MemberActionError("consent_expired", "The original consent expired. Check its status before continuing.");
    };
    update({ naming: true, error: null });
    try {
      assertCurrent();
      const recipientSignature = await options.sign(prepared, assertCurrent);
      assertCurrent();
      if (!/^0x[0-9a-fA-F]+$/.test(recipientSignature)) throw Error("The wallet did not return a signature.");
      update({ nameUncertain: true });
      try {
        await request("/api/member-name/claims/" + encodeURIComponent(prepared.claim.requestId) + "/consent",
          guard, { planDigest: prepared.claim.planDigest, recipientSignature });
      } catch (error) { if (stale(error) || error instanceof MemberRefusal) throw error; update({ nameUncertain: true }); }
      assertCurrent(); await readName(guard);
    } catch (error) {
      failure(error, guard, error instanceof MemberActionError && error.code === "consent_expired"
        ? { nameUncertain: true } : {});
    }
    finally { try { guard(); update({ naming: false }); } catch { /* account/view changed */ } }
  }
  async function reconcile() {
    let guard: () => MemberOwner;
    try { guard = capture(true); } catch { return; }
    if (!state.nameOpen || state.naming || !original || !acceptedJoin(state) ||
      now() < nameReadAt) return;
    const selected = { ...original };
    update({ naming: true, error: null });
    try {
      await request("/api/member-name/claims/" + encodeURIComponent(selected.requestId) + "/reconcile",
        guard, { planDigest: selected.planDigest });
      await readName(guard);
    } catch (error) { failure(error, guard, { nameUncertain: true }); }
    finally { try { guard(); update({ naming: false }); } catch { /* obsolete observation */ } }
  }
  function clear() {
    generation++; nameGeneration++;
    for (const request of requests) request.abort();
    requests.clear(); joinTask = null; owner = null; original = null; prepare = null; joinKey = null;
    publish(empty(null));
  }
  return {
    sync, loadJoin, join, openName, dismissName, checkName, prepareName, consent, reconcile, clear,
    state: () => { sync(); return state; },
    dispose: () => { if (!disposed) { clear(); disposed = true; } },
  };
}
