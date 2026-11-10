// Standalone acceptance entry. The coordinator owns the live router and sign-in.
import { render } from "@solidjs/web";
import type { StudySong } from "../../../../packages/study/lesson.ts";
import { createStudyClient } from "./client.ts";
import { StudyScreen } from "./screen.tsx";
import "./style.css";

const response = await fetch("/api/study/config", {
  credentials: "same-origin",
});
if (!response.ok)
  document.getElementById("app")!.textContent =
    "Study is unavailable. Sign in and try again.";
else {
  const config: { song: StudySong; csrf: string; account: string } =
    await response.json();
  const initial =
    new URL(location.href).searchParams.get("lesson") ?? undefined;
  const client = createStudyClient(
    config.song,
    () => config.csrf,
    initial,
    (id) => {
      const url = new URL(location.href);
      url.searchParams.set("lesson", id);
      history.replaceState(null, "", url);
    },
    undefined,
    undefined,
    config.account,
  );
  render(
    () => <StudyScreen client={client} />,
    document.getElementById("app")!,
  );
}
