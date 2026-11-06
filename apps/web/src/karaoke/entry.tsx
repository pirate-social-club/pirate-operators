// Standalone acceptance entry for the adopted Karaoke screen. It plays a timed
// fixture manifest through the protocol adapter. Starting a take is simulated
// as immediately active: microphone capture, transcription and scoring are a
// later slice. Not the live router; see docs/karaoke-learner-handoff.md.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import {
  karaokeStageLinesOf,
  type KaraokeTimedLine,
} from "../../../../packages/karaoke/manifest-lines.ts";
import { KaraokePracticeSurface } from "./practice-surface.tsx";
import "./style.css";

interface Fixture {
  title: string;
  instrumentalUrl: string;
  lines: KaraokeTimedLine[];
}
type Status = "idle" | "active" | "ended";

const fixture = (await (
  await fetch("/__fixture/karaoke.json")
).json()) as Fixture;

function App() {
  const [status, setStatus] = createSignal<Status>("idle");
  return (
    <KaraokePracticeSurface
      title={fixture.title}
      instrumentalAudioUrl={fixture.instrumentalUrl}
      lines={karaokeStageLinesOf(fixture.lines)}
      singingStatus={status()}
      onStartSinging={() => setStatus("active")}
      onFinish={() => setStatus("ended")}
      onExit={() => setStatus("idle")}
    />
  );
}

render(() => <App />, document.getElementById("app")!);
