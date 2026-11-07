import { accounts } from "../harness/runtime.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  STUDY_POLICY,
  STUDY_SCHEMA,
  type StudyAttempt,
} from "../packages/study/contracts.ts";
import {
  consumeLessonGrade,
  newLesson,
  songOf,
} from "../packages/study/lesson.ts";
import { gradeTranscriptV2 } from "../packages/study/transcript-grading.ts";
import { studySourceSelection } from "../packages/study/public-source.ts";
import { completedStudyBundle } from "../packages/study/result-adapter.ts";
import { studyQualificationPolicy } from "../packages/records/study-qualification.ts";

export function studyResultFixture(
  firstPass = [false, true, true, true],
  startedAt = 1800000000000,
  ordinals = [7, 2, 10, 4],
  repeatCorrect = true,
) {
  const source = createLyrics(
    {
      chainId: 6343,
      postsContract: accounts[0].address.toLowerCase() as `0x${string}`,
      communityId: digest("study-community"),
      postId: digest("study-song"),
    },
    "[Verse]\nHold me close\nStay with me\nWalk into the light\nKeep the fire bright\nHold me close\nNever let me fall\nSing a new refrain\nCatch the rising tide\nBring the morning home",
    "en",
  );
  for (const line of source.lines)
    line.lineId = digest(`source-line-${line.order}`);
  const selected = studySourceSelection(source, ordinals);
  let state = newLesson(
      songOf(selected.selected[0]),
      selected.selected,
      startedAt,
    ),
    now = startedAt;
  while (state.status === "active") {
    const index = state.currentIndex!,
      item = state.items[index];
    const correct = item.presentations > 0 ? repeatCorrect : firstPass[index];
    const attemptId = `private-attempt-${state.presentationCount}`;
    state.currentAttemptId = attemptId;
    const attempt: StudyAttempt = {
      schema: STUDY_SCHEMA,
      kind: "say-it-back",
      attemptId,
      line: item.line,
      policy: STUDY_POLICY,
      startedAt: now,
      completedAt: now + 2000,
      state: "assessed",
      grade: gradeTranscriptV2(
        item.line.text,
        correct ? item.line.text : "unrelated words",
        "en",
        STUDY_POLICY,
      ),
      failure: null,
      lesson: null,
      recordingDurationMs: 2000,
      qualification: "not_evaluated",
    };
    now += 2000;
    state = consumeLessonGrade(state, attempt, now);
  }
  const policy = studyQualificationPolicy([accounts[2].address]);
  const input = {
    lessonId: "private-lesson-id",
    state,
    source,
    enrollment: {
      id: digest("enrollment"),
      issuedAt: Math.floor(startedAt / 1000) - 1,
      expiresAt: Math.floor(startedAt / 1000) + 86400,
    },
    learner: accounts[5].address,
    grader: accounts[2].address,
    qualificationPolicy: digest(policy),
  };
  return { source, state, input, policy, bundle: completedStudyBundle(input) };
}
