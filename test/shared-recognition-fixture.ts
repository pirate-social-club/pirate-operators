import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sha256 } from "viem";
import { bytes32, hashText, publicId } from "../packages/community/common.ts";
import {
  signRecognitionRequest,
  type RecognitionAction,
  type RecognitionAuthority,
} from "../packages/recognition/authorization.ts";
import { acrCatalog } from "../packages/recognition/catalog-provider.ts";
import {
  catalogVerification,
  verificationFromReceipt,
} from "../packages/recognition/verification.ts";
import { RecognitionStore } from "../packages/recognition/store.ts";
import {
  type Recording,
  type VerifiedPublication,
  associationId,
} from "../packages/recognition/model.ts";
import { sharedRecognitionService } from "../services/shared-recognition.ts";
import {
  recognitionClient,
  type RecognitionClientPorts,
} from "../packages/recognition/client.ts";

export const publisherA = privateKeyToAccount(`0x${"11".repeat(32)}`),
  publisherB = privateKeyToAccount(`0x${"22".repeat(32)}`),
  recognitionSigner = privateKeyToAccount(`0x${"33".repeat(32)}`),
  profileSha256 = hashText("reviewed-recognition-profile"),
  namespace = hashText("fresh-release-staging"),
  origin = "https://recognition.example",
  communityA = hashText("community-a"),
  communityB = hashText("community-b"),
  creatorKey = `eip155:6343:0x${"44".repeat(20)}`,
  audio = new Uint8Array([73, 68, 51, 0, 12, 34, 56]);
