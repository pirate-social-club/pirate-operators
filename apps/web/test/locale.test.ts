import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { catalogFor, directionOf, localeBootScript, message } from "../src/locale.ts";

function boot(search: string, languages: string[], saved: string | null, storageThrows = false) {
  const stored = new Map<string, string>(saved === null ? [] : [["pirate.ui-language", saved]]);
  const root = { lang: "en", dir: "ltr" };
  const storage = {
    getItem: (key: string) => { if (storageThrows) throw new Error("denied"); return stored.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (storageThrows) throw new Error("denied"); stored.set(key, value); },
  };
  runInNewContext(localeBootScript("en", ["en", "ar"]), {
    URLSearchParams, location: { search }, navigator: { languages }, localStorage: storage, document: { documentElement: root },
  });
  return { root, stored };
}

test("explicit ?lang= wins and is saved", () => {
  const { root, stored } = boot("?lang=ar", ["en-US"], null);
  assert.deepEqual(root, { lang: "ar", dir: "rtl" });
  assert.equal(stored.get("pirate.ui-language"), "ar");
});

test("saved preference, then navigator.languages, then the community default", () => {
  assert.equal(boot("", ["en-US"], "ar").root.lang, "ar");
  assert.equal(boot("", ["ar-EG", "en"], null).root.dir, "rtl");
  assert.equal(boot("", ["fr-FR"], null).root.lang, "en");
  assert.equal(boot("?lang=xx", ["fr"], "zz").root.lang, "en");
});

test("unavailable storage still resolves a language", () => {
  assert.deepEqual(boot("?lang=ar", [], null, true).root, { lang: "ar", dir: "rtl" });
});

test("catalogs and direction", () => {
  assert.equal(directionOf("ar"), "rtl");
  assert.equal(directionOf("en"), "ltr");
  assert.equal(message(catalogFor("en"), "signInOn", { host: "a.example" }), "Sign in on a.example");
  assert.equal(catalogFor("xx").home, "Home");
});
