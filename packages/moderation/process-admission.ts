import { Effect } from "effect";
import type { PrivateKeyAccount } from "viem/accounts";
import { CommunityError, hashText, insist } from "../community/common.ts";
import { configureBudget } from "../community/budgets.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { admissionRequest } from "./capabilities.ts";
import {
  finishAdmission,
  getAdmission,
  leaseAdmission,
} from "./admission-store.ts";
import { prepareAdmission, type AdmissionMedia } from "./prepare-admission.ts";
import {
  acrEndpoint,
  identifyMp3,
  parseAcrResponse,
  type AcrCredentials,
} from "./acrcloud.ts";
import {
  CLASSIFICATION_MODEL,
  MODERATION_MODEL,
  classifyLyrics,
  moderateText,
  parseLyricsClassification,
  parseTextModeration,
} from "./openai.ts";
import {
  journaledProviderCall,
  UncertainProviderCall,
} from "./provider-journal.ts";
import {
  signEvidence,
  evidenceSchemas,
  type EvidenceCheck,
  type EvidenceRecord,
} from "./evidence.ts";
import type { ManagedPairing } from "./pairing.ts";
import type { ProviderTransport } from "./provider-http.ts";
import type { AudioWindowFacts } from "./admission.ts";
import {
  ownerCurated,
  unregisteredOwner,
  UNREGISTERED_OWNER_POLICY,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../community/owner-policy.ts";
import {
  claimOwnerWindow,
  ownerBudgetKey,
  ownerWindowCondition,
  requireOwnerGrantTime,
  type OwnerBudgetGrant,
} from "../release/owner-grant.ts";

export interface ManagedProcessing {
  pairings: ManagedPairing[];
  serviceRequestCap: number;
  serviceBudgetPeriod: string;
  acr: AcrCredentials;
  openAiKey: string;
  signer: PrivateKeyAccount;
  currentConfiguration(pairing: ManagedPairing): Promise<CommunityConfig>;
  transport?: ProviderTransport;
  inputTransport?: (request: Request) => Promise<Response>;
  /** Reviewed owner budget; required for the unregistered owner policy. */
  ownerGrant?: OwnerBudgetGrant;
}
export function processAdmission(
  db: D1Database,
  media: AdmissionMedia,
  id: string,
  config: ManagedProcessing,
) {
  return Effect.tryPromise({
    try: async () => {
      const row = await leaseAdmission(db, id);
      if (!row) return (await getAdmission(db, id)).state;
      try {
        const pairing = config.pairings.find(
          (p) => p.communityId === row.community_id,
        );
        insist(
          pairing?.enabled && pairing.budgetPeriod === row.budget_period,
          "managed_pairing_unavailable",
          403,
        );
        const authority = JSON.parse(row.authority_json);
        insist(
          authority.registry === pairing.registry &&
            authority.directory === pairing.directory &&
            authority.controller === pairing.controller &&
            authority.communityOrigin === pairing.communityOrigin &&
            authority.serviceOrigin === pairing.serviceOrigin,
          "managed_pairing_changed",
          403,
        );
        insist(
          authority.serviceBudget?.period === config.serviceBudgetPeriod &&
            authority.serviceBudget.requestCap === config.serviceRequestCap &&
            authority.communityRequestCap === pairing.requestCap,
          "service_budget_profile_changed",
          409,
        );
        // Evidence age follows the policy the captured configuration revision
        // pins: the registered release policy keeps one hour, the unregistered
        // owner policy allows its 24-hour recognition age. The first provider
        // call's start time stays the acquisition time; retries never renew it.
        const evidenceMaxAge = (policy: { version: string; sha256: string }) =>
          unregisteredOwner(policy)
            ? UNREGISTERED_OWNER_POLICY.recognition.maximumAgeSeconds
            : 3600;
        const acquisitionTime = async (maxAge: number) => {
          const acquired = await db
            .prepare(
              "SELECT MIN(started_at) AS first_started FROM moderation_provider_calls WHERE admission_id=?",
            )
            .bind(id)
            .first<{ first_started: number | null }>();
          const seconds =
            acquired?.first_started === null ||
            acquired?.first_started === undefined
              ? null
              : Math.floor(acquired.first_started / 1000);
          insist(
            seconds === null ||
              (seconds <= Math.floor(Date.now() / 1000) &&
                seconds + maxAge > Math.floor(Date.now() / 1000)),
            "moderation_evidence_stale",
            409,
          );
          return seconds;
        };
        // Every read below is pinned to the captured configuration revision,
        // and the admission policy is fixed by the first read: the age limit
        // that allows a purchase is the one evidence expiry and the final
        // check use.
        let pinnedPolicy: { version: string; sha256: string } | undefined;
        const authorize = async () => {
          const current = await config.currentConfiguration(pairing);
          insist(
            !ownerCurated(current.policies.admission),
            "automated_content_deferred",
            409,
          );
          insist(
            current.chainId === 6343 &&
              current.communityId === pairing.communityId &&
              current.registry === pairing.registry &&
              current.directory === pairing.directory &&
              current.controller === pairing.controller &&
              current.app.origin === pairing.communityOrigin &&
              current.publisher === authority.publisher &&
              current.configurationRevision ===
                authority.configurationRevision &&
              current.policies.moderationSigner ===
                config.signer.address.toLowerCase(),
            "community_authority_changed",
            403,
          );
          pinnedPolicy ??= current.policies.admission;
          insist(
            current.policies.admission.version === pinnedPolicy.version &&
              current.policies.admission.sha256 === pinnedPolicy.sha256,
            "community_authority_changed",
            403,
          );
          // Retained provider facts never gain a new age through a retry.
          // Refuse to buy another check once earlier facts have expired.
          await acquisitionTime(evidenceMaxAge(pinnedPolicy));
        };
        await authorize();
        // Recognition only under the unregistered owner policy. The captured
        // request's checks must agree; the policy is the pinned one above.
        const recognitionOnly = unregisteredOwner(pinnedPolicy!);
        const request = admissionRequest(
            JSON.parse(row.request_json),
            pairing,
            recognitionOnly,
          ),
          prepared = await prepareAdmission(
            db,
            media,
            row,
            pairing,
            config.inputTransport,
          );
        const budgets = [
          {
            scope: "moderation:service",
            period: authority.serviceBudget.period,
            asset: "provider_requests",
          },
          {
            scope: `moderation:community:${pairing.communityId}`,
            period: row.budget_period,
            asset: "provider_requests",
          },
        ];
        insist(
          Number.isSafeInteger(config.serviceRequestCap) &&
            config.serviceRequestCap > 0 &&
            config.serviceRequestCap <= 100,
          "invalid_service_cap",
          503,
        );
        await configureBudget(
          db,
          budgets[0]!,
          String(authority.serviceBudget.requestCap),
        );
        await configureBudget(db, budgets[1]!, String(pairing.requestCap));
        let condition:
            | import("../community/budgets.ts").ReservationCondition
            | undefined,
          authorizeCall = authorize,
          dispatch: (() => Promise<void>) | undefined;
        if (recognitionOnly) {
          const grant = config.ownerGrant;
          insist(
            grant &&
              grant.communityId === pairing.communityId &&
              grant.policy.version === UNREGISTERED_OWNER_POLICY_VERSION,
            "owner_grant_unavailable",
            503,
          );
          budgets.push(ownerBudgetKey(grant, "recognition_requests"));
          condition = ownerWindowCondition(grant);
          // Each new provider reservation rechecks the grant and claims its
          // window (binding every ceiling). A retained receipt never reaches
          // this, so it still reconciles and settles after expiry.
          authorizeCall = async () => {
            await authorize();
            requireOwnerGrantTime(grant);
            await claimOwnerWindow(db, grant);
          };
          // And the grant must still be valid at dispatch, after reservation.
          dispatch = async () => requireOwnerGrantTime(grant);
        }
        const lease = { admissionId: id, token: row.lease_token! },
          windows: (AudioWindowFacts & { providerCode: number })[] = [],
          audioDetails: Record<string, unknown>[] = [];
        for (const role of ["primary", "alternate"] as const) {
          const window = prepared.windows.find((w) => w.role === role)!;
          const call = await journaledProviderCall(db, lease, {
            kind: role === "primary" ? "acr_primary" : "acr_alternate",
            budgets,
            condition,
            authorize: authorizeCall,
            dispatch,
            request: {
              schema: "pirate.acr-call/1",
              sampleSha256: window.sampleSha256,
              byteLength: window.byteLength,
              endpoint: acrEndpoint(config.acr.host),
            },
            async send(received) {
              const sample = await media.get(window.objectKey);
              insist(sample, "retained_sample_missing", 503);
              return identifyMp3(
                new Uint8Array(await sample.arrayBuffer()),
                config.acr,
                received,
                config.transport,
              );
            },
            interpret: (response) => ({ ...parseAcrResponse(response) }),
          });
          const result = call as unknown as ReturnType<typeof parseAcrResponse>;
          // The frozen wire records actual provider codes. Excluded-only code0
          // cannot be relabelled as1001; this first profile holds for review.
          insist(
            !result.details.allCandidatesExcluded,
            "acrcloud_excluded_reference_needs_review",
            409,
          );
          const { objectKey, byteLength, ...facts } = window;
          windows.push({ ...facts, providerCode: result.code });
          audioDetails.push(result.details);
          if (result.code !== 2004) break;
        }
        const textResult = recognitionOnly
          ? null
          : ((await journaledProviderCall(db, lease, {
              kind: "text_moderation",
              budgets,
              authorize,
              request: {
                model: MODERATION_MODEL,
                titleSha256: request.declared.titleSha256,
                lyricsSha256: request.declared.lyricsSha256,
              },
              send: (received) =>
                moderateText(
                  prepared.title,
                  prepared.lyrics,
                  config.openAiKey,
                  received,
                  config.transport,
                ),
              interpret: (response) => ({
                ...parseTextModeration(
                  response,
                  prepared.lyrics.trim() ? 2 : 1,
                ),
              }),
            })) as unknown as ReturnType<typeof parseTextModeration>);
        const classified = recognitionOnly
          ? null
          : ((await journaledProviderCall(db, lease, {
              kind: "lyrics_classification",
              budgets,
              authorize,
              request: {
                model: CLASSIFICATION_MODEL,
                maxOutputTokens: 256,
                titleSha256: request.declared.titleSha256,
                lyricsSha256: request.declared.lyricsSha256,
              },
              send: (received) =>
                classifyLyrics(
                  prepared.title,
                  prepared.lyrics,
                  config.openAiKey,
                  received,
                  config.transport,
                ),
              interpret: (response) => ({
                ...parseLyricsClassification(response),
              }),
            })) as unknown as ReturnType<typeof parseLyricsClassification>);
        const maxAge = evidenceMaxAge(pinnedPolicy!);
        const acquiredAt = await acquisitionTime(maxAge);
        insist(acquiredAt !== null, "moderation_acquisition_missing", 503);
        const issuedAt = acquiredAt,
          evidence: EvidenceRecord[] = [];
        const sign = async (
          check: EvidenceCheck,
          subject: ReturnType<typeof hashText>,
          result: string,
          inputs: Record<string, unknown>,
          details: Record<string, unknown>,
        ) => {
          evidence.push(
            await signEvidence(
              config.signer,
              {
                check,
                schema: evidenceSchemas[check],
                submissionId: row.submission_id,
                communityId: row.community_id,
                jobId: row.job_id,
                subject,
                evaluator: `pirate-managed/1;acr-raw/1;${MODERATION_MODEL};${CLASSIFICATION_MODEL}`,
                policy: recognitionOnly
                  ? UNREGISTERED_OWNER_POLICY_VERSION
                  : "pirate-release/2026-08-29",
                result,
                issuedAt,
                expiresAt: issuedAt + maxAge,
              },
              inputs,
              details,
            ),
          );
        };
        const codes = windows.map((w) => w.providerCode),
          audio = codes.includes(0)
            ? "identified"
            : codes.every((c) => c === 1001)
              ? "not_identified"
              : "inconclusive";
        await sign(
          "audio.identification",
          request.declared.songSha256,
          audio,
          {
            songSha256: request.declared.songSha256,
            songByteLength: request.inputs.song.byteLength,
            extraction: "mp3-frame-window/1",
            windows,
            provider: "acrcloud",
            providerEndpoint: acrEndpoint(config.acr.host),
          },
          { windows: audioDetails },
        );
        if (!recognitionOnly) {
          const classification = classified!.classification;
          await sign(
            "title.rating",
            request.declared.titleSha256,
            textResult!.results[0]!.adult ||
              classification.titleRating === "adult_18"
              ? "adult_18"
              : "general",
            { titleRevision: 1, titleSha256: request.declared.titleSha256 },
            {
              model: MODERATION_MODEL,
              moderation: textResult!.results[0],
              classificationModel: CLASSIFICATION_MODEL,
              classificationReceipt: classified!.id,
            },
          );
          if (prepared.lyrics.trim())
            await sign(
              "lyrics.classification",
              request.declared.lyricsSha256!,
              textResult!.results[1]!.adult ||
                classification.lyricsRating === "adult_18" ||
                classification.explicit
                ? "adult_18"
                : "general",
              {
                lyricsRevision: 1,
                lyricsSha256: request.declared.lyricsSha256,
              },
              {
                explicit: classification.explicit,
                primaryLanguage: classification.primaryLanguage,
                model: MODERATION_MODEL,
                moderation: textResult!.results[1],
                classificationModel: CLASSIFICATION_MODEL,
                classificationReceipt: classified!.id,
              },
            );
        }
        await acquisitionTime(maxAge);
        await finishAdmission(
          db,
          row,
          "complete",
          recognitionOnly
            ? {
                schema: "pirate.owner-recognition/1",
                admissionId: id,
                evidence,
                probe: prepared.probe,
                windows: prepared.windows.map(
                  ({ objectKey, byteLength, ...facts }) => facts,
                ),
                automatedContent: "deferred",
              }
            : {
                schema: "pirate.managed-admission/1",
                admissionId: id,
                evidence,
                probe: prepared.probe,
                windows: prepared.windows.map(
                  ({ objectKey, byteLength, ...facts }) => facts,
                ),
                models: {
                  moderation: MODERATION_MODEL,
                  classification: CLASSIFICATION_MODEL,
                },
              },
          null,
        );
        return "complete";
      } catch (error) {
        const uncertain = error instanceof UncertainProviderCall,
          code =
            error instanceof CommunityError
              ? error.code
              : uncertain
                ? "provider_result_uncertain"
                : "moderation_unavailable";
        await finishAdmission(
          db,
          row,
          uncertain ? "uncertain" : "held",
          {},
          code,
        );
        return uncertain ? "uncertain" : "held";
      }
    },
    catch: (error) => error,
  });
}