export function publication(
  communityId: string = communityA,
  revision = 1,
): VerifiedPublication {
  return {
    namespace,
    communityId,
    postId: hashText(`post-${communityId}`),
    publicationRevision: revision,
    configurationRevision: 1,
    creatorKey,
    audioSha256: sha256(audio),
    audioBytes: audio.length,
    audioObjectKey: `sealed/${communityId}`,
    audioRevision: 1,
    termsRevision: revision,
    termsSha256: hashText(`restrictive-terms-${revision}`),
    allowsDerivatives: false,
    publicationEvidenceSha256: hashText(
      `verified-publication-${communityId}-${revision}`,
    ),
  };
}
/** Actual D1, HTTP, signing and provider adapters. Provider/chain transport is simulated. */
export async function recognitionFixture(
  options: {
    serviceDatabase?: (database: D1Database) => D1Database;
  } = {},
) {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB");
    const serviceDatabase = options.serviceDatabase?.(db) ?? db;
    const sql = await readFile(
      new URL("../packages/recognition/schema.sql", import.meta.url),
      "utf8",
    );
    await db.batch(
      sql
        .replace(/^--.*$/gm, "")
        .split(/;\s*(?=CREATE\s|$)/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    let time = 1800000000000,
      uploads = 0,
      deletes = 0,
      identify = 0,
      loseUpload = false,
      rejectWake = false,
      expireRead = false,
      denyUpload = false,
      extraCandidate = false,
      excludedVideo = false,
      catalogOutage = false,
      indexLag = false,
      verificationLag = false,
      loseVerification = false,
      loseVerificationReturn = false;
    const rows = new Map<string, Record<string, unknown>>(),
      wakes: string[] = [],
      publications = new Map<string, VerifiedPublication>();
    const authorities = new Map<string, RecognitionAuthority>([
      [
        communityA,
        {
          namespace,
          profileSha256,
          communityId: communityA,
          communityOrigin: "https://a.example",
          publisher: publisherA.address.toLowerCase(),
          configurationRevision: 1,
          enabled: true,
        },
      ],
      [
        communityB,
        {
          namespace,
          profileSha256,
          communityId: communityB,
          communityOrigin: "https://b.example",
          publisher: publisherB.address.toLowerCase(),
          configurationRevision: 1,
          enabled: true,
        },
      ],
    ]);
    for (const id of [communityA, communityB]) {
      const p = publication(id);
      publications.set(`${id}:${p.postId}:${p.publicationRevision}`, p);
    }
    const store = () => new RecognitionStore(db, namespace, () => time);
    let nextStatusSign: (() => Promise<void>) | null = null;
    const statusSigner: PrivateKeyAccount = {
      ...recognitionSigner,
      async signTypedData(parameters) {
        const hook = nextStatusSign;
        nextStatusSign = null;
        await hook?.();
        return recognitionSigner.signTypedData(parameters);
      },
    };
    let resolve:
      | ((
          p: VerifiedPublication,
        ) => Promise<{ recordingId: string; evidenceSha256: string } | null>)
      | null = null;
    const transport = {
      async request(request: Request) {
        const url = new URL(request.url);
        if (url.hostname.startsWith("identify-")) {
          identify++;
          if (loseVerification)
            throw new Error("simulated lost verification response");
          if (verificationLag) return Response.json({ status: { code: 1001 } });
          const first = [...rows.values()][0];
          return Response.json({
            status: { code: first ? 0 : 1001 },
            metadata: {
              custom_files: first
                ? [
                    { acrid: first.acr_id },
                    ...(extraCandidate ? [{ acrid: "conflicting" }] : []),
                    ...(excludedVideo
                      ? [
                          {
                            acrid: "video",
                            user_defined: { content_type: "video_audio" },
                          },
                        ]
                      : []),
                  ]
                : [],
            },
          });
        }
        if (request.method === "POST") {
          uploads++;
          const form = await request.formData(),
            title = String(form.get("title"));
          const value = {
            id: uploads,
            bucket_id: 123,
            title,
            acr_id: `custom-${uploads}`,
            state: 1,
            user_defined: JSON.parse(String(form.get("user_defined"))),
          };
          rows.set(title, value);
          if (loseUpload) {
            loseUpload = false;
            throw new Error("simulated lost upload response");
          }
          return Response.json({ data: value });
        }
        if (request.method === "DELETE") {
          deletes++;
          const id = url.pathname.split("/").at(-1);
          for (const [key, row] of rows)
            if (String(row.id) === id) rows.delete(key);
          return new Response(null, { status: 204 });
        }
        if (catalogOutage) return new Response(null, { status: 503 });
        return Response.json({
          data: [...rows.values()]
            .filter((r) => r.title === url.searchParams.get("search"))
            .map((r) => (indexLag ? { ...r, state: 0 } : r)),
          next_page_url: null,
        });
      },
    };
    const catalog = acrCatalog({
      namespace,
      origin: "https://api-v2.acrcloud.com",
      bucketId: "123",
      token: "fixture-token",
      transport,
      received: (kind, r, receipt) => store().receipt(r, kind, receipt),
    });
    const verify = catalogVerification({
      credentials: {
        host: "identify-eu-west-1.acrcloud.com",
        accessKey: "fixture-key",
        accessSecret: "fixture-secret",
      },
      transport,
      sample: async (p) => ({
        bytes: audio,
        sampleSha256: sha256(audio),
        canonicalAudioSha256: p.audioSha256,
      }),
      received: async (r, receipt) => {
        await store().receipt(r, "verify", receipt);
        if (loseVerificationReturn) {
          loseVerificationReturn = false;
          throw new Error("simulated termination after receipt");
        }
      },
    });
    const makeService = () =>
      sharedRecognitionService({
        db: serviceDatabase,
        namespace,
        profileSha256,
        origin,
        statusSigner,
        now: () => time,
        loadAuthority: async (id) => authorities.get(id) ?? null,
        verifyPublication: async (a, id, revision) =>
          publications.get(`${a.communityId}:${id}:${revision}`) ?? null,
        verifyWithdrawal: async () => hashText("verified-hidden-revision"),
        resolveEnrollment: async (_authority, p) =>
          resolve ? resolve(p) : null,
        wake: async (id) => {
          if (rejectWake) throw new Error("simulated lost queue wakeup");
          wakes.push(id);
        },
        enrollment: {
          catalog,
          verify,
          recoverVerification: async (r) => {
            const receipt = await store().verificationReceipt(r);
            return receipt ? verificationFromReceipt(r, receipt) : null;
          },
          readAudio: async () => {
            if (expireRead) time += 60001;
            return audio;
          },
          authorizeEffect: async (kind) => {
            if (kind === "upload" && denyUpload)
              throw new Error("simulated quota refusal");
          },
        },
      });
    let service = makeService();
    const request = async (
      action: Extract<RecognitionAction,"catalog_enroll"|"catalog_status"|"catalog_withdraw">,
      body: Record<string, unknown>,
      communityId: string = communityA,
      nonce = publicId(),
      account = communityId === communityA ? publisherA : publisherB,
    ) => {
      const authority = authorities.get(communityId)!;
      const signed = await signRecognitionRequest(
        account,
        {
          namespace,
          profileSha256: bytes32(authority.profileSha256),
          action,
          communityId: bytes32(communityId),
          communityOrigin: authority.communityOrigin,
          serviceOrigin: origin,
          configurationRevision: authority.configurationRevision,
          nonce,
          issuedAt: Math.floor(time / 1000),
          expiresAt: Math.floor(time / 1000) + 300,
        },
        body,
      );
      const path = {
        catalog_enroll: "enroll",
        catalog_status: "status",
        catalog_withdraw: "withdraw",
      }[action];
      return service.fetch(
        new Request(`${origin}/v1/catalog/publications/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        }),
      );
    };
    const enroll = async (p = publication()) => {
      publications.set(
        `${p.communityId}:${p.postId}:${p.publicationRevision}`,
        p,
      );
      const response = await request(
        "catalog_enroll",
        { postId: p.postId, publicationRevision: p.publicationRevision },
        p.communityId,
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          recordingId: string;
          associationId: string;
          state: string;
          error?: string;
        },
      };
    };
    return {
      db,
      store,
      authorities,
      publications,
      now: () => time,
      onNextStatusSign: (hook: () => Promise<void>) => {
        nextStatusSign = hook;
      },
      fetch: (request: Request) => service.fetch(request),
      client: (
        communityId: string = communityA,
        overrides: Partial<RecognitionClientPorts> = {},
      ) =>
        recognitionClient({
          connection: {
            namespace,
            profileSha256,
            origin,
            signer: recognitionSigner.address.toLowerCase(),
          },
          publisher: communityId === communityA ? publisherA : publisherB,
          currentAuthority: async () => authorities.get(communityId) ?? null,
          beforeSend: async () => {},
          transport: (request) => service.fetch(request),
          now: () => time,
          ...overrides,
        }),
      resolveWith: (callback: NonNullable<typeof resolve>) => {
        resolve = callback;
      },
      request,
      enroll,
      wakes,
      run: (id: string) => service.run(id),
      recover: () => service.recover(),
      restart: () => {
        service = makeService();
      },
      counts: () => ({ uploads, deletes, identify }),
      flags: (flags: {
        loseUpload?: boolean;
        rejectWake?: boolean;
        expireRead?: boolean;
        denyUpload?: boolean;
        extraCandidate?: boolean;
        excludedVideo?: boolean;
        catalogOutage?: boolean;
        indexLag?: boolean;
        verificationLag?: boolean;
        loseVerification?: boolean;
        loseVerificationReturn?: boolean;
      }) => {
        loseUpload = flags.loseUpload ?? loseUpload;
        rejectWake = flags.rejectWake ?? rejectWake;
        expireRead = flags.expireRead ?? expireRead;
        denyUpload = flags.denyUpload ?? denyUpload;
        extraCandidate = flags.extraCandidate ?? extraCandidate;
        excludedVideo = flags.excludedVideo ?? excludedVideo;
        catalogOutage = flags.catalogOutage ?? catalogOutage;
        indexLag = flags.indexLag ?? indexLag;
        verificationLag = flags.verificationLag ?? verificationLag;
        loseVerification = flags.loseVerification ?? loseVerification;
        loseVerificationReturn =
          flags.loseVerificationReturn ?? loseVerificationReturn;
      },
      advanceClock: (ms: number) => {
        time += ms;
      },
      withdraw: (p: VerifiedPublication) =>
        request(
          "catalog_withdraw",
          { associationId: associationId(p) },
          p.communityId,
        ),
      dispose: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
