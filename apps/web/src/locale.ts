// Interface language: catalogs, direction and the inline boot script.
//
// Interface language, content language and song or scoring language are
// separate (contract section 4). This module covers only the first. Content
// carries its own lang and dir; nothing here reads or changes them.

export const rtlLanguages = ["ar", "fa", "he", "ur"] as const;
export const LANGUAGE_STORAGE_KEY = "pirate.ui-language";

export function directionOf(language: string): "ltr" | "rtl" {
  return (rtlLanguages as readonly string[]).includes(language) ? "rtl" : "ltr";
}

const en = {
  home: "Home",
  about: "About",
  aboutTitle: "About this community",
  posts: "Posts",
  by: "by",
  song: "Song",
  published: "Published",
  signIn: "Sign in",
  signInOn: "Sign in on {host}",
  signInPending: "Sign-in arrives with the community service.",
  signedOut: "Signed out",
  sessionUnavailable: "Account status unavailable",
  reply: "Reply",
  replyOn: "Reply on {host}",
  mirrorNotice: "Read-only copy. Actions open {host}.",
  fixture: "Fixture data",
  updated: "This post changed after this page was published.",
  removed: "This post was removed.",
  notFound: "Page not found.",
  unavailable: "This content is unavailable right now.",
  backHome: "Back to the community",
  noscript: "This page needs JavaScript. Published posts work without it.",
} as const;

export type MessageKey = keyof typeof en;
type Catalog = Record<MessageKey, string>;

const ar: Catalog = {
  home: "الرئيسية",
  about: "حول",
  aboutTitle: "حول هذا المجتمع",
  posts: "المنشورات",
  by: "بواسطة",
  song: "الأغنية",
  published: "نُشر",
  signIn: "تسجيل الدخول",
  signInOn: "تسجيل الدخول على {host}",
  signInPending: "سيتوفر تسجيل الدخول مع خدمة المجتمع.",
  signedOut: "لم يتم تسجيل الدخول",
  sessionUnavailable: "حالة الحساب غير متاحة",
  reply: "رد",
  replyOn: "الرد على {host}",
  mirrorNotice: "نسخة للقراءة فقط. تفتح الإجراءات {host}.",
  fixture: "بيانات تجريبية",
  updated: "تغيّر هذا المنشور بعد نشر هذه الصفحة.",
  removed: "أُزيل هذا المنشور.",
  notFound: "الصفحة غير موجودة.",
  unavailable: "هذا المحتوى غير متاح حاليًا.",
  backHome: "العودة إلى المجتمع",
  noscript: "تحتاج هذه الصفحة إلى JavaScript. تعمل المنشورات المنشورة بدونه.",
};

const catalogs: Record<string, Catalog> = { en, ar };

export function catalogFor(language: string): Catalog {
  return catalogs[language] ?? en;
}

export function message(catalog: Catalog, key: MessageKey, values: Record<string, string> = {}): string {
  return catalog[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
}

/**
 * Resolution order: explicit ?lang=, saved preference, navigator.languages,
 * community default, English. An explicit choice is saved; a language
 * preference is not a credential. This function is serialized into the inline
 * boot script, so it must stay self-contained and ES2017-safe.
 */
export function resolveInterfaceLanguage(defaultLanguage: string, supported: string[], rtl: string[], key: string): void {
  var chosen: string | null = null;
  var explicit = new URLSearchParams(location.search).get("lang");
  try {
    if (explicit && supported.indexOf(explicit) >= 0) {
      chosen = explicit;
      localStorage.setItem(key, explicit);
    } else {
      var saved = localStorage.getItem(key);
      if (saved && supported.indexOf(saved) >= 0) chosen = saved;
    }
  } catch (_) {
    // Storage can be unavailable (privacy modes, sandboxed origins).
  }
  if (!chosen) {
    var preferred = navigator.languages || [];
    for (var i = 0; i < preferred.length && !chosen; i++) {
      var base = String(preferred[i]).toLowerCase().split("-")[0];
      if (supported.indexOf(base) >= 0) chosen = base;
    }
  }
  if (!chosen) chosen = supported.indexOf(defaultLanguage) >= 0 ? defaultLanguage : "en";
  var root = document.documentElement;
  root.lang = chosen;
  root.dir = rtl.indexOf(chosen) >= 0 ? "rtl" : "ltr";
}

export function localeBootScript(defaultLanguage: string, supported: readonly string[]): string {
  const args = [defaultLanguage, [...supported], [...rtlLanguages], LANGUAGE_STORAGE_KEY].map(value => JSON.stringify(value));
  return `(${resolveInterfaceLanguage.toString()})(${args.join(",")});`;
}
