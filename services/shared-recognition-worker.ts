import { bytes32, exact, object } from "../packages/community/common.ts";
import { configuredRecognitionRuntime, type SharedRecognitionEnv } from "./shared-recognition-configuration.ts";
import type { RecognitionWake } from "./shared-recognition-runtime.ts";

export default {
  async fetch(request, env) {
    try { return await configuredRecognitionRuntime(env).fetch(request); }
    catch { return Response.json({ error: "recognition_configuration_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }); }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = object(message.body);
      if (body.kind === "reservation") { exact(body, ["kind", "reservationId"]); bytes32(body.reservationId); }
      else { exact(body, ["kind", "recordingId"]); if (body.kind !== "recording") throw new Error("invalid_recognition_wake"); bytes32(body.recordingId); }
    }
    await configuredRecognitionRuntime(env).queue(batch);
  },
  async scheduled(_event, env) {
    // Recovery enqueues due persisted originals. It never supplies a result.
    await configuredRecognitionRuntime(env).scheduled();
  },
} satisfies ExportedHandler<SharedRecognitionEnv, RecognitionWake>;
