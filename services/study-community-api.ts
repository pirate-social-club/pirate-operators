import {
  accountSession,
  authenticatedWrite,
} from "../packages/community/accounts.ts";
import {
  bytes32,
  insist,
  jsonBody,
  requestOrigin,
  text,
} from "../packages/community/common.ts";
import { studyId } from "../packages/study/operator-contract.ts";
import { StudyError } from "../packages/study/contracts.ts";
import { liveStudy, type StudyCommunityPorts } from "./study-community.ts";

export async function studyCommunityApi(
  request: Request,
  ports: StudyCommunityPorts,
  context: { communityId: `0x${string}`; origin: string },
  headers: Headers,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/study/")) return null;
  const session =
    request.method === "GET"
      ? await accountSession(request, ports.db, context)
      : await authenticatedWrite(request, ports.db, context);
  if (request.method !== "GET") requestOrigin(request, context.origin);
  const study = liveStudy(ports, session),
    reply = (value: unknown) => Response.json(value, { headers });
  if (url.pathname === "/api/study/song") {
    insist(request.method === "GET", "method_not_allowed", 405);
    return reply(await study.song(bytes32(url.searchParams.get("postId"))));
  }
  if (url.pathname === "/api/study/lessons") {
    if (request.method === "GET") {
      const song = text(url.searchParams.get("song"), 2000);
      return reply(await study.latest(JSON.parse(song)));
    }
    insist(request.method === "POST", "method_not_allowed", 405);
    const body = await jsonBody(request);
    return reply(await study.start(text(body.requestId, 128), body.song));
  }
  const parts = url.pathname.slice("/api/study/lessons/".length).split("/");
  if (!url.pathname.startsWith("/api/study/lessons/") || !studyId(parts[0]))
    throw new StudyError("study_route_not_found", 404);
  const [id, action, attempt, audio] = parts;
  if (parts.length === 1) {
    insist(request.method === "GET", "method_not_allowed", 405);
    return reply(await study.get(id));
  }
  if (parts.length === 2 && action === "abandon") {
    insist(request.method === "POST", "method_not_allowed", 405);
    return reply(await study.abandon(id));
  }
  if (parts.length === 2 && action === "publication") {
    insist(request.method === "GET", "method_not_allowed", 405);
    return reply(await study.publication(id));
  }
  if (parts.length === 2 && action === "attempts") {
    insist(request.method === "POST", "method_not_allowed", 405);
    const body = await jsonBody(request);
    return reply(
      await study.open(
        id,
        Number(body.presentationNumber),
        Number(body.takeNumber),
      ),
    );
  }
  if (
    parts.length === 4 &&
    action === "attempts" &&
    studyId(attempt) &&
    audio === "audio"
  ) {
    insist(request.method === "PUT", "method_not_allowed", 405);
    return reply(await study.submit(id, attempt, request));
  }
  throw new StudyError("study_route_not_found", 404);
}
