// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/karaoke-lyric-layout.test.ts; imports and the stylesheet path changed.
import { describe, expect, it } from "./karaoke-expect.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../apps/web/src/karaoke/karaoke.css", import.meta.url)),
  "utf8",
);

const lyricLineRule = css
  .split("\n")
  .find((line) => line.startsWith(".karaoke-line {")) ?? "";

/**
 * Guards the mobile lyric collapse: at 320px every line rendered one word per
 * row, which made the practice surface unusable. Two properties caused it
 * together, so both are asserted.
 */
describe("karaoke lyric line layout", () => {
  it("has a lyric line rule to check", () => {
    expect(lyricLineRule).not.toBe("");
  });

  /**
   * `overflow-wrap: anywhere` makes every character a soft wrap opportunity
   * for min-content sizing. `break-word` breaks only on real overflow and
   * leaves intrinsic sizing alone.
   */
  it("never uses overflow-wrap: anywhere on a lyric line", () => {
    expect(lyricLineRule).not.toContain("overflow-wrap: anywhere");
    expect(lyricLineRule).toContain("overflow-wrap: break-word");
  });

  /**
   * The line is a flex item in a column container. Inline auto margins stop it
   * stretching, so without an explicit width it is sized by its content and
   * collapses toward min-content on a narrow viewport.
   */
  it("gives the lyric line an explicit width so auto margins cannot shrink it", () => {
    expect(lyricLineRule).toContain("width: 100%");
    expect(lyricLineRule).not.toMatch(/margin:\s*0\s+auto/);
  });

  it("keeps the line centred and capped once there is room", () => {
    expect(lyricLineRule).toContain("max-width: 48rem");
    expect(lyricLineRule).toContain("margin-inline: auto");
  });

  it("scales the lyric type down on narrow viewports", () => {
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(mobileBlock).toContain(".karaoke-line { font-size:");
    expect(mobileBlock).toContain(".karaoke-line-next { font-size:");
  });
});
