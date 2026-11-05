import { CID } from "multiformats/cid";
import { Context, bounded } from "./http.ts";
import { digest, object, requireThat, SetupFailure } from "./model.ts";

/** Compatibility experiment only. Filebase's published PinManager constructs
 * a PSA bearer token this way. RPC is a different API; test acceptance rather
 * than asserting equivalence with the console's short-lived bucket tokens.
 * https://filebase.github.io/filebase-sdk/pinManager.js.html */
export async function qualifyRpcRead(
  ctx: Context,
  probe: { cid: string; sha256: string },
) {
  requireThat(
    ctx.plan.profile.filebaseRpcCheck === "sdk-base64-read-only" &&
      ctx.plan.limits.filebaseRpcRead === 3,
    "rpc_probe_not_authorized_by_plan",
  );
  requireThat(CID.parse(probe.cid).toString() === probe.cid, "rpc_invalid_cid");
  const steps = ctx.store.journal!.steps;
  for (const name of [
    "filebase.account",
    "filebase.bucket",
    "filebase.upload",
    "filebase.retrieval",
  ])
    requireThat(
      steps[name]?.state === "done",
      "rpc_requires_verified_s3_probe",
    );
  requireThat(
    steps["filebase.bucket"].receipt?.bucket === ctx.plan.names.filebase &&
      steps["filebase.upload"].receipt?.cid === probe.cid &&
      steps["filebase.upload"].receipt?.sha256 === probe.sha256 &&
      steps["filebase.retrieval"].receipt?.cid === probe.cid &&
      steps["filebase.retrieval"].receipt?.passed === true,
    "rpc_probe_binding_mismatch",
  );
  const perform = async () => {
    const previous = steps["filebase.rpc-read"].receipt?.attempts ?? 0;
    requireThat(
      typeof previous === "number" && previous < 3,
      "rpc_read_attempts_exhausted",
    );
    const attempts = previous + 1;
    await ctx.store.note("filebase.rpc-read", { attempts });
    const accessToken = await ctx.secret("bootstrap", "FILEBASE_ACCESS_KEY_ID");
    const secretKey = await ctx.secret(
      "bootstrap",
      "FILEBASE_SECRET_ACCESS_KEY",
    );
    requireThat(
      steps["filebase.account"].receipt?.fingerprint === digest(accessToken),
      "filebase_account_changed",
    );
    // Base64 does not reduce authority: this transmits the pair to Filebase
    // inside the authenticated TLS request. Never persist/export this value.
    const candidate = Buffer.from(
      `${accessToken}:${secretKey}:${ctx.plan.names.filebase}`,
    ).toString("base64");
    const response = await ctx.request(
      `https://rpc.filebase.io/api/v0/pin/ls?arg=${encodeURIComponent(probe.cid)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${candidate}` },
      },
    );
    const common = {
      attempts,
      httpStatus: response.status,
      credentialFormat: "sdk_base64_candidate",
      runtimeCredentialReady: false,
      scopeProof: "not_established",
      expiryProof: "not_established",
    };
    if (!response.ok) {
      await response.body?.cancel();
      requireThat(
        ![404, 429].includes(response.status) && response.status < 500,
        "rpc_read_temporarily_unavailable",
      );
      return { ...common, passed: false, result: "candidate_rejected" };
    }
    let data: Record<string, unknown>;
    try {
      data = object(JSON.parse((await bounded(response, 65536)).toString()));
    } catch {
      throw new SetupFailure("rpc_response_invalid_details_withheld");
    }
    const keys = object(data.Keys);
    requireThat(Object.hasOwn(keys, probe.cid), "rpc_pin_not_confirmed");
    return {
      ...common,
      cid: probe.cid,
      passed: true,
      result: "read_compatible_only",
    };
  };
  return ctx.store.once("filebase.rpc-read", perform, perform);
}
