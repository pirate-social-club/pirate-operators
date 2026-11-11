// Isolated local inputs over the actual source components. Never a live entry.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import {
  ShellPlayerInput,
  ShellPlayerReaderInput,
  ShellPlayerSwitchInput,
} from "./shell-player-inputs.tsx";
import { ProfileCompositionInput } from "./profile-composition-inputs.tsx";
import { ProfileRecoveryInput } from "./profile-recovery-inputs.tsx";
import { runDanceStorageBrowserCases } from "./dance-source-storage.browser.ts";
import { runCommunityStorageBrowserCases } from "./media-community-storage.browser.ts";
import { runCommunityHostBrowserCase } from "./media-community-host.browser.tsx";
import { runCommunityComposerBrowserCase } from "./media-community-composer.browser.tsx";
import storageWorkerUrl from "./media-community-storage.worker.ts?worker&url";
import "./owner-ui.fixture.css";

const query = new URL(location.href).searchParams;
const profiles = [
  "empty",
  "populated",
  "read-error",
  "logout-error",
  "activity-error",
  "signed-out",
  "loading",
  "settings-unavailable",
] as const;
function Player() {
  const [visible, setVisible] = createSignal(true);
  const [reads, setReads] = createSignal(0);
  let clock = Date.now();
  const renewal = query.get("mode") === "renew";
  const reader = async () => {
    setReads((count) => count + 1);
    return {
      playback_url: new URL("/fixture-song.wav", location.origin).href,
      ...(renewal
        ? {
            expires_at: Math.floor(clock / 1000) + 3,
            renew_after: Math.floor(clock / 1000) + 1,
          }
        : {}),
    };
  };
  return (
    <div data-grant-reads={reads()}>
      <button
        onClick={() => {
          clock += 4000;
        }}
      >
        Fixture advance grant clock
      </button>
      <button onClick={() => setVisible(false)}>Fixture unmount player</button>
      <ShellPlayerInput
        visible={visible()}
        cache={false}
        now={() => clock}
        readAccess={reader}
      />
    </div>
  );
}
function Storage() {
  const [status, setStatus] = createSignal("idle");
  const [detail, setDetail] = createSignal("");
  return (
    <div>
      <button
        onClick={() => {
          setStatus("running");
          void runDanceStorageBrowserCases().then(
            (value) => {
              setDetail(JSON.stringify(value));
              setStatus("passed");
            },
            (error) => {
              setDetail(String(error));
              setStatus("failed");
            },
          );
        }}
      >
        Run actual Dance storage cases
      </button>
      <output data-storage-status={status()}>{detail()}</output>
    </div>
  );
}
function MediaCases(props: { kind: string }) {
  const [status, setStatus] = createSignal("idle"),
    [detail, setDetail] = createSignal("");
  let root: HTMLDivElement | undefined;
  const run = () => {
    setStatus("running");
    const work =
      props.kind === "media-storage"
        ? runCommunityStorageBrowserCases(storageWorkerUrl)
        : props.kind === "media-host"
          ? runCommunityHostBrowserCase(root!)
          : runCommunityComposerBrowserCase(root!);
    void work.then(
      (value) => {
        setDetail(JSON.stringify(value));
        setStatus("passed");
      },
      (error) => {
        setDetail(String(error));
        setStatus("failed");
      },
    );
  };
  return (
    <>
      <button onClick={run}>Run actual community cases</button>
      <output data-community-status={status()}>{detail()}</output>
      <div
        ref={(element) => {
          root = element;
        }}
      />
    </>
  );
}
function Fixture() {
  const mode = query.get("fixture");
  if (mode === "profile") {
    const scenario =
      profiles.find((value) => value === query.get("case")) ?? "empty";
    return <ProfileCompositionInput scenario={scenario} />;
  }
  if (mode === "profile-recovery") {
    const status =
      [401, 403, 429].find((value) => String(value) === query.get("status")) ??
      429;
    const failureAt = query.get("at") === "owner" ? "owner" : "receipt";
    return (
      <ProfileRecoveryInput
        failureAt={failureAt}
        status={status}
        body={
          status === 429 ? '{"error":"rate_limited"}' : "<html>Sign in</html>"
        }
      />
    );
  }
  if (mode === "reader") {
    const bRefuses = query.get("refuse") === "1",
      aImmediate = query.get("cached") === "1",
      sameReader = query.get("same") === "1";
    return (
      <ShellPlayerReaderInput
        bRefuses={bRefuses}
        aImmediate={aImmediate}
        sameReader={sameReader}
      />
    );
  }
  if (mode === "switch") return <ShellPlayerSwitchInput />;
  if (mode === "dance-storage") return <Storage />;
  if (
    mode === "media-storage" ||
    mode === "media-host" ||
    mode === "media-composer"
  )
    return <MediaCases kind={mode} />;
  return <Player />;
}
render(
  () => (
    <main class="mx-auto max-w-3xl p-5">
      <Fixture />
    </main>
  ),
  document.getElementById("app")!,
);
