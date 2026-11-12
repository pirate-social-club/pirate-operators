// Explicit isolated harness. Coordinator supplies decodable same-origin audio.
import { SongPlayer } from "../src/shell/reference/song-player.tsx";
import type { SongPlaybackGrant } from "../src/shell/playback-access.ts";
import { createSignal, onCleanup, onSettled, Show } from "solid-js";
export function ShellPlayerInput(props: {
  id?: string;
  cache?: boolean;
  now?: () => number;
  visible?: boolean;
  readAccess?: (id: string) => Promise<SongPlaybackGrant>;
}) {
  return (
    <Show when={props.visible !== false}>
      <SongPlayer
        postId={props.id ?? "fixture-song"}
        title="Fixture song"
        compact
        now={props.now}
        cacheAccess={props.cache ?? false}
        readAccess={
          props.readAccess ??
          (async () => ({
            playback_url: new URL("/fixture-song.wav", location.origin).href,
          }))
        }
      />
    </Show>
  );
}

/** Delayed A access, real hash/popstate navigation, and a distinct real B URL. */
export function ShellPlayerSwitchInput() {
  const [id, setId] = createSignal("fixture-A");
  let resolveA!: (grant: SongPlaybackGrant) => void;
  const pendingA = new Promise<SongPlaybackGrant>((resolve) => {
    resolveA = resolve;
  });
  const reader = (postId: string) =>
    postId === "fixture-A"
      ? pendingA
      : Promise.resolve({
          playback_url: new URL("/fixture-b.wav", location.origin).href,
        });
  const sync = () =>
    setId(location.hash === "#fixture-B" ? "fixture-B" : "fixture-A");
  onSettled(() => {
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
  });
  onCleanup(() => {
    window.removeEventListener("hashchange", sync);
    window.removeEventListener("popstate", sync);
  });
  return (
    <>
      <button
        onClick={() => {
          location.hash = "#fixture-A";
        }}
      >
        Fixture navigate A
      </button>
      <button
        onClick={() => {
          location.hash = "#fixture-B";
        }}
      >
        Fixture navigate B
      </button>
      <button
        onClick={() =>
          resolveA({
            playback_url: new URL("/fixture-a.wav", location.origin).href,
          })
        }
      >
        Fixture resolve A
      </button>
      <SongPlayer
        postId={id()}
        title={id()}
        compact
        cacheAccess
        readAccess={reader}
      />
    </>
  );
}

/** Same public post, genuinely different immutable access readers. Test only. */
export function ShellPlayerReaderInput(props: {
  bRefuses?: boolean;
  aImmediate?: boolean;
  sameReader?: boolean;
}) {
  const [selected, setSelected] = createSignal<"A" | "B">("A");
  const [visible, setVisible] = createSignal(true);
  const [aCalls, setACalls] = createSignal(0);
  const [bCalls, setBCalls] = createSignal(0);
  let resolveA!: (grant: SongPlaybackGrant) => void;
  const pendingA = new Promise<SongPlaybackGrant>((resolve) => {
    resolveA = resolve;
  });
  const aGrant = () => ({
    playback_url: new URL("/fixture-a.wav", location.origin).href,
  });
  const readerA = (_id: string) => {
    setACalls((count) => count + 1);
    return props.aImmediate ? Promise.resolve(aGrant()) : pendingA;
  };
  const readerB = props.sameReader
    ? readerA
    : async (_id: string) => {
        setBCalls((count) => count + 1);
        if (props.bRefuses) throw new Error("fixture reader B refuses access");
        return {
          playback_url: new URL("/fixture-b.wav", location.origin).href,
        };
      };
  return (
    <div
      data-reader-fixture
      data-reader={selected()}
      data-a-calls={aCalls()}
      data-b-calls={bCalls()}
    >
      <button onClick={() => setSelected("B")}>Fixture replace reader B</button>
      <button onClick={() => setVisible(false)}>Fixture hide player</button>
      <button
        onClick={() => {
          setSelected("B");
          setVisible(true);
        }}
      >
        Fixture show reader B
      </button>
      <button
        onClick={() => {
          setSelected("A");
          setVisible(true);
        }}
      >
        Fixture show reader A
      </button>
      <button onClick={() => resolveA(aGrant())}>
        Fixture resolve reader A
      </button>
      <Show when={visible()}>
        <SongPlayer
          postId="fixture-same-post"
          title="Fixture same post"
          compact
          readAccess={selected() === "A" ? readerA : readerB}
        />
      </Show>
    </div>
  );
}
