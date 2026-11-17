import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { hashJson, hashText } from "../packages/community/common.ts";
import { acquireOperation, hash, processIdentity } from "../deploy/linux/backend-state.ts";
import type { PublicIngress } from "../deploy/linux/public-ingress.ts";
import { startWeb2NativeActivityHost } from "../deploy/linux/web2-native-activity-host.ts";
import type { Web2LocalStudyPolicy } from "../deploy/linux/web2-local-study.ts";

test("native HTTP lets a complete upload process quietly past the upload timer", { timeout: 55_000 }, async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pwa-idle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketDirectory = join(root, "activity-transport");
  const socket = join(socketDirectory, "host.sock");
  const python = join(root, "whisper-env", "bin", "python");
  const program = join(root, "transcribe");
  const model = join(root, "ggml-base.en-q5_1.bin");
  const authFile = join(root, "asr.auth");
  const entered = join(root, "entered");
  const holder = await processIdentity(process.pid);
  assert(holder);
  const lease = await acquireOperation(root, "timeout-fixture", "timeout-fixture", {}, holder.pidNamespace);
  await mkdir(socketDirectory, { mode: 0o700 });
  await mkdir(join(root, "whisper-env", "bin"), { recursive: true, mode: 0o700 });
  await symlink(await realpath("/usr/bin/python3"), python);
  // Run a genuine quiet child through the pinned Study adapter and Unix HTTP
  // connection. The recognizer executable is a transport fixture for this test.
  await writeFile(program, [
    "#!" + python,
    "import pathlib, sys, time",
    "payload = sys.stdin.buffer.read()",
    "with pathlib.Path(" + JSON.stringify(entered) + ").open('ab') as marker:",
    "    marker.write(payload)",
    "if payload == b'slow':",
    "    time.sleep(16)",
    "print('fixture transcript')",
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(model, "transport fixture model pin", { mode: 0o600 });
  const auth = "A".repeat(43);
  await writeFile(authFile, auth, { mode: 0o600 });
  const [programSha256, englishModel, ffmpeg, interpreter] = await Promise.all(
    [program, model, "/usr/bin/ffmpeg", python].map(async path => hash(await readFile(path))),
  );
  const pins = {
    PIRATE_LOCAL_STUDY_ASR: program,
    PIRATE_LOCAL_STUDY_ASR_SHA256: programSha256,
    PIRATE_LOCAL_STUDY_MODEL_SHA256: englishModel,
    PIRATE_LOCAL_STUDY_FFMPEG_SHA256: ffmpeg,
    PIRATE_LOCAL_STUDY_PYTHON_SHA256: interpreter,
  };
  for (const [name, value] of Object.entries(pins)) {
    const old = process.env[name];
    t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
    process.env[name] = value;
  }
  const study: Web2LocalStudyPolicy = {
    schema: "pirate.web2-local-study-policy/1",
    issuer: `0x${"1".repeat(40)}`,
    issuerFile: join(root, "unused-issuer.key"),
    operator: `0x${"2".repeat(40)}`,
    asr: {
      origin: "https://asr.fixture.test",
      upstream: "unix:" + socket,
      authFile,
      authSha256: hashText(auth),
      selectedProgramSha256: hashJson({ program: programSha256, englishModel, ffmpeg, python: interpreter }),
    },
    speech: { keyGeneration: "fixture", dailyUnits: 2, websiteStudyReservedUnits: 1 },
  };
  const ingress: PublicIngress = {
    schema: "pirate.linux-public-ingress/1",
    origin: "https://localhost:4443",
    upstream: "https://127.0.0.1:8443",
    upstreamServerName: "upstream.test",
    upstreamCaFile: join(root, "unused-ca.pem"),
    upstreamCaSha256: "1".repeat(64),
    executable: "/unused-caddy",
    executableSha256: "1".repeat(64),
    configurationFile: join(root, "unused-Caddyfile"),
    dataDirectory: root,
    httpPort: 4080,
    httpsPort: 4443,
    tls: { kind: "local-fixture-ca" },
  };
  const host = await startWeb2NativeActivityHost({
    selected: { schema: "pirate.web2-native-activities/1", socket },
    stateRoot: root,
    study,
    host: {},
    ingress,
    lease,
  });
  function post(input: string, complete = true) {
    return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const client = request({
        socketPath: socket,
        path: "/transcribe",
        method: "POST",
        agent: false,
        headers: {
          authorization: "Bearer " + auth,
          "content-length": input.length + (complete ? 0 : 1),
        },
      }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
        response.on("error", reject);
      });
      client.on("error", reject);
      client.setTimeout(25_000, () => client.destroy(Error("fixture_client_deadline")));
      if (complete) client.end(input);
      else client.write(input);
    });
  }
  try {
    const start = performance.now();
    const quiet = post("slow");
    // Observe the original child first so the overlapping request proves the
    // quiet host still holds its single slot.
    try {
      for (;;) {
        try { assert.equal(await readFile(entered, "utf8"), "slow"); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          assert(performance.now() - start < 5000, "fixture_child_did_not_start");
          await delay(25);
        }
      }
      assert.equal((await post("overlap")).status, 429);
      assert.deepEqual(await quiet, { status: 200, body: "fixture transcript" });
      assert(performance.now() - start >= 15_000);
    } finally {
      await quiet.catch(() => undefined);
    }
    await assert.rejects(post("incomplete", false), { code: "ECONNRESET" });
    assert.equal(await readFile(entered, "utf8"), "slow");
    assert.deepEqual(await post("fast"), { status: 200, body: "fixture transcript" });
    assert.equal(await readFile(entered, "utf8"), "slowfast");
  } finally {
    await host.close();
  }
});
