import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { speechAdmissionObjectName } from "../services/study-speech-admission.ts";

test(
  "real Durable Object RPC serializes Telegram competition and retains dispatch after eviction/restart",
  { timeout: 30000 },
  async () => {
    const config = {
      communityId: "0x" + "a".repeat(64),
      keyGeneration: "fixture-1",
      dailyUnits: 10,
      websiteStudyReservedUnits: 4,
      telegramTrialUnits: 2,
    };
    const source = await build({
      stdin: {
        contents: `import {SpeechBudget} from './services/speech-budget.ts';
    export {SpeechBudget};
    export default {async fetch(request, env) {
      const {action,args}=await request.json();
      const budget=env.BUDGET.getByName(${JSON.stringify(speechAdmissionObjectName(config))});
      try {return Response.json(await budget[action](...args));}
      catch(error) {return Response.json({error:error.message},{status:409});}
    }};`,
        resolveDir: process.cwd(),
        sourcefile: "speech-budget-worker-fixture.ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2024",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    });
    const dir = await mkdtemp(join(tmpdir(), "speech-budget-worker-"));
    const make = () =>
      new Miniflare({
        modules: true,
        script: source.outputFiles[0].text,
        compatibilityDate: "2026-08-06",
        bindings: {
          SPEECH_DAILY_LIMIT: "0",
          SPEECH_ADMISSION_CONFIG: JSON.stringify(config),
        },
        durableObjects: {
          BUDGET: { className: "SpeechBudget", useSQLite: true },
        },
        durableObjectsPersist: dir,
      });
    let runtime = make();
    const call = async (action: string, ...args: unknown[]) => {
      const response = await runtime.dispatchFetch("https://fixture.example/", {
        method: "POST",
        body: JSON.stringify({ action, args }),
      });
      return {
        status: response.status,
        value: (await response.json()) as Record<string, unknown>,
      };
    };
    const input = (
      requestId: string,
      channel = "telegram-linked",
      units = 1,
    ) => ({
      communityId: config.communityId,
      keyGeneration: config.keyGeneration,
      requestId,
      channel,
      units,
      payloadDigest: "0x" + "b".repeat(64),
    });
    try {
      const requests = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          call("reserve", input(`telegram-${i}`)),
        ),
      );
      assert.equal(requests.filter((r) => r.status === 200).length, 6);
      assert.equal(
        (await call("reserve", input("web", "website-study", 4))).status,
        200,
      );
      const dispatches = await Promise.all(
        Array.from({ length: 8 }, () => call("dispatch", "web")),
      );
      assert.equal(
        dispatches.filter((r) => r.value.dispatch === true).length,
        1,
      );
      assert.equal((await call("claim")).status, 409); // legacy callers cannot bypass protection
      await runtime.dispose();
      runtime = make();
      assert.equal(
        (await call("reservation", "web")).value.state,
        "dispatched",
      );
      assert.equal((await call("dispatch", "web")).value.dispatch, false);
    } finally {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
