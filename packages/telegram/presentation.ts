import type { TelegramButton, TelegramNativeMessage } from "./messages.ts";
import type {
  TelegramLessonView,
  TelegramOffers,
  TelegramSong,
} from "./study-contracts.ts";

/** Interaction/copy references: standalone c7cb8783 Studying/Session and
 * YourSongs; revised Paper R1–R7 on 2026-11-10. This is the ordinary-message
 * fallback and a data contract for the separate UI lane, not widget approval. */
export interface TelegramHomeView {
  songs: TelegramSong[];
  drawAt: number | null;
  connected: boolean;
  readAt: number;
}
export interface TelegramPresentationPort {
  home(
    view: TelegramHomeView,
    buttons: TelegramButton[][],
  ): TelegramNativeMessage;
  prompt(view: TelegramLessonView): TelegramNativeMessage;
  verdict(correct: boolean, heard: string): TelegramNativeMessage;
  result(
    view: TelegramLessonView,
    facts: {
      streak: number | null;
      participation: "entered" | "pending" | "none" | "unavailable";
    },
    buttons: TelegramButton[][],
  ): TelegramNativeMessage;
}
const safeText = (value: string, max = 140) =>
  value.replace(/[\x00-\x1f]/g, " ").slice(0, max);
export function publicOfferText(offers: TelegramOffers, now: number) {
  if (offers.state !== "ready" || offers.validUntil <= now)
    return "Reward information is unavailable.";
  if (!offers.offers.length) return "No active reward offer.";
  return offers.offers
    .map((offer) => {
      const state =
        now < offer.opensAt
          ? "Opens"
          : now < offer.cutoffAt
            ? "Open until"
            : "Closed";
      return `${safeText(offer.id, 80)} · ${offer.mode}\n${state} ${new Date(now < offer.opensAt ? offer.opensAt : offer.cutoffAt).toISOString()}\n${offer.tickets} lottery ticket${offer.tickets === 1 ? "" : "s"} · ${offer.activities.join(", ")}\n${safeText(offer.rules, 600)}`;
    })
    .join("\n\n");
}
export const nativeTelegramPresentation: TelegramPresentationPort = {
  home(view, buttons) {
    const yours = view.songs.filter(
        (song) => song.streak !== null && song.streak > 0,
      ),
      more = view.songs.filter((song) => !yours.includes(song));
    const row = (song: TelegramSong) => {
      const offer = song.offers,
        tickets =
          offer.state === "ready" && offer.validUntil > view.readAt
            ? offer.offers
                .filter(
                  (o) => o.opensAt <= view.readAt && view.readAt < o.cutoffAt,
                )
                .reduce((n, o) => n + o.tickets, 0)
            : null;
      return `${safeText(song.title)}${song.streak ? ` · ${song.streak} day streak` : ""}${song.resumable ? " · Resume" : ""}${tickets !== null && tickets > 0 ? ` · ${tickets} tickets` : ""}`;
    };
    const sections = [
      "Songs",
      view.drawAt && view.drawAt > view.readAt
        ? `Daily draw: ${new Date(view.drawAt).toISOString()}`
        : "",
      yours.length ? "\nYour Songs\n" + yours.map(row).join("\n") : "",
      more.length
        ? (yours.length ? "\nMore songs\n" : "\n") + more.map(row).join("\n")
        : "",
    ];
    return {
      kind: "text",
      text: view.songs.length
        ? sections.filter(Boolean).join("\n")
        : "No songs are ready yet.",
      buttons,
      home: true,
    };
  },
  prompt(view) {
    return {
      kind: "text",
      text: `Say it back:\n${view.prompt!.line.text}`,
      forceReply: true,
      promptKey: view.prompt!.key,
    };
  },
  verdict(correct, heard) {
    return {
      kind: "text",
      text: correct
        ? "Correct"
        : `Incorrect\nYou said: “${safeText(heard, 512)}”`,
    };
  },
  result(view, facts, buttons) {
    const lines = [
      view.status === "completed"
        ? `Great work! ${view.score}%`
        : "This lesson has closed.",
    ];
    if (view.mode === "linked") {
      if (facts.streak !== null) lines.push(`${facts.streak} day streak`);
      if (facts.participation === "entered")
        lines.push("Entered in today's lottery.");
      else if (facts.participation === "pending")
        lines.push("Checking reward participation.");
      else if (facts.participation === "unavailable")
        lines.push("Reward status is unavailable.");
    }
    return { kind: "text", text: lines.join("\n"), buttons };
  },
};
