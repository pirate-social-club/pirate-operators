import { For, Show, createSignal, onCleanup } from "solid-js";
import { Button, Card, CardContent, Type } from "../shell/design-system.ts";

interface Recording {
  id: string;
  title: string;
  readyAt: number;
  expiresAt: number;
}
interface HistoryPage {
  communityId: string;
  accountId: string;
  records: Recording[];
  next: string | null;
}
export function PrivateDanceHistory(props: {
  owner: { communityId: string; accountId: string; csrf: string };
}) {
  const [rows, setRows] = createSignal<Recording[] | null>(null),
    [before, setBefore] = createSignal<string | null>(null);
  const [error, setError] = createSignal(""),
    [loading, setLoading] = createSignal(false);
  const [playing, setPlaying] = createSignal<{
    id: string;
    url: string;
  } | null>(null);
  const owner = props.owner;
  const headers = {
    "x-dance-account": owner.accountId,
    "x-csrf-token": owner.csrf,
  };
  let request: AbortController | undefined,
    expiry: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  function stopPreview() {
    clearTimeout(expiry);
    const old = playing();
    setPlaying(null);
    if (old) URL.revokeObjectURL(old.url);
  }
  function clearHistory(message: string) {
    stopPreview();
    setRows(null);
    setBefore(null);
    setError(message);
  }
  onCleanup(() => {
    alive = false;
    request?.abort();
    stopPreview();
  });
  async function load(append: boolean) {
    if (loading()) return;
    request?.abort();
    const pending = (request = new AbortController());
    setLoading(true);
    setError("");
    try {
      const cursor = append ? before() : null;
      const response = await fetch(
        "/api/dance/history" +
          (cursor ? "?before=" + encodeURIComponent(cursor) : ""),
        { headers, signal: pending.signal, cache: "no-store" },
      );
      if (!response.ok) throw Error();
      const page: HistoryPage = await response.json();
      if (
        page.communityId !== owner.communityId ||
        page.accountId !== owner.accountId ||
        !Array.isArray(page.records)
      )
        throw Error();
      if (!alive || pending.signal.aborted) return;
      setRows(append ? [...(rows() ?? []), ...page.records] : page.records);
      setBefore(page.next);
    } catch {
      if (alive && !pending.signal.aborted)
        clearHistory("Your recordings could not be loaded.");
    } finally {
      if (alive && request === pending) setLoading(false);
    }
  }
  async function play(record: Recording) {
    if (loading()) return;
    request?.abort();
    const pending = (request = new AbortController());
    stopPreview();
    setError("");
    setLoading(true);
    try {
      const response = await fetch(
        "/api/media/" + encodeURIComponent(record.id) + "/playback",
        { headers, signal: pending.signal, cache: "no-store" },
      );
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("video/")
      )
        throw Error();
      const blob = await response.blob();
      if (!alive || pending.signal.aborted) return;
      if (record.expiresAt <= Date.now()) throw Error();
      setPlaying({ id: record.id, url: URL.createObjectURL(blob) });
      expiry = setTimeout(
        stopPreview,
        Math.max(0, record.expiresAt - Date.now()),
      );
    } catch {
      if (alive && !pending.signal.aborted)
        clearHistory("This recording could not be played.");
    } finally {
      if (alive && request === pending) setLoading(false);
    }
  }
  return (
    <Card>
      <CardContent class="flex flex-col gap-3 p-4">
        <Type as="h2" variant="h3">
          Private Dance recordings
        </Type>
        <Button
          class="self-start"
          variant="outline"
          disabled={loading()}
          onClick={() => void load(false)}
        >
          {rows() ? "Refresh recordings" : "Show recordings"}
        </Button>
        <Show when={error()}>{(value) => <p role="alert">{value()}</p>}</Show>
        <Show when={rows()?.length === 0}>
          <p>No saved recordings.</p>
        </Show>
        <For each={rows() ?? []}>
          {(row) => (
            <div class="flex flex-col gap-2">
              <p>
                {row.title} · {new Date(row.readyAt).toLocaleString()}
              </p>
              <Button
                class="self-start"
                variant="outline"
                disabled={loading()}
                onClick={() => void play(row)}
              >
                Open recording
              </Button>
              <Show when={playing()?.id === row.id}>
                <video
                  class="max-h-96 w-full"
                  controls
                  playsinline
                  preload="metadata"
                  src={playing()!.url}
                />
              </Show>
            </div>
          )}
        </For>
        <Show when={before()}>
          <Button
            class="self-start"
            variant="outline"
            disabled={loading()}
            onClick={() => void load(true)}
          >
            Older recordings
          </Button>
        </Show>
      </CardContent>
    </Card>
  );
}
