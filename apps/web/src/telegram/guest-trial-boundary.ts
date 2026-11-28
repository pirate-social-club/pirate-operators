import {
  TELEGRAM_TRIAL_USER_ID,
  telegramSpeechSubmissions,
  type TelegramGradeInput,
  type TelegramGradeResult,
  type TelegramLinkInput,
  type TelegramSpeechKind,
  type TelegramTrialBoundary,
} from "./guest-trial-contract.ts";

const audioUrls = import.meta.glob("./guest-trial-audio/*.mp3", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function audioFixture(name: string) {
  const url = audioUrls[`./guest-trial-audio/${name}.mp3`];
  if (!url) throw new Error(`Missing Telegram trial audio fixture ${name}.`);
  return url;
}

export function telegramTrialPreviewMediaUrl(
  kind: "line" | "voice" | "song" = "line",
  songId = "midnight-waves",
  lineIndex?: number,
  speechKind?: TelegramSpeechKind,
) {
  if (kind === "line") {
    if (lineIndex === undefined) throw new Error("A reference clip requires a line index.");
    return audioFixture(`reference-${songId}-${lineIndex}`);
  }
  if (kind === "song") return audioFixture(`song-${songId}`);
  if (speechKind === "mismatch") return audioFixture("voice-mismatch");
  if (speechKind === "unintelligible") return audioFixture("voice-unintelligible");
  if (lineIndex === undefined) throw new Error("A correct fixture recording requires a line index.");
  return audioFixture(`correct-${songId}-${lineIndex}`);
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
    mediaUrl: (kind, songId, lineIndex, speechKind) =>
      telegramTrialPreviewMediaUrl(kind, songId, lineIndex, speechKind),
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
