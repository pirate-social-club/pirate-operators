import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { TelegramGradeResult } from "./guest-trial-contract.ts";
import { createTelegramGuestTrialFixture } from "./guest-trial-fixtures.ts";
import { TelegramGuestTrialRoute } from "./guest-trial-route.tsx";

const meta = {
  title: "Telegram/Flows/Guest trial",
  tags: ["flow"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Interactive Telegram guest-trial preview on the app-owned route component. Speech, media, reward and account responses are admitted fixture seams; no Telegram delivery, microphone, wallet or network service runs.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
type Canvas = ReturnType<typeof within>;

function currentPrompt(canvasElement: HTMLElement) {
  const prompts = [
    ...canvasElement.querySelectorAll<HTMLElement>("[data-telegram-line-prompt]"),
  ];
  return prompts.at(-1);
}

function promptState(canvasElement: HTMLElement) {
  const prompt = currentPrompt(canvasElement);
  return {
    lineIndex: prompt?.getAttribute("data-line-index"),
    takeCount: prompt?.getAttribute("data-take-count"),
    line: prompt?.getAttribute("data-line-text"),
  };
}

function referenceAudioSrc(canvasElement: HTMLElement) {
  return currentPrompt(canvasElement)
    ?.querySelector("[data-reference-audio] audio")
    ?.getAttribute("src");
}

async function chooseMidnightWaves(canvas: Canvas) {
  await userEvent.click(
    await canvas.findByRole("button", { name: "Midnight Waves" }),
  );
  await canvas.findByText("I saw the harbor light");
}

async function submitFixtureRecording(
  canvas: Canvas,
  label: RegExp,
) {
  await userEvent.click(
    await canvas.findByRole("button", { name: "Record line" }),
  );
  await userEvent.click(
    await canvas.findByRole("button", { name: label }),
  );
}

async function finishMidnightLesson(canvas: Canvas, canvasElement: HTMLElement, alreadyStarted = false) {
  if (!alreadyStarted) await chooseMidnightWaves(canvas);
  for (let index = 0; index < 6; index += 1) {
    const previousAudio = referenceAudioSrc(canvasElement);
    await submitFixtureRecording(canvas, /correct fixture recording/);
    if (index < 5) {
      await waitFor(() =>
        expect(currentPrompt(canvasElement)?.getAttribute("data-line-index")).toBe(
          String(index + 1),
        ),
      );
      const nextAudio = referenceAudioSrc(canvasElement);
      expect(nextAudio).toBeTruthy();
      expect(nextAudio).not.toBe(previousAudio);
    }
  }
  await waitFor(() =>
    expect(canvas.getAllByText(/Great work\. 83%/)).not.toHaveLength(0),
  );
}

function renderFixture(options: Parameters<typeof createTelegramGuestTrialFixture>[0] = {}, linkingAvailable = true) {
  const fixture = createTelegramGuestTrialFixture(options);
  return (
    <TelegramGuestTrialRoute
      boundary={fixture.boundary}
      linkingAvailable={linkingAvailable}
    />
  );
}

export const PlayableLessonAndAccountConnection: Story = {
  render: () => renderFixture(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Choose a song. Listen to a line, then say it back in English."),
    ).toBeInTheDocument();
    expect(
      (await canvas.findByRole("group", { name: "Songs" })).getBoundingClientRect().height,
    ).toBeGreaterThan(200);

    await userEvent.click(await canvas.findByRole("button", { name: "Next (3)" }));
    await expect(
      await canvas.findByRole("button", { name: "Silver Rain" }),
    ).toBeInTheDocument();
    await userEvent.click(await canvas.findByRole("button", { name: "Back" }));
    await expect(
      await canvas.findByRole("button", { name: "Paper Boats" }),
    ).toBeInTheDocument();

    await finishMidnightLesson(canvas, canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Connect account" }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Sign in" }));
    await expect(await canvas.findByText("0x7a41…c892")).toBeInTheDocument();
    await expect(
      canvas.getByText(
        "Future lessons will use this account. This lesson stays in your guest history.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      await canvas.findByRole("button", { name: "Connect account" }),
    );
    await expect(await canvas.findByText("Account connected")).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Choose another song" }),
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "Midnight Waves" }),
    );
    await waitFor(() =>
      expect(promptState(canvasElement)).toEqual({
        lineIndex: "0",
        takeCount: "0",
        line: "I saw the harbor light",
      }),
    );
    await expect(canvas.getByRole("button", { name: "Record line" })).toBeEnabled();

    await finishMidnightLesson(canvas, canvasElement, true);
    const results = [...canvasElement.querySelectorAll("[data-telegram-result]")];
    expect(results).toHaveLength(2);
    expect(results.at(-1)).toHaveTextContent("Great work. 83%");
    expect(results.at(-1)).toHaveTextContent("Choose another song");
    expect(results.at(-1)).not.toHaveTextContent("Connect account");
  },
};

