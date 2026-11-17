// Root mounts this adapter in place of the Study route call for the explicit
// fresh profile. The existing HTTP handler still owns routing and its bodies.
import { canonical } from "../packages/protocol/index.ts";
import { jsonBody } from "../packages/community/common.ts";
import type { AuthContext } from "../packages/community/accounts.ts";
import { studyCheck } from "../packages/study/contracts.ts";
import { DancePrivateRequestSession } from "./dance-private-session.ts";
import { studyCommunityApi } from "./study-community-api.ts";
import type { StudyCommunityPorts } from "./study-community.ts";
import { studyV5Database } from "./study-v5-database.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";

export async function studyV5PrivateHttp(
  request: Request,
  ports: StudyCommunityPorts,
  context: AuthContext,
  headers: Headers,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/study/")) return null;
  if (
    ports.env.STUDY_RUNTIME === undefined &&
    ports.env.STUDY_PRIVATE_V5_PROFILE === undefined
  )
    return studyCommunityApi(request, ports, context, headers);
  const session = await DancePrivateRequestSession.open(
    request,
    ports.db,
    context,
  );
  const captured = canonical([
    ports.config,
    ports.env.STUDY_RUNTIME ?? null,
    ports.env.STUDY_PRIVATE_V5_PROFILE ?? null,
    ports.env.SPEECH_ADMISSION_CONFIG ?? null,
    ports.env.KARAOKE_OPERATOR_ADDRESS ?? null,
    ports.env.KARAOKE_PAYMENT_CHAIN_ID ?? null,
    ports.env.STUDY_GRADER_ACTIVATION ?? null,
  ]);
  const operator = ports.env.KARAOKE_OPERATOR,
    signer = ports.env.KARAOKE_SIGNER_PRIVATE_KEY,
    budget = ports.env.SPEECH_BUDGET;
  let lost = false;
  const runtime = () => {
    if (
      canonical([
        ports.config,
        ports.env.STUDY_RUNTIME ?? null,
        ports.env.STUDY_PRIVATE_V5_PROFILE ?? null,
        ports.env.SPEECH_ADMISSION_CONFIG ?? null,
        ports.env.KARAOKE_OPERATOR_ADDRESS ?? null,
        ports.env.KARAOKE_PAYMENT_CHAIN_ID ?? null,
        ports.env.STUDY_GRADER_ACTIVATION ?? null,
      ]) !== captured ||
      ports.env.KARAOKE_OPERATOR !== operator ||
      ports.env.KARAOKE_SIGNER_PRIVATE_KEY !== signer ||
      ports.env.SPEECH_BUDGET !== budget
    )
      lost = true;
    studyCheck(!lost, "study_private_v5_runtime_changed", 409);
  };
  const fences: DanceFence[] = [];
  const db = studyV5Database(ports.db, session, runtime, () => fences);
  const check = async () => {
    runtime();
    await session.check();
    runtime();
  };
  await check();
  if (request.method === "POST" && url.pathname === "/api/study/lessons") {
    const body = await jsonBody(request.clone());
    await check();
    studyCheck(
      body.publication === undefined ||
        canonical(body.publication) === canonical({ kind: "private" }),
      "study_v5_public_admission_unavailable",
      409,
    );
    studyCheck(
      Object.keys(body).every((key) =>
        ["requestId", "song", "publication"].includes(key),
      ),
      "invalid_study_request",
    );
  }
  const response = await studyCommunityApi(
    request,
    {
      ...ports,
      db,
      privateV5: { session, check, accept: (fence) => fences.push(fence) },
    },
    context,
    headers,
  );
  await check();
  return response;
}
