// Coordinator browser harness only. Drives the actual owned composition and
// copied original controller/steps; it does not pretend to be a release service.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { CommunitySongComposer } from "../src/media/community-ui/post-composer.tsx";
import { OWNER_RELEASE_POLICY } from "../src/media/community-contracts.ts";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
export async function runCommunityComposerBrowserCase(root: HTMLElement) {
  let prepareCalls = 0,
    posted = 0,
    finish!: (value: boolean) => void;
  const [consent, setConsent] = createSignal(false),
    [rating, setRating] = createSignal<"general" | "adult" | null>(null);
  const [prepared, setPrepared] = createSignal(false);
  const file = new File(["fixture"], "fixture.mp3", { type: "audio/mpeg" });
  const dispose = render(
    () => (
      <CommunitySongComposer
        mode="song"
        availableCapabilities={["song"]}
        canCreateSongPost
        presentation="inline"
        song={{
          title: "Fixture song",
          primaryAudioUpload: file,
          instrumentalAudioUpload: file,
          vocalAudioUpload: file,
        }}
        release={{
          authorized: () => true,
          policy: () => OWNER_RELEASE_POLICY,
          consent,
          onConsent: setConsent,
          rating,
          onRating: setRating,
          language: () => "en",
          issue: () =>
            !consent() || !rating() ? "Consent and rating required" : "",
        }}
        songFlowRuntime={{
          get prepared() {
            return prepared();
          },
          retained: false,
          locked: false,
          prepare: async () => {
            prepareCalls++;
            return new Promise<boolean>((resolve) => {
              finish = (value) => {
                setPrepared(value);
                resolve(value);
              };
            });
          },
        }}
        submit={{
          label: "Post",
          onSubmit: () => {
            posted++;
          },
        }}
      />
    ),
    root,
  );
  const button = (text: string) =>
    Array.from(root.querySelectorAll("button")).find(
      (value) => value.textContent?.trim() === text,
    );
  try {
    await settle();
    const next = button("Next");
    check(next, "source Song Next absent");
    next.click();
    await settle();
    check(
      root.textContent?.includes("Release policy") &&
        Number(prepareCalls) === 0,
      "uploaded before backend consent",
    );
    const checkbox = root.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    check(checkbox, "actual policy checkbox absent");
    checkbox.click();
    const general = root.querySelector<HTMLInputElement>(
      'input[type="radio"][value="general"]',
    );
    check(general, "actual declared rating producer absent");
    general.click();
    await settle();
    button("Next")!.click();
    button("Next")!.click();
    await settle();
    check(
      Number(prepareCalls) === 1,
      "duplicate preparation escaped original advancing guard",
    );
    finish(false);
    await settle();
    check(
      root.textContent?.includes("Release policy"),
      "failed prepare advanced",
    );
    button("Next")!.click();
    await settle();
    finish(true);
    await settle();
    check(
      root.textContent?.includes("Review") &&
        !root.textContent?.includes("Remix and sell"),
      "backend review claims unsupported licensing",
    );
    const post = button("Post");
    check(post, "source Post action absent");
    post.click();
    check(posted === 1, "actual submit callback not used");
    return {
      cases: [
        "source step composition",
        "consent before prepare",
        "same-call duplicate guard",
        "failed prepare stays",
        "prepared review submits",
      ],
      acceptance: "fixture UI only, no provider or publication",
    };
  } finally {
    dispose();
  }
}
