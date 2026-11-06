// Simulated ElevenLabs realtime speech-to-text and forced alignment, for local
// acceptance only. It implements the single-use token mint and the realtime
// socket messages that packages/karaoke/elevenlabs-realtime.ts uses, with
// scripted word timestamps relative to each stream's own audio cursor, and
// the forced-alignment response shape packages/alignment parses, with
// deterministic timings for the exact submitted text. Never packaged or deployed.

/** Seconds from the start of the provider stream, as the provider reports them. */
export interface SimulatedWord {
  text: string;
  start: number;
  end: number;
}
export interface SimulatedStream {
  words: SimulatedWord[];
  /** Drops the socket without a close handshake after this many audio chunks. */
  dropAfterChunks?: number;
  /** Sends a terminal provider error after this many audio chunks. */
  terminalAfterChunks?: number;
  terminalCode?: string;
  /** Never answers commits, so their acknowledgements time out. */
  ignoreCommits?: boolean;
  /** Answers only this many commits, then ignores the rest. */
  answerCommits?: number;
  /** Answers each commit after this delay, as a slow provider does. */
  commitDelayMs?: number;
}
export interface SimulatedStreamLog {
  params: Record<string, string>;
  chunks: number;
  audioMs: number;
  commits: number;
  emitted: string[];
  sampleRates: number[];
}

export class SimulatedScribeStream {
  readonly log: SimulatedStreamLog;
  private readonly script: SimulatedStream;
  private readonly send: (text: string) => void;
  private readonly drop: () => void;
  private readonly emitted = new Set<number>();
  private ended = false;

  constructor(
    script: SimulatedStream,
    params: Record<string, string>,
    send: (text: string) => void,
    drop: () => void,
  ) {
    this.script = script;
    this.send = send;
    this.drop = drop;
    this.log = {
      params,
      chunks: 0,
      audioMs: 0,
      commits: 0,
      emitted: [],
      sampleRates: [],
    };
  }

  receive(text: string): void {
    if (this.ended) return;
    const message = JSON.parse(text) as {
      message_type?: string;
      audio_base_64?: string;
      sample_rate?: number;
      commit?: boolean;
    };
    if (message.message_type !== "input_audio_chunk") return;
    if (message.commit === true) return this.commit();
    const bytes = atob(message.audio_base_64 ?? "").length;
    this.log.chunks += 1;
    const rate = message.sample_rate ?? 0;
    if (!this.log.sampleRates.includes(rate)) this.log.sampleRates.push(rate);
    this.log.audioMs += (bytes / 2 / (message.sample_rate ?? 16000)) * 1000;
    if (
      this.script.dropAfterChunks !== undefined &&
      this.log.chunks >= this.script.dropAfterChunks
    ) {
      this.ended = true;
      return this.drop();
    }
    if (
      this.script.terminalAfterChunks !== undefined &&
      this.log.chunks >= this.script.terminalAfterChunks
    ) {
      this.ended = true;
      this.send(
        JSON.stringify({
          message_type: this.script.terminalCode ?? "quota_exceeded",
          error: "simulated",
        }),
      );
    }
  }

  private commit(): void {
    this.log.commits += 1;
    if (
      this.script.ignoreCommits ||
      (this.script.answerCommits !== undefined &&
        this.log.commits > this.script.answerCommits)
    )
      return;
    if (this.script.commitDelayMs) {
      const audioMs = this.log.audioMs;
      setTimeout(() => this.answer(audioMs), this.script.commitDelayMs);
      return;
    }
    this.answer(this.log.audioMs);
  }

  /** Emits every scripted word that ends within the audio heard by the commit. */
  private answer(audioMs: number): void {
    if (this.ended) return;
    const due = this.script.words
      .map((word, index) => ({ word, index }))
      .filter(
        ({ word, index }) =>
          !this.emitted.has(index) && word.end * 1000 <= audioMs + 1e-6,
      );
    due.forEach(({ index }) => this.emitted.add(index));
    const words = due.flatMap(({ word }, i) => [
      ...(i > 0
        ? [{ text: " ", start: word.start, end: word.start, type: "spacing" }]
        : []),
      {
        text: word.text,
        start: word.start,
        end: word.end,
        type: "word",
        logprob: -0.05,
      },
    ]);
    const text = due.map(({ word }) => word.text).join(" ");
    this.log.emitted.push(...due.map(({ word }) => word.text));
    this.send(JSON.stringify({ message_type: "partial_transcript", text }));
    this.send(
      JSON.stringify({
        message_type: "committed_transcript_with_timestamps",
        text,
        language_code: "en",
        words,
      }),
    );
  }
}

