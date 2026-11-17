import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireOperation, hash, processIdentity } from "../deploy/linux/backend-state.ts";
import type { PublicIngress } from "../deploy/linux/public-ingress.ts";
import { localStudyAsr } from "../deploy/linux/web2-local-study-asr.ts";
import type { Web2LocalStudyPolicy } from "../deploy/linux/web2-local-study.ts";
import { startWeb2NativeActivityHost } from "../deploy/linux/web2-native-activity-host.ts";
import { hashJson, hashText } from "../packages/community/common.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";

const auth = "A".repeat(43);
const origin = "https://asr.synthetic.test";
const sentinel = "synthetic sentinel excluded from diagnostics";
const prefix = "pirate_native_study_asr:";

function carrier(fetch: Pick<Fetcher, "fetch">["fetch"]) {
  return localStudyAsr({ LOCAL_STUDY_ASR_URL: origin + "/transcribe",
    LOCAL_STUDY_ASR_AUTH: auth, LOCAL_STUDY_ASR: { fetch } });
}

const speechError = (outcome: "known_failed" | "unknown") => (error: unknown) =>
  error instanceof StudySpeechError && error.code === "speech_unavailable" && error.outcome === outcome;

test("native Study carrier observes fixed transport, refusal and UTF-8 stages without changing outcomes", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  const transportError = new Error(sentinel);
  const input = Uint8Array.of(1);
  const send = (service: ReturnType<typeof carrier>) => service.transcribe(input, "audio/webm", "en");
  const lost = carrier(async () => { throw transportError; });
  await assert.rejects(send(lost), error => error === transportError);
  assert.equal(lost.recover, undefined);
  await assert.rejects(send(carrier(async () => new Response(sentinel, { status: 503 }))), speechError("unknown"));
  await assert.rejects(send(carrier(async () => new Response(null, { status: 429 }))), speechError("known_failed"));
  await assert.rejects(send(carrier(async () => new Response(Uint8Array.of(0xc3)))), TypeError);
  const partial = carrier(async () => new Response(new ReadableStream({
    start(controller) { controller.error(transportError); },
  })));
  await assert.rejects(send(partial), error => error === transportError);
  assert.deepEqual(await send(carrier(async () => new Response(sentinel))), { text: sentinel, language: "en" });
  assert.deepEqual(logs, [
    [prefix + "worker_transport_failed"], [prefix + "worker_host_rejected"], [prefix + "worker_host_busy"],
    [prefix + "worker_body_decode"], [prefix + "worker_body_read"],
  ]);
  const timer = t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(transportError));
  await assert.rejects(send(carrier(async (_input, init) => { throw init?.signal?.reason; })), error => error === transportError);
  timer.mock.restore();
  assert.deepEqual(logs.at(-1), [prefix + "worker_transport_deadline"]);
});

