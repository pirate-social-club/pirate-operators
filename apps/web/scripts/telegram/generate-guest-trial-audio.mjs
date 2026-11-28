// Regenerate the local Telegram guest-trial speech fixtures with ffmpeg/flite.
// The output is synthetic fixture speech, not a provider response or a human recording.
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "src/telegram/guest-trial-audio");
const contract = path.join(root, "src/telegram/guest-trial-contract.ts");
const tempDir = mkdtempSync(path.join(tmpdir(), "telegram-guest-trial-audio-"));
const bundle = path.join(tempDir, "contract.mjs");
const textFile = path.join(tempDir, "speech.txt");

buildSync({
  entryPoints: [contract],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { telegramTrialSongs } = await import(pathToFileURL(bundle).href);

mkdirSync(outDir, { recursive: true });

function speak(text, voice, output) {
  writeFileSync(textFile, text);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `flite=textfile=${textFile}:voice=${voice}`,
    "-ar", "16000", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "7",
    output,
  ]);
}

const manifest = { generator: "ffmpeg flite", voices: {}, files: [] };
function writeClip(name, text, voice) {
  const file = `${name}.mp3`;
  const output = path.join(outDir, file);
  speak(text, voice, output);
  manifest.files.push({ file, text, voice });
}

for (const song of telegramTrialSongs) {
  song.lines.forEach((line, index) => {
    writeClip(`reference-${song.id}-${index}`, line.text, "slt");
    writeClip(`correct-${song.id}-${index}`, line.text, "rms");
  });
  writeClip(`song-${song.id}`, song.lines.map((line) => line.text).join(". ... "), "slt");
}
writeClip("voice-mismatch", "And the night is slow.", "awb");
writeClip("voice-unintelligible", "mm hm mm mm.", "kal");
manifest.voices = {
  reference: "slt",
  correctFixture: "rms",
  mismatchFixture: "awb",
  unintelligibleFixture: "kal",
  song: "slt",
};
writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
rmSync(tempDir, { recursive: true, force: true });
console.log(`generated ${manifest.files.length} Telegram guest-trial audio fixtures`);
