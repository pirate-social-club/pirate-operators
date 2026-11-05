// Standalone acceptance entry. The coordinator mounts StudyScreen in the live router.
import { render } from "@solidjs/web";
import type { StudyLine } from "../../../../packages/study/contracts.ts";
import { createStudyClient } from "./client.ts";
import { StudyScreen } from "./screen.tsx";

const response = await fetch("/api/study/lesson", {
  credentials: "same-origin",
});
if (!response.ok)
  document.getElementById("app")!.textContent =
    "Study is unavailable. Sign in and try again.";
else {
  const lesson: { lines: StudyLine[]; csrf: string } = await response.json();
  render(
    () => (
      <StudyScreen
        lines={lesson.lines}
        client={createStudyClient(() => lesson.csrf)}
      />
    ),
    document.getElementById("app")!,
  );
}
