// Acceptance-only observations. Original reconnect and no-replay assertions stay
// unchanged. No PCM bytes, credentials or provider tokens enter this artifact.
import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";

export async function captureClockDiagnostics(page: Page) {
  await page.addInitScript(() => {
    const rows: unknown[] = [];
    let captureContext: BaseAudioContext | null = null;
    const target = globalThis as typeof globalThis & {
      __karaokeClockDiagnostics?: unknown[];
    };
    target.__karaokeClockDiagnostics = rows;
    const stamp = () => ({
      wallMs: performance.now(),
      contextMs: captureContext ? captureContext.currentTime * 1000 : null,
      songMs: document.querySelector("audio")?.currentTime! * 1000,
      playbackRate: document.querySelector("audio")?.playbackRate,
    });
    const Worklet = globalThis.AudioWorkletNode;
    globalThis.AudioWorkletNode = class extends Worklet {
      constructor(...args: ConstructorParameters<typeof Worklet>) {
        super(...args);
        captureContext = args[0];
        rows.push({
          kind: "context",
          rate: captureContext.sampleRate,
          ...stamp(),
        });
        this.port.addEventListener("message", (event) => {
          const m = event.data;
          rows.push({
            kind: "worklet",
            ...stamp(),
            type: m.type,
            epoch: m.epoch,
            capturedAtMs: m.capturedAtMs,
            bytes: m.pcm16?.byteLength,
            accounting: m.accounting,
          });
        });
        this.port.start();
        const post = this.port.postMessage.bind(this.port);
        this.port.postMessage = ((message: unknown, ...rest: unknown[]) => {
          rows.push({ kind: "worklet-command", ...stamp(), message });
          return (post as (...args: unknown[]) => void)(message, ...rest);
        }) as typeof this.port.postMessage;
      }
    };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (data instanceof ArrayBuffer && data.byteLength >= 28) {
        const view = new DataView(data);
        rows.push({
          kind: "frame",
          ...stamp(),
          sequence: view.getUint32(8),
          chunkId: view.getUint32(12),
          songStartMs: view.getUint32(20),
          songEndMs: view.getUint32(24),
          pcmMs: (data.byteLength - 28) / 32,
        });
      } else if (typeof data === "string") {
        let type: unknown;
        try {
          type = JSON.parse(data).type;
        } catch {
          /* observation only */
        }
        rows.push({ kind: "control", ...stamp(), type });
      }
      return send.call(this, data);
    };
    document.addEventListener("DOMContentLoaded", () => {
      for (const event of [
        "playing",
        "pause",
        "waiting",
        "stalled",
        "ratechange",
        "ended",
      ])
        document.addEventListener(
          event,
          (e) => {
            if (e.target instanceof HTMLAudioElement)
              rows.push({ kind: "media-event", event, ...stamp() });
          },
          true,
        );
    });
  });
}

export async function retainCaptureClockDiagnostics(
  page: Page,
  info: TestInfo,
) {
  // A crash still leaves the original test failure; diagnostic loss is explicit.
  const observations = await page
    .evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __karaokeClockDiagnostics?: unknown[];
          }
        ).__karaokeClockDiagnostics,
    )
    .catch((error: unknown) => ({ unavailable: String(error) }));
  const operator = await page.request
    .get("/__fixture/operator")
    .then(async (response) => ({
      status: response.status(),
      body: await response.json(),
    }))
    .catch((error: unknown) => ({ unavailable: String(error) }));
  const path = info.outputPath("capture-clock.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        schema: "pirate.karaoke-clock-diagnostic/1",
        test: info.title,
        observations,
        operator,
      },
      null,
      2,
    ),
  );
  await info.attach("capture-clock", { path, contentType: "application/json" });
}
