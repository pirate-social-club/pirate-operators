// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/lib/ui-locale-core.ts.
const SUPPORTED_UI_LOCALES = ["en", "ar", "zh", "pseudo"] as const;

export type UiLocaleCode = (typeof SUPPORTED_UI_LOCALES)[number];
export type RealUiLocaleCode = Exclude<UiLocaleCode, "pseudo">;
export type UiDirection = "ltr" | "rtl";
export type UiPlacement = "left" | "right" | "start" | "end";

export function isUiLocaleCode(value: string): value is UiLocaleCode {
  // SAFETY: this readonly list is the complete runtime locale contract.
  return (SUPPORTED_UI_LOCALES as readonly string[]).includes(value);
}

export function resolveLocaleDirection(locale: UiLocaleCode): UiDirection {
  return locale === "ar" ? "rtl" : "ltr";
}

export function resolveLocaleLanguageTag(locale: UiLocaleCode): string {
  if (locale === "ar") return "ar";
  if (locale === "zh") return "zh-CN";
  if (locale === "pseudo") return "en-XA";
  return "en";
}

export function resolveDirectionalSide(
  side: UiPlacement,
  direction: UiDirection,
): "left" | "right" {
  if (side === "left" || side === "right") return side;
  if (side === "start") return direction === "rtl" ? "right" : "left";
  return direction === "rtl" ? "left" : "right";
}

export function resolveRequestLocale(
  acceptLanguageHeader: string | null | undefined,
): RealUiLocaleCode {
  if (!acceptLanguageHeader) return "en";

  const requestedTags = acceptLanguageHeader
    .split(",")
    .map((part, index) => {
      const [rawTag, ...parameters] = part.trim().split(";");
      const quality = parameters.reduce((result, parameter) => {
        const match = /^q=([01](?:\.\d+)?)$/i.exec(parameter.trim());
        return match ? Number(match[1]) : result;
      }, 1);
      return { tag: rawTag?.trim().toLowerCase() ?? "", quality, index };
    })
    .filter(candidate => candidate.tag && candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const { tag } of requestedTags) {
    if (tag === "ar" || tag.startsWith("ar-")) return "ar";
    if (tag === "zh" || tag.startsWith("zh-")) return "zh";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }

  return "en";
}

export function resolveRequestUiLocale(
  url: URL,
  acceptLanguageHeader: string | null | undefined,
): UiLocaleCode {
  for (const key of ["locale", "lang"] as const) {
    const requested = url.searchParams.get(key)?.trim().toLowerCase();
    if (requested && isUiLocaleCode(requested)) return requested;
    if (requested?.startsWith("ar-")) return "ar";
    if (requested?.startsWith("zh-")) return "zh";
    if (requested?.startsWith("en-")) return "en";
  }
  return resolveRequestLocale(acceptLanguageHeader);
}
