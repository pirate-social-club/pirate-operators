import { assertCheckGroup } from "./check-groups.ts";
import { admissionSigner } from "./sign-admission.ts";
import {
  defaultContentProfile,
  type ContentProfile,
} from "./content-profile.ts";
import { Effect } from "effect";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  CommunityError,
  hashText,
  insist,
  canonical,
} from "../community/common.ts";
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
import { type EvidenceCheck, type EvidenceRecord } from "./evidence.ts";
import type { ManagedPairing } from "./pairing.ts";
import type { ProviderTransport } from "./provider-http.ts";
import type { AudioWindowFacts } from "./admission.ts";

export interface ManagedProcessing {
  mode?: "recognition" | "content" | "all";
  contentProfile?: ContentProfile;
  pairings: ManagedPairing[];
  serviceRequestCap: number;
  serviceBudgetPeriod: string;
  acr: AcrCredentials;
  openAiKey: string;
  signer: PrivateKeyAccount;
  currentConfiguration(pairing: ManagedPairing): Promise<CommunityConfig>;
  transport?: ProviderTransport;
  inputTransport?: (request: Request) => Promise<Response>;
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
        const acquisitionTime = async () => {
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
                seconds + 3600 > Math.floor(Date.now() / 1000)),
            "moderation_evidence_stale",
            409,
          );
          return seconds;
        };
        const checks = JSON.parse(row.request_json).checks as EvidenceCheck[];
        // Recheck the group at queue execution too: mode may change after HTTP
        // admission, and a retained row must not purchase another service's work.
        assertCheckGroup(config.mode ?? "all", checks);
        const profile = config.contentProfile ?? defaultContentProfile;
        const authorize = async () => {
          const current = await config.currentConfiguration(pairing);
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
              (!checks.includes("title.rating") ||
                canonical(current.policies.contentProfile) ===
                  canonical(profile)) &&
              checks.every(
                (check) =>
                  (check === "audio.identification"
                    ? current.policies.recognitionSigner
                    : current.policies.moderationSigner) ===
                  config.signer.address.toLowerCase(),
              ),
            "community_authority_changed",
            403,
          );
          // Retained provider facts never gain a new age through a retry.
          // Refuse to buy another check once earlier facts have expired.
          await acquisitionTime();
        };
        await authorize();
        const request = admissionRequest(JSON.parse(row.request_json), pairing),
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
        const lease = { admissionId: id, token: row.lease_token! },
          windows: (AudioWindowFacts & { providerCode: number })[] = [],
          audioDetails: Record<string, unknown>[] = [];
        if (checks.includes("audio.identification"))
          for (const role of ["primary", "alternate"] as const) {
            const window = prepared.windows.find((w) => w.role === role)!;
            const call = await journaledProviderCall(db, lease, {
              kind: role === "primary" ? "acr_primary" : "acr_alternate",
              budgets,
              authorize,
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
            const result = call as unknown as ReturnType<
              typeof parseAcrResponse
            >;
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
        let textResult: ReturnType<typeof parseTextModeration> | undefined;
        let classified:
          | ReturnType<typeof parseLyricsClassification>
          | undefined;
        if (checks.includes("title.rating")) {
          textResult = (await journaledProviderCall(db, lease, {
            kind: "text_moderation",
            budgets,
            authorize,
            request: {
              model: profile.moderationModel,
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
                profile,
              ),
            interpret: (response) => ({
              ...parseTextModeration(
                response,
                prepared.lyrics.trim() ? 2 : 1,
                profile,
              ),
            }),
          })) as unknown as ReturnType<typeof parseTextModeration>;
          classified = (await journaledProviderCall(db, lease, {
            kind: "lyrics_classification",
            budgets,
            authorize,
            request: {
              model: profile.classificationModel,
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
                profile,
              ),
            interpret: (response) => ({
              ...parseLyricsClassification(response, profile),
            }),
          })) as unknown as ReturnType<typeof parseLyricsClassification>;
        }
        const acquiredAt = await acquisitionTime();
        insist(acquiredAt !== null, "moderation_acquisition_missing", 503);
        const issuedAt = acquiredAt,
          evidence: EvidenceRecord[] = [];
        const sign = admissionSigner(
          config.signer,
          row,
          evidence,
          issuedAt,
          profile,
        );
        const codes = windows.map((w) => w.providerCode),
          audio = codes.includes(0)
            ? "identified"
            : codes.every((c) => c === 1001)
              ? "not_identified"
              : "inconclusive";
        if (checks.includes("audio.identification"))
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
        if (textResult && classified) {
          const classification = classified.classification;
          await sign(
            "title.rating",
            request.declared.titleSha256,
            textResult.results[0]!.adult ||
              classification.titleRating === "adult_18"
              ? "adult_18"
              : "general",
            { titleRevision: 1, titleSha256: request.declared.titleSha256 },
            {
              profile,
              model: profile.moderationModel,
              moderation: textResult.results[0],
              classificationModel: profile.classificationModel,
              classificationReceipt: classified.id,
            },
          );
          if (prepared.lyrics.trim())
            await sign(
              "lyrics.classification",
              request.declared.lyricsSha256!,
              textResult.results[1]!.adult ||
                classification.lyricsRating === "adult_18" ||
                classification.explicit
                ? "adult_18"
                : "general",
              {
                lyricsRevision: 1,
                lyricsSha256: request.declared.lyricsSha256,
              },
              {
                profile,
                explicit: classification.explicit,
                primaryLanguage: classification.primaryLanguage,
                model: profile.moderationModel,
                moderation: textResult.results[1],
                classificationModel: profile.classificationModel,
                classificationReceipt: classified.id,
              },
            );
        }
        await acquisitionTime();
        await finishAdmission(
          db,
          row,
          "complete",
          {
            schema: "pirate.admission/2",
            admissionId: id,
            evidence,
            probe: prepared.probe,
            windows: prepared.windows.map(
              ({ objectKey, byteLength, ...facts }) => facts,
            ),
            models: {
              moderation: profile.moderationModel,
              classification: profile.classificationModel,
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
