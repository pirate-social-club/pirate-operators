// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/lib/ui-locale.tsx.
import { createContext, useContext, type ParentProps } from "solid-js";

import { getRequestEvent } from "@solidjs/web";
import { resolveRequestUiLocale, type UiLocaleCode } from "./ui-locale-core";

// Storybook and future standalone-owned product stories use explicit globals;
// locale state is intentionally in-memory and never persisted in browser
// storage or coupled to authentication.
const UiLocaleContext = createContext<UiLocaleCode | null>(null);

export function UiLocaleProvider(props: ParentProps<{ locale: UiLocaleCode }>) {
  return <UiLocaleContext value={props.locale}>{props.children}</UiLocaleContext>;
}

export function useUiLocale(): UiLocaleCode {
  return useContext(UiLocaleContext) ?? "en";
}

export type { UiLocaleCode } from "./ui-locale-core";

/** Request locale for public labels, pinned to SSR's document language on hydration. */
export function usePageUiLocale(): UiLocaleCode {
  const provided = useContext(UiLocaleContext);
  if (provided !== null) return provided;
  const event = getRequestEvent();
  if (event) return resolveRequestUiLocale(new URL(event.request.url), event.request.headers.get("accept-language"));
  return resolveRequestUiLocale(
    new URL(typeof location === "undefined" ? "https://pirate.invalid/" : location.href),
    typeof document === "undefined" ? undefined : document.documentElement.lang || navigator.language,
  );
}
