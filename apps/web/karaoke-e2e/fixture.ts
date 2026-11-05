// Timed fixture shaped like the protocol karaoke manifest lines. Word texts
// omit punctuation, as provider alignment does; the display maps them back
// onto the canonical line text.
import type { ManifestLine } from "../../../packages/protocol/payments.ts";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const line = (
  ordinal: number,
  text: string,
  words: [string, number, number][],
): ManifestLine => ({
  lineId: id(ordinal),
  lineVersion: 1,
  ordinal,
  text,
  startMs: words[0][1],
  endMs: words.at(-1)![2],
  words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs })),
});

export const KARAOKE_FIXTURE_DURATION_MS = 8500;
export const karaokeFixtureLines: ManifestLine[] = [
  line(1, "Hello, world!", [
    ["Hello", 500, 1200],
    ["world", 1300, 2400],
  ]),
  line(2, "Don't stop now", [
    ["Don't", 3000, 3600],
    ["stop", 3700, 4200],
    ["now", 4300, 4900],
  ]),
  line(3, "Sing it back", [
    ["Sing", 5500, 6100],
    ["it", 6200, 6600],
    ["back", 6700, 7400],
  ]),
];

/** A quiet 16-bit mono tone, long enough to cover every fixture line. */
export function fixtureInstrumentalWav(
  durationMs = KARAOKE_FIXTURE_DURATION_MS,
) {
  const rate = 8000,
    samples = Math.round((rate * durationMs) / 1000),
    data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 800),
      i * 2,
    );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