export const RetryStatesPreservePositionAndTakes: Story = {
  render: () => renderFixture(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    await submitFixtureRecording(canvas, /correct fixture recording/);
    await waitFor(() =>
      expect(promptState(canvasElement)).toEqual({
        lineIndex: "1",
        takeCount: "1",
        line: "And the light is low",
      }),
    );

    await submitFixtureRecording(canvas, /mismatch fixture recording/);
    await expect(await canvas.findByText("Incorrect. Try again.")).toBeInTheDocument();
    await expect(canvas.getByText("You said “And the night is slow.”")).toBeInTheDocument();
    expect(canvas.getAllByText("And the light is low").length).toBeGreaterThan(0);
    expect(canvasElement.querySelector("[data-reference-audio] audio")).toBeInTheDocument();
    expect(promptState(canvasElement)).toEqual({
      lineIndex: "1",
      takeCount: "1",
      line: "And the light is low",
    });

    const promptCountBeforeUnintelligible = canvasElement.querySelectorAll(
      "[data-telegram-line-prompt]",
    ).length;
    await submitFixtureRecording(canvas, /unintelligible fixture recording/);
    await expect(
      await canvas.findByText("Please record that line again."),
    ).toBeInTheDocument();
    expect(promptState(canvasElement)).toEqual({
      lineIndex: "1",
      takeCount: "1",
      line: "And the light is low",
    });
    expect(canvasElement.querySelectorAll("[data-telegram-line-prompt]")).toHaveLength(
      promptCountBeforeUnintelligible,
    );
  },
};