test("synthetic Opus/WebM through the installed Unix activity host keeps private child and transport diagnostics separate", { timeout: 38_000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "psd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { log.push(args); });
  const ffmpeg = await realpath("/usr/bin/ffmpeg");
  const signal = execFileSync(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000:duration=1.5", "-c:a", "libopus", "-f", "webm", "pipe:1"],
  { timeout: 5000, maxBuffer: 524_288 });
  assert.equal(signal.readUInt32BE(0), 0x1a45dfa3);
  const python = join(root, "whisper-env", "bin", "python");
  await mkdir(join(root, "whisper-env", "bin"), { recursive: true, mode: 0o700 });
  await symlink(await realpath("/usr/bin/python3"), python);
  const program = join(root, "transcribe"), model = join(root, "ggml-base.en-q5_1.bin"), credential = join(root, "bearer");
  const originalModel = "test-only program selection";
  await writeFile(program, ["#!" + python, "import sys", "payload = sys.stdin.buffer.read()",
    "if not payload.startswith(bytes.fromhex('1a45dfa3')): sys.exit(9)",
    "print(" + JSON.stringify(sentinel) + ", file=sys.stderr)", "sys.exit(5)", ""].join("\n"), { mode: 0o700 });
  await writeFile(model, originalModel, { mode: 0o600 });
  await writeFile(credential, auth, { mode: 0o600 });
  const [programHash, modelHash, ffmpegHash, pythonHash] = await Promise.all(
    [program, model, ffmpeg, python].map(async path => hash(await readFile(path))),
  );
  const pins = {
    PIRATE_LOCAL_STUDY_ASR: program,
    PIRATE_LOCAL_STUDY_ASR_SHA256: programHash,
    PIRATE_LOCAL_STUDY_MODEL_SHA256: modelHash,
    PIRATE_LOCAL_STUDY_FFMPEG_SHA256: ffmpegHash,
    PIRATE_LOCAL_STUDY_PYTHON_SHA256: pythonHash,
  };
  for (const [name, value] of Object.entries(pins)) {
    const old = process.env[name];
    t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
    process.env[name] = value;
  }
  const socketDirectory = join(root, "activity-transport");
  await mkdir(socketDirectory, { mode: 0o700 });
  const socket = join(socketDirectory, "host.sock");
  const holder = await processIdentity(process.pid);
  assert(holder);
  const lease = await acquireOperation(root, "stage-check", "stage-check", {}, holder.pidNamespace);
  const study: Web2LocalStudyPolicy = {
    schema: "pirate.web2-local-study-policy/1", issuer: `0x${"1".repeat(40)}`, operator: `0x${"2".repeat(40)}`,
    issuerFile: join(root, "unused"),
    asr: { origin, upstream: "unix:" + socket, authFile: credential, authSha256: hashText(auth),
      selectedProgramSha256: hashJson({ program: programHash, englishModel: modelHash, ffmpeg: ffmpegHash, python: pythonHash }) },
    speech: { keyGeneration: "test", dailyUnits: 1, websiteStudyReservedUnits: 1 },
  };
  const ingress: PublicIngress = {
    schema: "pirate.linux-public-ingress/1", origin: "https://localhost:4443", upstream: "https://127.0.0.1:8443",
    upstreamServerName: "unused.test", upstreamCaFile: join(root, "unused"), upstreamCaSha256: "1".repeat(64),
    executable: "/unused", executableSha256: "1".repeat(64), configurationFile: join(root, "unused"), dataDirectory: root,
    httpPort: 4080, httpsPort: 4443, tls: { kind: "local-fixture-ca" },
  };
  const host = await startWeb2NativeActivityHost({ selected: { schema: "pirate.web2-native-activities/1", socket },
    study, host: {}, ingress, stateRoot: root, lease });
  const adapter = carrier(async (input, init) => {
    const outgoing = new Request(input, init);
    const body = Buffer.from(await outgoing.arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const req = request({ socketPath: socket, path: new URL(outgoing.url).pathname, agent: false, method: outgoing.method,
        headers: { ...Object.fromEntries(outgoing.headers), "content-length": body.length }, signal: outgoing.signal }, reply => {
        const chunks: Buffer[] = [];
        reply.on("data", chunk => { chunks.push(chunk); });
        reply.on("error", reject);
        reply.on("end", () => resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: reply.statusCode ?? 500 })));
      });
      req.on("error", reject);
      req.end(body);
    });
  });
  try {
    const send = () => adapter.transcribe(signal, "audio/webm", "en");
    await assert.rejects(send(), speechError("unknown"));
    // The bytes still match, but execFile cannot start the now non-executable child.
    await chmod(program, 0o600);
    await assert.rejects(send(), speechError("unknown"));
    await chmod(program, 0o700);
    await writeFile(model, "changed selection");
    await assert.rejects(send(), speechError("unknown"));
    assert.equal(adapter.recover, undefined);
    assert.deepEqual(log, [[prefix + "host_child_exit"], [prefix + "worker_host_rejected"],
      [prefix + "host_child_start"], [prefix + "worker_host_rejected"],
      [prefix + "host_pin"], [prefix + "worker_host_rejected"]]);
  } finally {
    signal.fill(0);
    await host.close();
  }
});
