import type { Address, Hex } from "viem";
import type { LyricManifest } from "../community/lyric-manifest.ts";
import type { LessonState } from "./lesson.ts";

/** Sent by the authenticated community service, never accepted from a learner. */
export interface StudyTerminalRequest {
  lessonId: string;
  state: LessonState;
  source: LyricManifest;
}
export interface StudyPublicationReceipt {
  state: "pending" | "published" | "private" | "failed";
  sessionId: Hex;
  chainId: 31337 | 6343;
  contract: Address;
  commitment: Hex;
  transactionHash: Hex | null;
  confirmed: boolean;
  checkedAt: number;
  reason?: string;
}
