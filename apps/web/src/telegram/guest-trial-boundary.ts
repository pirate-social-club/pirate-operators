import {
  TELEGRAM_TRIAL_USER_ID,
  telegramSpeechSubmissions,
  type TelegramGradeInput,
  type TelegramGradeResult,
  type TelegramLinkInput,
  type TelegramTrialBoundary,
} from "./guest-trial-contract.ts";

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1)
    bytes[offset + index] = value.charCodeAt(index);
}

function writeUInt32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >>> 8) & 255;
  bytes[offset + 2] = (value >>> 16) & 255;
  bytes[offset + 3] = (value >>> 24) & 255;
}

function writeUInt16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = (value >>> 8) & 255;
}

function toneWavDataUri(key: string, durationSeconds = 0.8, sampleRate = 8000) {
  const sampleCount = Math.floor(durationSeconds * sampleRate);
  const dataLength = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataLength);
  writeAscii(bytes, 0, "RIFF");
  writeUInt32(bytes, 4, 36 + dataLength);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  writeUInt32(bytes, 16, 16);
  writeUInt16(bytes, 20, 1);
  writeUInt16(bytes, 22, 1);
  writeUInt32(bytes, 24, sampleRate);
  writeUInt32(bytes, 28, sampleRate * 2);
  writeUInt16(bytes, 32, 2);
  writeUInt16(bytes, 34, 16);
  writeAscii(bytes, 36, "data");
  writeUInt32(bytes, 40, dataLength);
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const frequency = 220 + (hash % 420);
  const overtone = frequency * 1.5;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const envelope = Math.min(1, time * 30, (durationSeconds - time) * 12);
    const sample = Math.round(
      (Math.sin(2 * Math.PI * frequency * time) * 0.42 +
        Math.sin(2 * Math.PI * overtone * time) * 0.14) *
        envelope * 32767,
    );
    bytes[44 + index * 2] = sample & 255;
    bytes[45 + index * 2] = (sample >> 8) & 255;
  }
  let binary = "";
  const chunk = 1024;
  for (let offset = 0; offset < bytes.length; offset += chunk)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const mediaUrls = new Map<string, string>();
export function telegramTrialPreviewMediaUrl(
  kind: "line" | "voice" | "song" = "line",
  songId = "midnight-waves",
  lineIndex?: number,
) {
  const key = `${kind}:${songId}:${lineIndex ?? "all"}`;
  let url = mediaUrls.get(key);
  if (!url) {
    url = toneWavDataUri(key);
    mediaUrls.set(key, url);
  }
  return url;
}

export function createTelegramTrialLinkMemory() {
  const links: TelegramLinkInput[] = [];
  return {
    links,
    async confirmLink(input: TelegramLinkInput): Promise<{ linked: true }> {
      if (input.telegramUserId !== TELEGRAM_TRIAL_USER_ID)
        throw new Error("The originating Telegram user could not be verified.");
      links.push({ ...input, account: { ...input.account } });
      return { linked: true };
    },
  };
}

export function createTelegramGuestTrialPreviewBoundary(
  overrides: Partial<TelegramTrialBoundary> = {},
): TelegramTrialBoundary {
  const linkMemory = createTelegramTrialLinkMemory();
  const base: TelegramTrialBoundary = {
    speechOptions: () => telegramSpeechSubmissions,
    async gradeAttempt(input: TelegramGradeInput): Promise<TelegramGradeResult> {
      if (input.telegramUserId !== TELEGRAM_TRIAL_USER_ID)
        throw new Error("The Telegram guest could not be verified.");
      if (input.submission.kind === "correct") return { outcome: "correct" };
      if (input.submission.kind === "mismatch")
        return {
          outcome: "mismatch",
          transcript: input.submission.transcript ?? "And the night is slow.",
        };
      return { outcome: "unintelligible" };
    },
    mediaUrl: (kind, songId, lineIndex) => telegramTrialPreviewMediaUrl(kind, songId, lineIndex),
    rewardRead: async () => ({ kind: "empty" }),
    initialAccount: () => null,
    signIn: async (kind) =>
      kind === "replacement"
        ? {
            address: "0x9f03000000000000000000000000000000000077ad",
            shortAddress: "0x9f03…77ad",
          }
        : {
            address: "0x7a410000000000000000000000000000000000c892",
            shortAddress: "0x7a41…c892",
          },
    confirmLink: linkMemory.confirmLink,
  };
  return { ...base, ...overrides };
}