/** Deterministic forced-alignment timings for whatever text is submitted. */
export interface SimulatedAlignment {
  /** "words" binds words to characters; "characters" omits words, as a
   * character-only provider response does; "unbound" returns words that do
   * not cover their characters, so the parser must fall back. */
  mode: "words" | "characters" | "unbound";
  startMs: number;
  charMs: number;
  spaceMs: number;
  lineGapMs: number;
}
export const DEFAULT_ALIGNMENT: SimulatedAlignment = {
  mode: "words",
  startMs: 2000,
  charMs: 55,
  spaceMs: 45,
  lineGapMs: 700,
};
export interface SimulatedAlignmentLog {
  requests: number;
  textSha256: string[];
  fileBytes: number[];
}
/** Character timings in provider seconds, then words as maximal non-space runs. */
export function simulatedAlignment(text: string, script: SimulatedAlignment) {
  const characters: { text: string; start: number; end: number }[] = [];
  let t = script.startMs;
  for (const character of Array.from(text)) {
    const duration =
      character === "\n" || character === "\r"
        ? script.lineGapMs
        : /\s/u.test(character)
          ? script.spaceMs
          : script.charMs;
    characters.push({
      text: character,
      start: t / 1000,
      end: (t + duration) / 1000,
    });
    t += duration;
  }
  type Word = { text: string; start: number; end: number; loss: number };
  const words: Word[] = [];
  let current: Word | null = null;
  for (const c of characters) {
    if (/\s/u.test(c.text)) {
      if (current !== null) words.push(current);
      current = null;
    } else if (current === null)
      current = { text: c.text, start: c.start, end: c.end, loss: 0.1 };
    else {
      current.text += c.text;
      current.end = c.end;
    }
  }
  if (current !== null) words.push(current);
  return {
    characters,
    words:
      script.mode === "characters"
        ? []
        : script.mode === "unbound"
          ? words.map((w) => ({ ...w, end: w.start }))
          : words,
    loss: 0.1,
  };
}

interface SimulatorEnv {
  SIM_API_KEY: string;
  SIM_STREAMS: string;
  SIM_ALIGNMENT?: string;
  RPC_ORIGIN?: string;
}
const tokens = new Set<string>();
const streams: SimulatedScribeStream[] = [];
const alignment: SimulatedAlignmentLog = {
  requests: 0,
  textSha256: [],
  fileBytes: [],
};
let minted = 0;
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export default {
  async fetch(request: Request, env: SimulatorEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__simulator/log")
      return Response.json({
        minted,
        streams: streams.map((s) => s.log),
        alignment,
      });
    if (url.hostname !== "api.elevenlabs.io") {
      // The operator's other outbound traffic is the loopback chain RPC only.
      if (!env.RPC_ORIGIN || url.origin !== env.RPC_ORIGIN)
        return new Response("external_network_disabled", { status: 403 });
      const response = await fetch(request.url, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (
      url.pathname === "/v1/single-use-token/realtime_scribe" &&
      request.method === "POST"
    ) {
      if (request.headers.get("xi-api-key") !== env.SIM_API_KEY)
        return Response.json({ detail: "invalid_api_key" }, { status: 401 });
      const token = `simulated-${++minted}`;
      tokens.add(token);
      return Response.json({ token });
    }
    if (url.pathname === "/v1/forced-alignment" && request.method === "POST") {
      if (request.headers.get("xi-api-key") !== env.SIM_API_KEY)
        return Response.json({ detail: "invalid_api_key" }, { status: 401 });
      const form = await request.formData(),
        file = form.get("file"),
        text = form.get("text");
      if (!(file instanceof File) || typeof text !== "string")
        return Response.json({ detail: "invalid_request" }, { status: 422 });
      alignment.requests++;
      alignment.fileBytes.push(file.size);
      alignment.textSha256.push(
        hex(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
      );
      const script = env.SIM_ALIGNMENT
        ? (JSON.parse(env.SIM_ALIGNMENT) as SimulatedAlignment)
        : DEFAULT_ALIGNMENT;
      return Response.json(simulatedAlignment(text, script), {
        headers: { "x-request-id": `alignment-${alignment.requests}` },
      });
    }
    if (url.pathname === "/v1/speech-to-text/realtime") {
      const token = url.searchParams.get("token") ?? "";
      if (
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
        !tokens.delete(token)
      )
        return new Response("unauthorized", { status: 401 });
      const scripts = JSON.parse(env.SIM_STREAMS) as SimulatedStream[];
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      const stream = new SimulatedScribeStream(
        scripts[streams.length] ?? { words: [] },
        Object.fromEntries(url.searchParams),
        (text) => server.send(text),
        () => server.close(1011, "simulated_drop"),
      );
      streams.push(stream);
      server.addEventListener("message", (event) =>
        stream.receive(String(event.data)),
      );
      server.send(
        JSON.stringify({
          message_type: "session_started",
          session_id: `stream-${streams.length}`,
        }),
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not_found", { status: 404 });
  },
};