export const GradingServiceFailurePreservesSubmission: Story = {
  render: () => {
    let attempts = 0;
    return renderFixture({
      gradeAttempt: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated grading outage");
        void input;
        return { outcome: "correct" };
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    await submitFixtureRecording(canvas, /correct fixture recording/);
    await expect(
      await canvas.findByText("The grading service is unavailable. Try again."),
    ).toBeInTheDocument();
    expect(promptState(canvasElement)).toEqual({
      lineIndex: "0",
      takeCount: "0",
      line: "I saw the harbor light",
    });
    expect(canvasElement.querySelectorAll("[data-telegram-line-prompt]")).toHaveLength(1);
    expect(canvasElement.querySelector("[data-telegram-voice]")).toBeInTheDocument();
    await submitFixtureRecording(canvas, /correct fixture recording/);
    await waitFor(() =>
      expect(promptState(canvasElement)).toEqual({
        lineIndex: "1",
        takeCount: "1",
        line: "And the light is low",
      }),
    );
  },
};

export const ReturningGuestUnfinishedFirst: Story = {
  render: () => {
    const fixture = createTelegramGuestTrialFixture();
    return (
      <TelegramGuestTrialRoute
        boundary={fixture.boundary}
        initialLessons={[{ songId: "silver-rain", lineIndex: 2, takes: 2 }]}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = await canvas.findByRole("group", { name: "Songs" });
    const firstButton = picker.querySelector("button");
    expect(firstButton).toHaveTextContent("Silver Rain · Resume");
    await userEvent.click(
      await canvas.findByRole("button", { name: "Silver Rain · Resume" }),
    );
    await waitFor(() =>
      expect(promptState(canvasElement)).toEqual({
        lineIndex: "2",
        takeCount: "2",
        line: "The roof repeats the rhythm",
      }),
    );
  },
};

export const SongMenuPreservesLessonAndResolvesContext: Story = {
  render: () => renderFixture(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    await expect(
      await canvas.findByRole("group", { name: "Songs" }),
    ).toBeInTheDocument();

    await chooseMidnightWaves(canvas);
    const before = promptState(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    const details = await canvas.findByRole("article", { name: "Full song and details" });
    await waitFor(() =>
      expect(details.getAttribute("data-reward-state")).toBe("empty"),
    );
    expect(details).toHaveTextContent("Midnight Waves");
    expect(details.querySelector("audio")).toBeInTheDocument();
    expect(details).not.toHaveTextContent(/reward/i);
    expect(details).not.toHaveTextContent("Reward information is unavailable.");
    expect(promptState(canvasElement)).toEqual(before);
  },
};

export const SongMenuSeveralOpenLessons: Story = {
  render: () => {
    const fixture = createTelegramGuestTrialFixture();
    return (
      <TelegramGuestTrialRoute
        boundary={fixture.boundary}
        initialLessons={[
          { songId: "silver-rain", lineIndex: 2, takes: 2 },
          { songId: "red-horizon", lineIndex: 1, takes: 1 },
        ]}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    await expect(await canvas.findByText("Which song?")).toBeInTheDocument();
    await userEvent.click(await canvas.findByRole("button", { name: "Red Horizon" }));
    const details = await canvas.findByRole("article", { name: "Full song and details" });
    expect(details).toHaveTextContent("Red Horizon");
  },
};

export const SongMenuOneOpenLessonWithoutSelection: Story = {
  render: () => {
    const fixture = createTelegramGuestTrialFixture();
    return (
      <TelegramGuestTrialRoute
        boundary={fixture.boundary}
        initialLessons={[{ songId: "silver-rain", lineIndex: 2, takes: 2 }]}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    const details = await canvas.findByRole("article", { name: "Full song and details" });
    expect(details).toHaveTextContent("Silver Rain");
  },
};

export const SongMenuJustFinishedUsesResultContext: Story = {
  render: () => renderFixture(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await finishMidnightLesson(canvas, canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    const details = await canvas.findByRole("article", { name: "Full song and details" });
    expect(details).toHaveTextContent("Midnight Waves");
  },
};

export const ArabicLanguagePreservesPromptAndAudio: Story = {
  render: () => renderFixture(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    const before = promptState(canvasElement);
    const beforeAudio = currentPrompt(canvasElement)
      ?.querySelector("[data-reference-audio] audio")
      ?.getAttribute("src");
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/language\s+Language/ }),
    );
    expect(
      (await canvas.findByText("Language for instructions")).closest("section")
        ?.getBoundingClientRect().height,
    ).toBeGreaterThan(150);
    await userEvent.click(await canvas.findByRole("button", { name: "العربية" }));
    await expect(await canvas.findByText("تم اختيار العربية.")).toBeInTheDocument();
    await expect(
      await canvas.findByText("استمع ثم كرّر بالإنجليزية."),
    ).toBeInTheDocument();
    expect(promptState(canvasElement)).toEqual(before);
    const prompt = currentPrompt(canvasElement);
    expect(prompt?.getAttribute("dir")).toBe("rtl");
    expect(
      prompt?.querySelector("[data-reference-audio] audio")?.getAttribute("src"),
    ).toBe(beforeAudio);
  },
};


export const ConversationControlsRemainReachable: Story = {
  render: () => renderFixture(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    await submitFixtureRecording(canvas, /mismatch fixture recording/);
    await expect(await canvas.findByText("Incorrect. Try again.")).toBeInTheDocument();
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/language\s+Language/ }),
    );
    expect(
      (await canvas.findByText("Language for instructions")).closest("section")
        ?.getBoundingClientRect().height,
    ).toBeGreaterThan(150);
    await userEvent.click(
      await canvas.findByRole("button", { name: /Pinned message\s+Songs/ }),
    );
    expect(
      (await canvas.findByRole("group", { name: "Songs" })).getBoundingClientRect().height,
    ).toBeGreaterThan(200);
    await userEvent.click(await canvas.findByRole("button", { name: "Next (3)" }));
    await expect(
      await canvas.findByRole("button", { name: "Silver Rain" }),
    ).toBeInTheDocument();
  },
};

let resolvePendingGrade: ((result: TelegramGradeResult) => void) | undefined;

function PendingGradingRoute() {
  const fixture = createTelegramGuestTrialFixture({
    gradeAttempt: () =>
      new Promise<TelegramGradeResult>((resolve) => {
        resolvePendingGrade = resolve;
      }),
  });
  return <TelegramGuestTrialRoute boundary={fixture.boundary} />;
}

export const ArabicLanguageDuringPendingGrading: Story = {
  render: () => <PendingGradingRoute />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    await submitFixtureRecording(canvas, /correct fixture recording/);
    await expect(await canvas.findByText("Checking your last answer")).toBeInTheDocument();
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/language\s+Language/ }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "العربية" }));
    await expect(
      await canvas.findByText("جارٍ التحقق من إجابتك الأخيرة"),
    ).toBeInTheDocument();
    expect(canvasElement.querySelector("[data-telegram-voice]")).toBeInTheDocument();
    resolvePendingGrade?.({ outcome: "correct" });
    await expect(await canvas.findByText(/Correct/)).toBeInTheDocument();
    expect(canvasElement.querySelector("[data-telegram-voice]")).toBeInTheDocument();
  },
};

