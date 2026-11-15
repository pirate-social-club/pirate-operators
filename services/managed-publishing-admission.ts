import { bytes32, canonical, CommunityError, exact, insist, jsonBody, object } from "../packages/community/common.ts";
import { claimOwnerWindow, requireOwnerGrantTime } from "../packages/release/owner-grant.ts";
import { authenticatedManagedRegistration, authenticateManagedCredential, managedGrantScope, managedPublishingConfiguration,
  ManagedPublishingJournal, selectionFor, type ManagedPublishingConfiguration, type ManagedPublishingRegistration } from "../packages/release/managed-publishing-admission.ts";
import { readPinnedManagedCommunity } from "./shared-recognition-configuration.ts";
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
  async function current(r: ManagedPublishingRegistration) {
    insist(canonical(JSON.parse(env.MANAGED_PUBLISHING_CONFIGURATION_JSON)) === canonical(config), "managed_configuration_changed", 409);
    await journal.registration(r);
    const c = await readPinnedManagedCommunity(r);
    await journal.registration(r);
    requireOwnerGrantTime(r.grant);
    insist(canonical(JSON.parse(env.MANAGED_PUBLISHING_CONFIGURATION_JSON)) === canonical(config), "managed_configuration_changed", 409);
    return c;
  }
  return { config, journal, registration, current,
    async forCommunity(communityId: string) {
      const records = config.registrations.filter(r => r.body.scope.communityId === communityId && !config.disabledAdmissionReferences.includes(r.body.admissionReference));
      const attached: ManagedPublishingRegistration[] = [];
      for (const record of records) {
        const r = authenticatedManagedRegistration(record, trust), row = await journal.row(selectionFor(r).selectionDigest);
        if (row?.state === "attached") attached.push(r);
      }
      insist(attached.length === 1, "managed_attachment_unavailable", 403);
      const r = attached[0]!; await current(r);
      insist((await journal.observation(r, selectionFor(r).selectionDigest)).state === "attached", "managed_attachment_unavailable", 503);
      return r;
    },
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url), action = url.pathname.slice("/v1/managed-publishing/".length);
        insist(url.origin === config.origin && !url.search && request.method === "POST" &&
          url.pathname === "/v1/managed-publishing/" + action && ["prepare", "attach", "reconcile"].includes(action), "not_found", 404);
        const reference = request.headers.get("x-pirate-admission") ?? "",
          r = action === "reconcile" ? await retainedManagedRegistration(env.DB, reference, trust) : registration(reference);
        authenticateManagedCredential(request, r);
        await journal.registration(r, false);
        const body = await jsonBody(request, 32 * 1024);
        if (action === "prepare") {
          exact(body, ["scope"]);
          // The request may identify an original; only the signed server record selects it.
          const scope = managedGrantScope(body.scope);
          insist(canonical(scope) === canonical(r.scope), "managed_scope_changed", 409);
          await current(r);
          const selection = await journal.prepare(r);
          await current(r);
          return Response.json(selection, { headers: { "cache-control": "no-store" } });
        }
        exact(body, ["selectionDigest"]); const digest = bytes32(body.selectionDigest);
        insist(digest === selectionFor(r).selectionDigest, "managed_selection_changed", 409);
        if (action === "reconcile") {
          // Past acknowledgements remain evidence after expiry/revocation. They
          // do not authorize new work or imply application-side attachment.
          return Response.json(await journal.observation(r, digest), { headers: { "cache-control": "no-store" } });
        }
        await current(r);
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
