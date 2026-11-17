// Materialize beside the derived manual-demo.ts in the selected Alpha checkout.
// Shares the driver's existing fixture router. No added listener or runtime stack.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_STUDY_AUDIO_BYTES } from "../../packages/study/contracts.ts";
import { hashJson } from "../../packages/community/common.ts";

const sha = async (file: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** Root supplies one explicit existing program selection from the Genesis
 * preview. Only the retained executable and its adjacent English weights run. */
export async function selectLocalAsr() {
  const program = process.env.PIRATE_LOCAL_STUDY_ASR;
  if (program === undefined) return undefined;
  assert(program.startsWith("/") && await realpath(program) === program);
  await access(program, 1);
  const model = join(dirname(program), "ggml-base.en-q5_1.bin");
  const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", OPENBLAS_NUM_THREADS: "1" };
  const ffmpeg = await realpath("/usr/bin/ffmpeg");
  const interpreter = join(dirname(program), "whisper-env/bin/python");
  assert((await readFile(program, "utf8")).split("\n", 1)[0] === "#!" + interpreter,
    "local_study_asr_interpreter_changed");
  await access(interpreter, 1);
  const verify = async () => {
    const hashes = await Promise.all([sha(program), sha(model), sha(ffmpeg), sha(interpreter)]);
    for (const [index, digest] of [process.env.PIRATE_LOCAL_STUDY_ASR_SHA256,
      process.env.PIRATE_LOCAL_STUDY_MODEL_SHA256, process.env.PIRATE_LOCAL_STUDY_FFMPEG_SHA256,
      process.env.PIRATE_LOCAL_STUDY_PYTHON_SHA256].entries())
      assert(/^[a-f0-9]{64}$/.test(digest ?? "") && hashes[index] === digest,
        "local_study_asr_selected_bytes_changed");
    return hashes;
  };
  const hashes = await verify();
  let active: Promise<Response> | undefined;
  return {
    selectedProgramSha256: hashJson({ program: hashes[0], englishModel: hashes[1], ffmpeg: hashes[2], python: hashes[3] }),
    async route(auth: string, method: string, header: string, input: Buffer) {
      const wanted = Buffer.from("Bearer " + auth), offered = Buffer.from(header);
      if (method !== "POST" || wanted.length !== offered.length || !timingSafeEqual(wanted, offered))
        return new Response(null, { status: 403 });
      if (!input.length || input.length > MAX_STUDY_AUDIO_BYTES)
        return new Response(null, { status: 413 });
      if (active) return new Response(null, { status: 429 });
      const task = (async () => {
        try {
          assert(hashJson(await verify()) === hashJson(hashes), "local_study_asr_generation_changed");
          const transcript = await new Promise<string>((resolve, reject) => {
            const child = execFile(program, [], { env, timeout: 20000, maxBuffer: 65536,
              killSignal: "SIGKILL" }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
            child.stdin?.on("error", reject);
            child.stdin?.end(input);
          });
          return new Response(transcript, { headers: {
            "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
          } });
        } catch {
          return new Response(null, { status: 503 });
        } finally { input.fill(0); }
      })();
      active = task;
      try { return await task; } finally { active = undefined; }
    },
    async settled() { await active; },
  };
}
