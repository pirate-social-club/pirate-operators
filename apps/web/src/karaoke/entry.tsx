// Standalone acceptance entry for the adopted Karaoke screen. Without a capture
// fixture it plays a timed manifest and simulates an active take. With one, it
// captures the microphone and streams to the operator socket the acceptance
// host exposes. Not the live router; see docs/karaoke-learner-handoff.md and
// docs/karaoke-capture-handoff.md.
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import {
  karaokeStageLinesOf,
  type KaraokeTimedLine,
} from "../../../../packages/karaoke/manifest-lines.ts";
import { KaraokePracticeSurface } from "./practice-surface.tsx";
import { useKaraokeCapture } from "./use-karaoke-capture.ts";
import "./style.css";

interface Fixture {
  title: string;
  instrumentalUrl: string;
  lines: KaraokeTimedLine[];
  capture?: { socketUrl: string; ticketId: string };
}
type Status = "idle" | "active" | "ended";

const fixture = (await (
  await fetch("/__fixture/karaoke.json")
).json()) as Fixture;

function PlaybackApp() {
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

function CaptureApp(props: { capture: NonNullable<Fixture["capture"]> }) {
  const [finished, setFinished] = createSignal(false);
  let latest: WebSocket | null = null;
  const capture = useKaraokeCapture({
    enabled: true,
    ticketId: props.capture.ticketId,
    openSocket: () => {
      const socket = new WebSocket(props.capture.socketUrl);
      socket.binaryType = "arraybuffer";
      latest = socket;
      return socket;
    },
  });
  // Acceptance-only hook: simulates a network drop of the live socket.
  (globalThis as { karaokeAcceptance?: unknown }).karaokeAcceptance = {
    dropSocket: () => latest?.close(4000, "acceptance_drop"),
    status: () => capture.state()?.status ?? "idle",
    state: () => capture.state(),
    context: () =>
      capture.playbackGraph.isRunning() ? "running" : "not-running",
  };
  const status = () =>
    finished() ? "ended" : (capture.state()?.status ?? "idle");
  return (
    <KaraokePracticeSurface
      title={fixture.title}
      instrumentalAudioUrl={fixture.instrumentalUrl}
      lines={karaokeStageLinesOf(fixture.lines)}
      singingStatus={status()}
      onStartSinging={(songMs) => capture.controls.start(songMs)}
      onPlaybackElement={(element) =>
        capture.controls.attachPlaybackElement(element)
      }
      playbackInterrupted={capture.playbackInterrupted()}
      onResumePlayback={() => capture.controls.resumePlayback()}
      onTimeChange={(songMs) => capture.controls.noteTime(songMs)}
      onPlay={(songMs) => capture.controls.notePlay(songMs)}
      onPause={(songMs) => capture.controls.notePause(songMs)}
      onSeek={(songMs) => capture.controls.noteSeek(songMs)}
      onFinish={(songMs) =>
        void Promise.resolve(capture.controls.noteFinish(songMs)).then(() =>
          setFinished(true),
        )
      }
    />
  );
}

render(
  () => (
    <Show when={fixture.capture} fallback={<PlaybackApp />}>
      {(capture) => <CaptureApp capture={capture()} />}
    </Show>
  ),
  document.getElementById("app")!,
);
