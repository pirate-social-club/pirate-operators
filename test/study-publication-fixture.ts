import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { readPublicResultsV3 } from "../packages/records/results-v3.ts";
import {
  studySourceReader,
  studySourceAuthenticator,
} from "../packages/records/study-source-authentication.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { keys } from "../harness/runtime.ts";
import type {
  StudyLesson,
  StudyLessonSubmission,
  StudySong,
} from "../packages/study/lesson.ts";
import type { StudyAttempt } from "../packages/study/contracts.ts";
import type {
  StudyTerminalRequest,
  StudyPublicationReceipt,
} from "../packages/study/publication.ts";
import type { StudyOperatorPorts } from "../services/study-operator-client.ts";

export async function json<T>(response: Response) {
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as T;
}
export const lessonPath = (id: string) => "/api/study/lessons/" + id;
export async function studyPublicationFixture(port: number) {
  const f = await studyCommunityFixture(port);
  try {
    const auth = await f.login();
    await f.enroll();
    const song = await json<StudySong>(
      await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
        headers: auth,
      }),
    );
    const operator: StudyOperatorPorts = {
      binding: f.env.KARAOKE_OPERATOR!,
      issuerKey: keys[1],
      now: f.clock,
      authority: {
        chainId: 31337,
        communityId: f.config.communityId,
        operator: f.operatorEnv.OPERATOR_ADDRESS,
        contract: f.v3,
      },
    };
    return {
      ...f,
      auth,
      song,
      operator,
      async start() {
        return json<StudyLesson>(
          await f.post(
            "/api/study/lessons",
            {
              requestId: crypto.randomUUID(),
              song,
            },
            auth,
          ),
        );
      },
      async get(id: string) {
        return json<StudyLesson>(
          await f.call(lessonPath(id), { headers: auth }),
        );
      },
      async abandon(id: string) {
        return json<StudyLesson>(
          await f.post(lessonPath(id) + "/abandon", {}, auth),
        );
      },
      async answer(lesson: StudyLesson, correct: boolean) {
        const opened = await json<{ attempt: StudyAttempt }>(
          await f.post(
            lessonPath(lesson.lessonId) + "/attempts",
            {
              presentationNumber: lesson.current!.presentationNumber,
              takeNumber: lesson.current!.takeNumber,
            },
            auth,
          ),
        );
        f.heard(correct ? opened.attempt.line.text : "unrelated words");
        return json<StudyLessonSubmission>(
          await f.call(
            lessonPath(lesson.lessonId) +
              "/attempts/" +
              opened.attempt.attemptId +
              "/audio",
            {
              method: "PUT",
              headers: {
                ...auth,
                origin: firstSong.origin,
                "content-type": "audio/webm",
                "x-study-duration-ms": "1000",
              },
              body: new Uint8Array([
                0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 1,
              ]),
            },
          ),
        );
      },
      async publication(id: string) {
        return json<{ state: string; receipt: StudyPublicationReceipt | null }>(
          await f.call(lessonPath(id) + "/publication", { headers: auth }),
        );
      },
      async readResults() {
        const reads = f.ports.publicReads!;
        const source = {
          client: reads.client,
          posts: reads.profile,
          head: 101n,
          history: [f.config],
          transport: reads.transport,
        };
        return readPublicResultsV3({
          rpcUrl: f.evm.rpcUrl,
          chainId: 31337,
          contract: f.v3,
          runtimeCodeHash: keccak256(
            (await f.evm.publicClient.getCode({ address: f.v3 }))!,
          ),
          communityId: f.config.communityId,
          fromBlock: 0n,
          toBlock: await f.evm.publicClient.getBlockNumber({ cacheTime: 0 }),
          studyManifest: studySourceReader(source),
          authenticateStudy: studySourceAuthenticator(source),
        });
      },
      async terminal(id: string): Promise<StudyTerminalRequest> {
        const row = await f.db
          .prepare(
            "SELECT l.state_json,p.source_json FROM study_lessons l JOIN study_publications p USING(lesson_id) WHERE lesson_id=?",
          )
          .bind(id)
          .first<{ state_json: string; source_json: string }>();
        assert.ok(row);
        return {
          lessonId: id,
          state: JSON.parse(row.state_json),
          source: JSON.parse(row.source_json),
        };
      },
    };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}
