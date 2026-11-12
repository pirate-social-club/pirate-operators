/** @jsxImportSource @solidjs/web */
import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
} from "solid-js";

/**
 * Lets a page tell the application chrome that the viewer is writing a post.
 * On a phone, composing is the whole screen, so the chrome hides its bottom
 * navigation while this is true. The chrome owns the value and resets it when
 * the page that set it goes away.
 */
export interface ComposingSurface {
  readonly composing: Accessor<boolean>;
  readonly setComposing: (composing: boolean) => void;
}

export const ComposingSurfaceContext = createContext<ComposingSurface | null>(
  null,
);

export function useComposingSurface(): ComposingSurface | null {
  return useContext(ComposingSurfaceContext);
}

/** The phone breakpoint shared with the design system's `createIsMobile`. */
const PHONE_QUERY = "(max-width: 767px)";

/**
 * Whether the composer is laid out for a phone, known from its first render.
 * The design system's media signal starts false and corrects itself in an
 * effect, which would show the desktop card for a frame and lose the focus
 * given on open. A composer only ever renders in a browser, after a tap, so
 * there is no server render to agree with.
 */
export function createPhoneLayout(): Accessor<boolean> {
  const media =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(PHONE_QUERY)
      : null;
  const [phone, setPhone] = createSignal(media?.matches ?? false, {
    ownedWrite: true,
  });
  if (media !== null) {
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    onCleanup(() => media.removeEventListener("change", update));
  }
  return phone;
}
