import { canonical, hashText, insist } from "./common.ts";
import type { Hex } from "viem";
import type { ConfigurationLog } from "./directory-reader.ts";

export const CONFIGURATION_PAGE_SIZE = 8;
export interface ConfigurationEvidence { log: ConfigurationLog; document: string }
export interface DirectoryCheckpoint {
  snapshot: string;
  nextBlock: bigint;
  blockHash: Hex;
  revision: number;
  pages: number;
}
export interface CheckpointWriter {
  append(page: readonly ConfigurationEvidence[]): Promise<void>;
  commit(head: bigint, hash: Hex, revision: number): Promise<boolean>;
}
export interface DirectoryHistoryCache {
  load(through: bigint): Promise<DirectoryCheckpoint | undefined>;
  pages(saved: DirectoryCheckpoint): AsyncIterable<readonly ConfigurationEvidence[]>;
  begin(previous: DirectoryCheckpoint | undefined): CheckpointWriter;
}
export function encodeEvidence(page: readonly ConfigurationEvidence[]) {
  insist(page.length > 0 && page.length <= CONFIGURATION_PAGE_SIZE, "invalid_checkpoint_page");
  return canonical(page.map(({ log, document }) => ({ ...log,
    args: { ...log.args, controller: log.args.controller.toLowerCase(), publisher: log.args.publisher.toLowerCase(), operatorPayments: log.args.operatorPayments.toLowerCase(), learningRecords: log.args.learningRecords.toLowerCase(), revision: String(log.args.revision) },
    blockNumber: String(log.blockNumber), document })));
}
export const evidenceDigest = (page: readonly ConfigurationEvidence[]) => hashText(encodeEvidence(page));
