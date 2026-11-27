import {
  TELEGRAM_TRIAL_USER_ID,
  telegramSpeechSubmissions,
  type TelegramGradeInput,
  type TelegramGradeResult,
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

function silentWavDataUri(durationSeconds = 0.25, sampleRate = 8000) {
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
  let binary = "";
  const chunk = 1024;
  for (let offset = 0; offset < bytes.length; offset += chunk)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let mediaUrl: string | undefined;
export function telegramTrialPreviewMediaUrl() {
  mediaUrl ??= silentWavDataUri();
  return mediaUrl;
}

export function createTelegramGuestTrialPreviewBoundary(
  overrides: Partial<TelegramTrialBoundary> = {},
): TelegramTrialBoundary {
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
    mediaUrl: () => telegramTrialPreviewMediaUrl(),
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
    confirmLink: async (input) => {
      if (input.telegramUserId !== TELEGRAM_TRIAL_USER_ID)
        throw new Error("The originating Telegram user could not be verified.");
      return { linked: true };
    },
  };
  return { ...base, ...overrides };
}