let resolveSwitchedGrade: ((result: TelegramGradeResult) => void) | undefined;
let switchedGradeInputs: Array<{ songId: string }> = [];

export const PendingGradeStaysWithOriginatingLesson: Story = {
  render: () => {
    switchedGradeInputs = [];
    const fixture = createTelegramGuestTrialFixture({
      gradeAttempt: (input) => {
        switchedGradeInputs.push({ songId: input.songId });
        if (switchedGradeInputs.length > 1) return Promise.resolve({ outcome: "correct" });
        return new Promise<TelegramGradeResult>((resolve) => {
          resolveSwitchedGrade = resolve;
        });
      },
    });
    return <TelegramGuestTrialRoute boundary={fixture.boundary} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    await submitFixtureRecording(canvas, /correct fixture recording/);
    await expect(await canvas.findByText("Checking your last answer")).toBeInTheDocument();

    await userEvent.click(
      await canvas.findByRole("button", { name: /Pinned message\s+Songs/ }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Harbor Lights" }));
    await canvas.findByText("The harbor lights are waking");

    resolveSwitchedGrade?.({ outcome: "correct" });
    await expect(await canvas.findByText(/Correct/)).toBeInTheDocument();
    expect(promptState(canvasElement)).toEqual({
      lineIndex: "0",
      takeCount: "0",
      line: "The harbor lights are waking",
    });

    await submitFixtureRecording(canvas, /correct fixture recording/);
    await waitFor(() =>
      expect(promptState(canvasElement)).toEqual({
        lineIndex: "1",
        takeCount: "1",
        line: "The tide is turning slow",
      }),
    );
    expect(switchedGradeInputs.map((input) => input.songId)).toEqual([
      "midnight-waves",
      "harbor-lights",
    ]);

    await userEvent.click(
      await canvas.findByRole("button", { name: /Pinned message\s+Songs/ }),
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "Midnight Waves · Resume" }),
    );
    await waitFor(() =>
      expect(promptState(canvasElement)).toEqual({
        lineIndex: "1",
        takeCount: "1",
        line: "And the light is low",
      }),
    );
  },
};

let resolveFinalGrade: ((result: TelegramGradeResult) => void) | undefined;

