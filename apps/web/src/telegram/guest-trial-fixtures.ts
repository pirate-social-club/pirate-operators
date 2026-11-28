// FIXTURE HELPERS. These admitted Storybook seams simulate speech grading,
// local media, reward reads and account confirmation. They never call Telegram,
// a microphone, a wallet or a network service, and their accounts are invented.
import {
  TELEGRAM_TRIAL_USER_ID,
  type TelegramGradeInput,
  type TelegramGradeResult,
  type TelegramRewardRead,
  type TelegramTrialAccount,
  type TelegramTrialBoundary,
} from "./guest-trial-contract.ts";
import { createTelegramGuestTrialPreviewBoundary, createTelegramTrialLinkMemory } from "./guest-trial-boundary.ts";

export type TelegramTrialRewardMode = "empty" | "failed" | "testnet-unavailable";

export const telegramFixtureInitialAccount: TelegramTrialAccount = {
  address: "0x7a410000000000000000000000000000000000c892",
  shortAddress: "0x7a41…c892",
};

export const telegramFixtureReplacementAccount: TelegramTrialAccount = {
  address: "0x9f03000000000000000000000000000000000077ad",
  shortAddress: "0x9f03…77ad",
};

export function createTelegramGuestTrialFixture(options: {
  rewardMode?: TelegramTrialRewardMode;
  account?: "signed-out" | "signed-in";
  failFirstConfirmation?: boolean;
  gradeAttempt?: (input: TelegramGradeInput) => Promise<TelegramGradeResult>;
} = {}) {
  const rewardReads: string[] = [];
  const signIns: Array<"initial" | "replacement"> = [];
  const gradingInputs: TelegramGradeInput[] = [];
  let confirmationAttempts = 0;
  const base = createTelegramGuestTrialPreviewBoundary();
  const linkMemory = createTelegramTrialLinkMemory();
  const rewardMode = options.rewardMode ?? "empty";
  const reward: TelegramRewardRead =
    rewardMode === "failed"
      ? { kind: "failed" }
      : rewardMode === "testnet-unavailable"
        ? { kind: "testnet-linking-unavailable" }
        : { kind: "empty" };
  const boundary: TelegramTrialBoundary = {
    ...base,
    gradeAttempt: async (input) => {
      gradingInputs.push(input);
      return options.gradeAttempt
        ? options.gradeAttempt(input)
        : base.gradeAttempt(input);
    },
    rewardRead: async (song) => {
      rewardReads.push(song.id);
      return reward;
    },
    initialAccount: () =>
      options.account === "signed-in" ? telegramFixtureInitialAccount : null,
    signIn: async (kind) => {
      signIns.push(kind);
      return kind === "replacement"
        ? telegramFixtureReplacementAccount
        : telegramFixtureInitialAccount;
    },
    confirmLink: async (input) => {
      confirmationAttempts += 1;
      if (options.failFirstConfirmation && confirmationAttempts === 1)
        throw new Error("The simulated server could not verify this confirmation.");
      return linkMemory.confirmLink(input);
    },
  };
  return {
    boundary,
    rewardReads,
    signIns,
    links: linkMemory.links,
    gradingInputs,
    confirmationAttempts: () => confirmationAttempts,
  };
}
