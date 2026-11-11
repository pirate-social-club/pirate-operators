import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { digest } from "../packages/protocol/index.ts";

// UNRUN. Actual factory + native DO SQL/alarm composition. Required ports are
// explicit test transports to real production source/operator handlers. No
// mock authority grant or replacement private-result implementation is used.
test(
  "native factory restart recovers the persisted signed transition even while ordinary readiness fails",
  { timeout: 90000 },
  async () => {
    const shared = await studyCommunityFixture(20344, { v4: true });
    const directory = await mkdtemp(
      join(process.cwd(), ".local/telegram-connected-do-"),
    );
    let runtime: Miniflare | undefined;
    try {
      const compiled = await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: "telegram-connected-do-fixture.ts",
          contents: `
      import {DurableObject} from 'cloudflare:workers';
      import {createPublicClient,custom} from 'viem';
      import {telegramConnectedCommunity} from './services/telegram-connected-community.ts';
      import {telegramPublishedCatalog} from './services/telegram-catalog.ts';
      import {CommunitySpeechAdmission} from './services/study-speech-admission.ts';
      export class State extends DurableObject {
        constructor(ctx,env) {
          super(ctx,env);
          const config=JSON.parse(env.CONFIG),now=()=>Number(env.CLOCK),origin=config.app.origin;
          const unavailable=async()=>{throw Error('fixture_projection_unavailable')};
          const profile=JSON.parse(env.PROFILE);profile.deploymentBlock=BigInt(profile.deploymentBlock);
          const reads={profile,
            client:createPublicClient({transport:custom({request:async args=>{
              const response=await env.PUBLIC_RPC.fetch('https://fixture.internal/rpc',{method:'POST',body:JSON.stringify(args)});
              if(!response.ok)throw Error('fixture_rpc_unavailable');return response.json();
            }})}),transport:request=>env.PUBLIC_CONTENT.fetch(request)};
          const studyEnv={KARAOKE_SERVICE_MODE:'internal',KARAOKE_OPERATOR:env.OPERATOR,
            KARAOKE_OPERATOR_ADDRESS:env.OPERATOR_ADDRESS,KARAOKE_SIGNER_PRIVATE_KEY:env.FIXTURE_SIGNER,
            KARAOKE_PAYMENT_CHAIN_ID:'31337',STUDY_RESULTS_V4_CONTRACT:config.learningRecords};
          this.factory=telegramConnectedCommunity({storage:ctx.storage,db:env.DB,origin,
            study:{config,env:studyEnv,reads},now,
            registration:{communityId:config.communityId,botId:'90001',generation:Number(env.GENERATION),enabled:true},
            assertAccountEnabled:unavailable,personal:unavailable,notices:{read:unavailable},
            broker:{request:unavailable,redeem:unavailable},brokerClientId:'fixture_community_client',
            webhookSecret:'fixture_webhook_secret_123456789',
            catalog:telegramPublishedCatalog({db:env.DB,config,reads,origin,now,publicOffers:unavailable,
              nextDrawAt:unavailable,songProgress:unavailable,referenceAudio:unavailable}),
            speech:{admission:new CommunitySpeechAdmission(ctx.storage,{communityId:config.communityId,
              keyGeneration:'fixture_generation',dailyUnits:30,websiteStudyReservedUnits:10,telegramTrialUnits:10},now),
              keyGeneration:'fixture_generation',transcriber:{providerRetention:'stored',transcribe:unavailable}},
            trialLimits:{perUserDailySpeech:5,maxOpenLessons:2},files:{read:unavailable},delivery:{send:unavailable}});
        }
        async alarm(){await this.factory.alarm()}
        async fetch(request){
          let status=200,code=null;
          try{if(new URL(request.url).pathname==='/tick')await this.alarm();else await this.factory.ready()}
          catch(error){status=503;code=error.code??error.message}
          return Response.json({code,pending:this.factory.transitions.pending(),alarm:await this.ctx.storage.getAlarm(),
            registration:this.factory.transitions.grants.store.get('bot:'+JSON.parse(this.env.CONFIG).communityId)}, {status});
        }
      }
      export default {fetch(request,env){return env.STATE.getByName('fixture').fetch(request)}};
    `,
        },
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2024",
        external: ["cloudflare:workers", "node:*"],
        logLevel: "silent",
      });
      // Keep automatic fixture deadlines in the future. Manual forwarding below
      // tests the exact alarm handler; actual event delivery remains a runtime gate.
      shared.advance(600_000);
      let offline = false,
        denialCalls = 0;
      const make = (generation: number) =>
        new Miniflare({
          modules: true,
          script: compiled.outputFiles[0].text,
          compatibilityDate: "2026-08-06",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: { STATE: { className: "State", useSQLite: true } },
          durableObjectsPersist: join(directory, "objects"),
          d1Databases: ["DB"],
          d1Persist: join(directory, "d1"),
          bindings: {
            CONFIG: JSON.stringify(shared.config),
            PROFILE: JSON.stringify({
              ...shared.ports.publicReads!.profile,
              deploymentBlock:
                shared.ports.publicReads!.profile.deploymentBlock.toString(),
            }),
            CLOCK: String(shared.clock()),
            GENERATION: String(generation),
            OPERATOR_ADDRESS: shared.env.KARAOKE_OPERATOR_ADDRESS!,
            FIXTURE_SIGNER: shared.env.KARAOKE_SIGNER_PRIVATE_KEY!,
          },
          serviceBindings: {
            OPERATOR: async (request: Request) => {
              let forwarded: Request | undefined;
              try {
                if (new URL(request.url).pathname === "/study/telegram/deny") {
                  denialCalls++;
                  if (offline) throw Error("fixture_denial_offline");
                }
                // Miniflare and Node have different Request constructors.
                // Keep exact signed bytes/headers at this explicit test port.
                forwarded = new Request(request.url, {
                  method: request.method,
                  headers: request.headers,
                  body: ["GET", "HEAD"].includes(request.method)
                    ? undefined
                    : await request.arrayBuffer(),
                });
                return await shared.env.KARAOKE_OPERATOR!.fetch(forwarded);
              } finally {
                for (const body of [request.body, forwarded?.body])
                  if (body && !body.locked) await body.cancel().catch(() => {});
              }
            },
            PUBLIC_RPC: async (request: Request) => {
              const input = await request.json();
              return Response.json(
                await shared.ports.publicReads!.client.request(input as never),
              );
            },
            PUBLIC_CONTENT: (request: Request) =>
              shared.ports.publicReads!.transport!(request),
          },
        });
      const call = async (path: string, status: number) => {
        const response = await runtime!.dispatchFetch(
          "https://fixture.example" + path,
        );
        const body = (await response.json()) as {
          pending: boolean;
          alarm: number | null;
          registration: { generation: number };
        };
        assert.equal(response.status, status, JSON.stringify(body));
        return body;
      };
      runtime = make(1);
      assert.equal((await call("/ready", 200)).registration.generation, 1);
      await runtime.dispose();
      runtime = make(2);
      offline = true;
      const staged = await call("/ready", 503);
      assert.equal(staged.pending, true);
      assert.ok(staged.alarm !== null);
      await call("/tick", 503);
      assert.ok(denialCalls > 0);
      const attempts = denialCalls;
      await runtime.dispose();
      shared.advance(60_000);
      runtime = make(2);
      offline = false;
      const recovered = await call("/tick", 200);
      assert.equal(recovered.pending, false);
      assert.equal(recovered.registration.generation, 2);
      assert.ok(denialCalls > attempts);
      assert.equal(shared.store.entries("studyTelegramTombstone:").length, 1);
      assert.equal(
        shared.store.get(
          `studyTelegramTombstone:${digest({
            schema: "pirate.study.telegram-publication-denial/1",
            communityId: shared.config.communityId,
            kind: "scope",
            botId: "90001",
            generation: 1,
          })}`,
        ),
        true,
      );
      const completed = denialCalls;
      await call("/ready", 200);
      await call("/tick", 200);
      assert.equal(denialCalls, completed);
    } finally {
      await runtime?.dispose();
      await rm(directory, { recursive: true, force: true });
      await shared.dispose();
    }
  },
);
