// Telegram guest-trial preview contract. The interaction copy and ordering follow
// the Paper Telegram baseline; the preview remains local and fixture-driven.

export const TELEGRAM_TRIAL_USER_ID = "telegram-guest-42";
export const TELEGRAM_TRIAL_COMMUNITY_NAME = "Night Shift";

export interface TelegramTrialLine {
  text: string;
}

export interface TelegramTrialSong {
  id: string;
  title: string;
  artist: string;
  durationLabel: string;
  lines: readonly TelegramTrialLine[];
}

export const telegramTrialSongs: readonly TelegramTrialSong[] = [
  {
    id: "midnight-waves",
    title: "Midnight Waves",
    artist: "Night Shift fixture audio",
    durationLabel: "10:14",
    lines: [
      { text: "I saw the harbor light" },
      { text: "And the light is low" },
      { text: "We drift where the dark waves roll" },
      { text: "The harbor keeps us slow" },
      { text: "Sing until the morning" },
      { text: "Midnight carries us home" },
    ],
  },
  {
    id: "harbor-lights",
    title: "Harbor Lights",
    artist: "Night Shift fixture audio",
    durationLabel: "8:42",
    lines: [
      { text: "The harbor lights are waking" },
      { text: "The tide is turning slow" },
      { text: "We count the distant anchors" },
      { text: "And watch the lanterns glow" },
      { text: "The water answers softly" },
      { text: "As evening starts to go" },
    ],
  },
  {
    id: "paper-boats",
    title: "Paper Boats",
    artist: "Night Shift fixture audio",
    durationLabel: "7:36",
    lines: [
      { text: "Paper boats are sailing" },
      { text: "Across the quiet rain" },
      { text: "They fold around the current" },
      { text: "And find their course again" },
      { text: "A small light keeps them floating" },
      { text: "Until the clouds remain" },
    ],
  },
  {
    id: "silver-rain",
    title: "Silver Rain",
    artist: "Night Shift fixture audio",
    durationLabel: "9:08",
    lines: [
      { text: "Silver rain is falling" },
      { text: "Along the empty pier" },
      { text: "The roof repeats the rhythm" },
      { text: "For anyone to hear" },
      { text: "We hum beneath the awning" },
      { text: "Until the sky is clear" },
    ],
  },
  {
    id: "red-horizon",
    title: "Red Horizon",
    artist: "Night Shift fixture audio",
    durationLabel: "8:19",
    lines: [
      { text: "Red horizon rising" },
      { text: "Beyond the sleeping town" },
      { text: "The rooftops catch the color" },
      { text: "Before the sun is found" },
      { text: "We follow morning eastward" },
      { text: "And never hurry down" },
    ],
  },
  {
    id: "night-ferry",
    title: "Night Ferry",
    artist: "Night Shift fixture audio",
    durationLabel: "9:47",
    lines: [
      { text: "The night ferry is leaving" },
      { text: "Its lights are thin and blue" },
      { text: "The waves repeat the engine" },
      { text: "Across the darkened blue" },
      { text: "We wait beside the railing" },
      { text: "Until the shore is new" },
    ],
  },
];

export function telegramTrialSong(songId: string): TelegramTrialSong {
  const song = telegramTrialSongs.find((candidate) => candidate.id === songId);
  if (!song) throw new Error("The Telegram trial song is unavailable.");
  return song;
}

export type TelegramSpeechKind = "correct" | "mismatch" | "unintelligible";

export interface TelegramSpeechSubmission {
  kind: TelegramSpeechKind;
  label: string;
  transcript: string | null;
  durationLabel: string;
}

export const telegramSpeechSubmissions: readonly TelegramSpeechSubmission[] = [
  {
    kind: "correct",
    label: "Use correct fixture recording",
    transcript: null,
    durationLabel: "0:04",
  },
  {
    kind: "mismatch",
    label: "Use mismatch fixture recording",
    transcript: "And the night is slow.",
    durationLabel: "0:04",
  },
  {
    kind: "unintelligible",
    label: "Use unintelligible fixture recording",
    transcript: null,
    durationLabel: "0:02",
  },
];

export interface TelegramGradeInput {
  telegramUserId: string;
  songId: string;
  lineIndex: number;
  take: number;
  submission: TelegramSpeechSubmission;
}

export type TelegramGradeResult =
  | { outcome: "correct" }
  | { outcome: "mismatch"; transcript: string }
  | { outcome: "unintelligible" };

export type TelegramRewardRead =
  | { kind: "empty" }
  | { kind: "failed" }
  | { kind: "testnet-linking-unavailable" };

export interface TelegramTrialAccount {
  address: string;
  shortAddress: string;
}

export interface TelegramLinkInput {
  telegramUserId: string;
  account: TelegramTrialAccount;
  resultId: string;
  confirmationGeneration: number;
}

export interface TelegramTrialBoundary {
  speechOptions(): readonly TelegramSpeechSubmission[];
  gradeAttempt(input: TelegramGradeInput): Promise<TelegramGradeResult>;
  mediaUrl(
    kind: "line" | "voice" | "song",
    songId: string,
    lineIndex?: number,
    speechKind?: TelegramSpeechKind,
  ): string;
  rewardRead(song: TelegramTrialSong): Promise<TelegramRewardRead>;
  initialAccount(): TelegramTrialAccount | null;
  signIn(kind: "initial" | "replacement"): Promise<TelegramTrialAccount>;
  confirmLink(input: TelegramLinkInput): Promise<{ linked: true }>;
  hasRecordedLink(): boolean;
}

export interface TelegramTrialLessonSeed {
  songId: string;
  lineIndex: number;
  takes: number;
}
