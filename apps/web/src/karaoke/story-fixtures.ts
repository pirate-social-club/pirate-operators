// Independent source story stage from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; central API fixtures omitted.
import { toKaraokeStageLines } from "../../../../packages/karaoke/lyric-transform.ts";
import artwork from "./story-artwork.svg?url";
export const storyArtworkSrc = artwork;
export const storyStageLines = toKaraokeStageLines([
  {
    id: "line-1",
    text: "I don't know why",
    start_ms: 1000,
    end_ms: 4000,
    words: [
      { text: "I", start_ms: 1000, end_ms: 1300 },
      { text: "don't", start_ms: 1300, end_ms: 1900 },
      { text: "know", start_ms: 1900, end_ms: 2500 },
      { text: "why", start_ms: 2500, end_ms: 4000 },
    ],
  },
  {
    id: "line-2",
    text: "you left so early",
    start_ms: 5000,
    end_ms: 8000,
    words: [
      { text: "you", start_ms: 5000, end_ms: 5600 },
      { text: "left", start_ms: 5700, end_ms: 6400 },
      { text: "so", start_ms: 6500, end_ms: 6900 },
      { text: "early", start_ms: 7000, end_ms: 8000 },
    ],
  },
  {
    id: "line-3",
    text: "and I still wait",
    start_ms: 9000,
    end_ms: 12000,
    words: [
      { text: "and", start_ms: 9000, end_ms: 9500 },
      { text: "I", start_ms: 9600, end_ms: 9800 },
      { text: "still", start_ms: 9900, end_ms: 10500 },
      { text: "wait", start_ms: 10600, end_ms: 12000 },
    ],
  },
]);
