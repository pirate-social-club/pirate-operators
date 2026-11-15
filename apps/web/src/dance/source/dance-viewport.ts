import { createSignal, onCleanup, onSettled } from "solid-js";

/** Owner policy: no new web desktop Dance posting. This is presentation
 * eligibility, never identity or server authority. Existing originals stay
 * retained when the viewport changes; no reset/disposal is performed here. */
export const DANCE_DESKTOP_QUERY = "(min-width: 768px)";
export function dancePostingAllowed(): boolean {
  return typeof window !== "undefined" && !window.matchMedia(DANCE_DESKTOP_QUERY).matches;
}
export function createDancePostingViewport() {
  const [allowed, setAllowed] = createSignal(dancePostingAllowed());
  let query: MediaQueryList | undefined;
  const change = () => setAllowed(dancePostingAllowed());
  onSettled(() => {
    if (typeof window === "undefined") return;
    query = window.matchMedia(DANCE_DESKTOP_QUERY);
    change();
    query.addEventListener("change", change);
  });
  onCleanup(() => query?.removeEventListener("change", change));
  return allowed;
}