export const PendingFinalGradePreservesSongContext: Story = {
  render: () => {
    const fixture = createTelegramGuestTrialFixture({
      gradeAttempt: () =>
        new Promise<TelegramGradeResult>((resolve) => {
          resolveFinalGrade = resolve;
        }),
    });
    return (
      <TelegramGuestTrialRoute
        boundary={fixture.boundary}
        initialLessons={[{ songId: "midnight-waves", lineIndex: 5, takes: 5 }]}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Midnight Waves · Resume" }),
    );
    await canvas.findByText("Midnight carries us home");
    await submitFixtureRecording(canvas, /correct fixture recording/);
    await expect(await canvas.findByText("Checking your last answer")).toBeInTheDocument();

    await userEvent.click(
      await canvas.findByRole("button", { name: /Pinned message\s+Songs/ }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Harbor Lights" }));
    await canvas.findByText("The harbor lights are waking");

    resolveFinalGrade?.({ outcome: "correct" });
    await expect(await canvas.findByText(/Great work\. 83%/)).toBeInTheDocument();
    expect(promptState(canvasElement)).toEqual({
      lineIndex: "0",
      takeCount: "0",
      line: "The harbor lights are waking",
    });

    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    const details = await canvas.findByRole("article", { name: "Full song and details" });
    expect(details).toHaveTextContent("Harbor Lights");
    expect(details).not.toHaveTextContent("Midnight Waves");
  },
};

export const PinnedSongsRemainAfterCompletion: Story = {
  render: () => renderFixture(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await finishMidnightLesson(canvas, canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Connect account" }),
    ).toBeInTheDocument();
    const pinned = await canvas.findByRole("button", { name: /Pinned message\s+Songs/ });
    expect(pinned).toBeEnabled();
    await userEvent.click(pinned);
    expect(
      (await canvas.findByRole("group", { name: "Songs" })).getBoundingClientRect().height,
    ).toBeGreaterThan(200);
  },
};

export const RewardReadFailed: Story = {
  render: () => renderFixture({ rewardMode: "failed" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    await expect(
      await canvas.findByText("Reward information is unavailable."),
    ).toBeInTheDocument();
  },
};

export const TestnetRewardAndUnavailableLinkingEnding: Story = {
  render: () => renderFixture({ rewardMode: "testnet-unavailable" }, false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await chooseMidnightWaves(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Menu" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /\/song\s+Full song & details/ }),
    );
    await expect(
      await canvas.findByText(
        "Testnet reward. Requires linked Study. Linking is unavailable in this trial.",
      ),
    ).toBeInTheDocument();
    await finishMidnightLesson(canvas, canvasElement, true);
    await expect(canvas.queryByRole("button", { name: "Connect account" })).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Choose another song" }),
    ).toBeEnabled();
  },
};


export const ReplacementAccountConfirmationView: Story = {
  render: () => renderFixture({ account: "signed-in" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await finishMidnightLesson(canvas, canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Connect account" }),
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "Use a different account" }),
    );
    await expect(await canvas.findByText("0x9f03…77ad")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Connect account" }),
    ).toBeEnabled();
  },
};

let replacementFixture: ReturnType<typeof createTelegramGuestTrialFixture>;

export const ReplacementAccountRequiresFreshConfirmation: Story = {
  render: () => {
    replacementFixture = createTelegramGuestTrialFixture({ account: "signed-in" });
    return <TelegramGuestTrialRoute boundary={replacementFixture.boundary} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await finishMidnightLesson(canvas, canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Connect account" }),
    );
    await expect(await canvas.findByText("0x7a41…c892")).toBeInTheDocument();
    await userEvent.click(
      await canvas.findByRole("button", { name: "Use a different account" }),
    );
    await expect(await canvas.findByText("0x9f03…77ad")).toBeInTheDocument();
    await expect(
      canvas.getByText(
        "Future lessons will use this account. This lesson stays in your guest history.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect account" }),
    );
    expect(replacementFixture.links).toHaveLength(1);
    expect(replacementFixture.links[0]?.account.address).toBe(
      "0x9f03000000000000000000000000000000000077ad",
    );
    await expect(await canvas.findByText("Account connected")).toBeInTheDocument();
    expect(replacementFixture.links).toHaveLength(1);

    await userEvent.click(
      canvas.getByRole("button", { name: "Connect account" }),
    );
    expect(canvas.queryByText("nightshift.example/connect")).toBeNull();
    expect(replacementFixture.links).toHaveLength(1);
    expect(replacementFixture.links[0]?.account.address).toBe(
      "0x9f03000000000000000000000000000000000077ad",
    );
    expect(canvas.getAllByText("Account connected")).toHaveLength(1);
  },
};

export const FailedConfirmationThenRetry: Story = {
  render: () => renderFixture({ account: "signed-in", failFirstConfirmation: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await finishMidnightLesson(canvas, canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Connect account" }),
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "Connect account" }),
    );
    await expect(
      await canvas.findByText("The simulated server could not verify this confirmation."),
    ).toBeInTheDocument();
    expect(canvas.queryByText("Account connected")).toBeNull();
    await userEvent.click(await canvas.findByRole("button", { name: "Try again" }));
    await expect(await canvas.findByText("Account connected")).toBeInTheDocument();
  },
};
