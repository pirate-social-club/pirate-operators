// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/lib/ui-locale-core.test.ts.
// Owned adaptations: the test runner is node:test, this app's runner, and
// the assertions use node's assert.equal instead of bun's expect.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveDirectionalSide,
  resolveLocaleDirection,
  resolveLocaleLanguageTag,
  resolveRequestLocale,
  resolveRequestUiLocale,
} from "./ui-locale-core.ts";

describe("Solid UI locale resolution", () => {
  it("resolves supported Accept-Language values by quality", () => {
    assert.equal(resolveRequestLocale("en;q=0.4, ar-SA;q=0.9"), "ar");
    assert.equal(resolveRequestLocale("fr, zh-Hans;q=0.8"), "zh");
    assert.equal(resolveRequestLocale("fr-FR"), "en");
  });

  it("lets an explicit locale query override the request header", () => {
    assert.equal(resolveRequestUiLocale(new URL("https://pirate.sc/?locale=zh-CN"), "ar"), "zh");
    assert.equal(resolveRequestUiLocale(new URL("https://pirate.sc/?lang=pseudo"), "ar"), "pseudo");
  });

  it("keeps direction and language tags centralized", () => {
    assert.equal(resolveLocaleDirection("ar"), "rtl");
    assert.equal(resolveLocaleLanguageTag("zh"), "zh-CN");
    assert.equal(resolveDirectionalSide("start", "rtl"), "right");
  });
});
