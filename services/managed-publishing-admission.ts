import { bytes32, canonical, hashJson, CommunityError, exact, insist, jsonBody, object } from "../packages/community/common.ts";
import { parsePlan } from "../packages/community/hosted-enrollment.ts";
import { claimOwnerWindow, requireOwnerGrantTime } from "../packages/release/owner-grant.ts";
import { authenticatedManagedRegistration, authenticateManagedCredential, managedGrantScope, managedPublishingConfiguration,
  ManagedPublishingJournal, managedDigest, selectionFor, type ManagedPublishingConfiguration, type ManagedPublishingRegistration } from "../packages/release/managed-publishing-admission.ts";
import { readPinnedManagedCommunity } from "./shared-recognition-configuration.ts";
import type { ManagedEnv } from "./managed-moderation.ts";
import type { ReservationCondition } from "../packages/community/budgets.ts";
import type { SignedRecord, TrustAnchor } from "../deploy/linux/installed-records.ts";

export interface ManagedPublishingAdmissionEnv {
  DB: D1Database;
  MANAGED_PUBLISHING_CONFIGURATION_JSON: string;
  SERVICE_CONFIGURATION_TRUST_JSON: string;
}
export function configuredPublishingAdmission(env: ManagedPublishingAdmissionEnv) {
  insist(typeof env.MANAGED_PUBLISHING_CONFIGURATION_JSON === "string" && env.MANAGED_PUBLISHING_CONFIGURATION_JSON.length <= 1024 * 1024 &&
    typeof env.SERVICE_CONFIGURATION_TRUST_JSON === "string" && env.SERVICE_CONFIGURATION_TRUST_JSON.length <= 8192,
    "managed_service_configuration_unavailable", 503);
  const trust: TrustAnchor = JSON.parse(env.SERVICE_CONFIGURATION_TRUST_JSON),
    input: ManagedPublishingConfiguration = JSON.parse(env.MANAGED_PUBLISHING_CONFIGURATION_JSON),
    config = managedPublishingConfiguration(input, trust), journal = new ManagedPublishingJournal(env.DB, config);
  const registration = (reference: string) => {
    const record = config.registrations.find(r => r.body.admissionReference === reference);
    insist(record, "managed_admission_unavailable", 403);
    return authenticatedManagedRegistration(record, trust);
  };
  function unchanged() {
    insist(canonical(JSON.parse(env.MANAGED_PUBLISHING_CONFIGURATION_JSON)) === canonical(config), "managed_configuration_changed", 409);
  }
  async function identity(r: ManagedPublishingRegistration) {
    unchanged();
    const selected = config.registrations.find(value => value.body.admissionReference === r.admissionReference);
    if (selected) insist(canonical(authenticatedManagedRegistration(selected, trust)) === canonical(r), "managed_original_conflict", 409);
    await journal.registration(r, false);
    // A retained prepare was written only after the real canonical observer.
    // Historical identity/readback must survive a current RPC outage. This is
    // retained service evidence, not a fresh claim about external chain state.
    const plan = parsePlan(r.registrationOriginal.plan);
    insist(hashJson(plan.config) === r.configurationSha256, "managed_original_conflict", 409);
    await journal.registration(r, false); unchanged(); return plan.config;
  }
  async function current(r: ManagedPublishingRegistration) {
    insist(canonical(registration(r.admissionReference)) === canonical(r), "managed_original_conflict", 409);
    await identity(r);
    const c = await readPinnedManagedCommunity(r);
    await journal.registration(r); requireOwnerGrantTime(r.grant); unchanged(); return c;
  }
  // W1 owns ManagedEnv.MANAGED_ADMISSION_GATE and its final shared definition.
  // This indexed type deliberately requires that exact join; no local substitute.
  function gate(r: ManagedPublishingRegistration): NonNullable<ManagedEnv["MANAGED_ADMISSION_GATE"]> {
    const original = structuredClone(r), digest = selectionFor(original).selectionDigest, revision = canonical(original),
      record = canonical(original);
    const grantIdentity = (grant: Readonly<ManagedPublishingRegistration["grant"]>) =>
      insist(canonical(grant) === canonical(original.grant), "managed_gate_grant_changed", 409);
    return {
      async reservationCondition(grant, operation): Promise<ReservationCondition> {
        grantIdentity(grant); managedDigest(operation.requestHash);
        insist(operation.operationId.length > 0 && operation.operationId.length <= 256 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(operation.operationId), "managed_gate_original_invalid", 409);
        await current(original);
        insist((await journal.observation(original, digest)).state === "attached", "managed_attachment_unavailable", 503);
        requireOwnerGrantTime(original.grant); unchanged();
        return { clause: `EXISTS(SELECT 1 FROM managed_publishing_registrations r
          JOIN managed_publishing_admissions a ON a.admission_reference=r.admission_reference
          JOIN managed_publishing_installation i ON i.origin=?
          WHERE r.admission_reference=? AND json_extract(r.record_json,'$.body')=? AND r.state='active' AND a.state='attached'
          AND a.selection_digest=? AND a.registration_json=? AND i.epoch=? AND i.restore_anchor_sha256=?)`,
          binds: [config.origin, original.admissionReference, record, digest, revision, config.journal.epoch, config.journal.restoreAnchorSha256],
          code: "managed_admission_not_current" };
      },
      async beforeDispatch(grant, operation) {
        grantIdentity(grant); managedDigest(operation.requestHash);
        insist(operation.operationId.length > 0 && operation.operationId.length <= 256 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(operation.operationId), "managed_gate_original_invalid", 409);
        await current(original);
        insist((await journal.observation(original, digest)).state === "attached", "managed_attachment_unavailable", 503);
        await journal.registration(original); requireOwnerGrantTime(original.grant); unchanged();
      },
    };
  }
  return { config, journal, registration, identity, current, gate,
    async forCommunity(communityId: string, mode: "read" | "effect" = "effect") {
      const rows = await env.DB.withSession("first-primary").prepare(`SELECT r.record_json FROM managed_publishing_registrations r
        JOIN managed_publishing_admissions a ON a.admission_reference=r.admission_reference
        WHERE json_extract(r.record_json,'$.body.scope.communityId')=? AND a.state='attached' LIMIT 101`)
        .bind(communityId).all<{ record_json: string }>();
      insist(rows.results.length === 1, "managed_attachment_unavailable", 403);
      const signed: SignedRecord<ManagedPublishingRegistration> = JSON.parse(rows.results[0]!.record_json), r = authenticatedManagedRegistration(signed, trust);
      await (mode === "read" ? identity(r) : current(r));
      insist((await journal.observation(r, selectionFor(r).selectionDigest)).state === "attached", "managed_attachment_unavailable", 503);
      return r;
    },
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url), action = url.pathname.slice("/v1/managed-publishing/".length);
        insist(url.origin === config.origin && !url.search && request.method === "POST" &&
          url.pathname === "/v1/managed-publishing/" + action && ["prepare", "attach", "reconcile"].includes(action), "not_found", 404);
        const reference = request.headers.get("x-pirate-admission") ?? "",
          r = await retainedManagedRegistration(env.DB, reference, trust);
        authenticateManagedCredential(request, r);
        await journal.registration(r, false);
        const body = await jsonBody(request, 32 * 1024);
        if (action === "prepare") {
          exact(body, ["scope"]);
          // The request may identify an original; only the signed server record selects it.
          const scope = managedGrantScope(body.scope);
          insist(canonical(scope) === canonical(r.scope), "managed_scope_changed", 409);
          const retained = await journal.retainedSelection(r);
          if (retained) { await identity(r); return Response.json(retained, { headers: { "cache-control": "no-store" } }); }
          await current(r);
          const selection = await journal.prepare(r);
          await current(r);
          return Response.json(selection, { headers: { "cache-control": "no-store" } });
        }
        exact(body, ["selectionDigest"]); const digest = managedDigest(body.selectionDigest);
        insist(digest === selectionFor(r).selectionDigest, "managed_selection_changed", 409);
        if (action === "reconcile") {
          // Past acknowledgements remain evidence after expiry/revocation. They
          // do not authorize new work or imply application-side attachment.
          await identity(r);
          return Response.json(await journal.observation(r, digest), { headers: { "cache-control": "no-store" } });
        }
        const past = await journal.observation(r, digest);
        if (past.state === "attached") { await identity(r); return Response.json(past, { headers: { "cache-control": "no-store" } }); }
        await current(r);
        if (past.state === "unknown") return Response.json(past, { headers: { "cache-control": "no-store" } });
        await journal.beginAttach(r, digest);
        await current(r);
        await claimOwnerWindow(env.DB, r.grant);
        await current(r);
        const observation = await journal.finishAttach(r, digest, Math.floor(Date.now() / 1000));
        await current(r);
        return Response.json(observation, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ error: error instanceof CommunityError ? error.code : "managed_service_unavailable" }, {
          status: error instanceof CommunityError ? error.status : 503, headers: { "cache-control": "no-store" },
        });
      }
    },
  };
}
/** Retrieve a retained original using a configured issuer, never trust its hash
 * as authentication. Used by controlled provisioning/reconciliation tools. */
export async function retainedManagedRegistration(db: D1Database, reference: string, trust: TrustAnchor) {
  const row = await db.withSession("first-primary").prepare("SELECT record_json FROM managed_publishing_registrations WHERE admission_reference=?")
    .bind(reference).first<{ record_json: string }>();
  insist(row, "managed_original_unavailable", 503);
  const record: SignedRecord<ManagedPublishingRegistration> = JSON.parse(row.record_json);
  return authenticatedManagedRegistration(record, trust);
}
