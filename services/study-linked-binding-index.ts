import { check } from "../packages/protocol/index.ts";

const prefix = "studyBinding:";
const scope = {
  community:
    "lower(json_extract(value,'$.offer.telegramFence.facts.actor.communityId'))",
  learner: "lower(json_extract(value,'$.offer.learner'))",
  chain: "json_extract(value,'$.target.chainId')",
  version: "json_extract(value,'$.target.version')",
  contract: "lower(json_extract(value,'$.target.contract'))",
};
const range = "key>='studyBinding:' AND key<'studyBinding;'";
const linked = "json_extract(value,'$.offer.speechChannel')='telegram-linked'";
const addressSql = (path: string, size: number) =>
  `(json_type(value,'${path}')='text' AND length(json_extract(value,'${path}'))=${size + 2} AND lower(substr(json_extract(value,'${path}'),1,2))='0x' AND lower(substr(json_extract(value,'${path}'),3)) NOT GLOB '*[^0-9a-f]*' AND lower(substr(json_extract(value,'${path}'),3))!=printf('%0${size}d',0))`;
const hint =
  "(json_type(value,'$.offer.speechChannel') IS NOT NULL OR json_type(value,'$.offer.telegramFence') IS NOT NULL OR json_type(value,'$.offer.privateSpeechSource') IS NOT NULL)";
/** Only lookup classification. The caller must still validate the complete
 * original binding, hashes and authorization before recording any denial. */
const classified = `(key>'studyBinding:' AND ${linked} AND ${addressSql("$.offer.telegramFence.facts.actor.communityId", 64)} AND ${addressSql("$.offer.learner", 40)} AND ${addressSql("$.target.contract", 40)} AND json_type(value,'$.target.chainId')='integer' AND ${scope.chain} IN (6343,31337) AND json_type(value,'$.target.version')='integer' AND ${scope.version}=4)`;
const unclassified = `${range} AND ${hint} AND COALESCE(${classified},0)=0`;
const validHex = (value: string, size: number) =>
  new RegExp(`^0x[0-9a-f]{${size}}$`).test(value) && BigInt(value) > 0n;

/** Required SQL discovery port. It never falls back to an entries scan and
 * does not itself establish a membership or admission fence across pages. */
export function linkedStudyBindingIndex(sql: SqlStorage) {
  sql.exec(`CREATE INDEX IF NOT EXISTS records_linked_study_discovery
    ON records(${scope.community},${scope.learner},${scope.chain},${scope.version},${scope.contract},key)
    WHERE ${range} AND ${linked}`);
  sql.exec(`CREATE INDEX IF NOT EXISTS records_unclassified_linked_study_binding_v2
    ON records(key) WHERE ${unclassified}`);
  return {
    hasUnclassified() {
      return (
        sql
          .exec(
            `SELECT 1 FROM records INDEXED BY records_unclassified_linked_study_binding_v2 WHERE ${unclassified} LIMIT 1`,
          )
          .toArray().length > 0
      );
    },
    page(input: {
      communityId: string;
      learner: string;
      target: { chainId: number; version: number; contract: string };
      after: string;
      limit: number;
    }) {
      const community = input.communityId.toLowerCase(),
        learner = input.learner.toLowerCase(),
        contract = input.target.contract.toLowerCase();
      check(
        validHex(community, 64) &&
          validHex(learner, 40) &&
          validHex(contract, 40) &&
          input.target.version === 4 &&
          [6343, 31337].includes(input.target.chainId) &&
          Number.isSafeInteger(input.limit) &&
          input.limit > 0 &&
          input.limit <= 50 &&
          input.after >= prefix &&
          input.after < prefix + "\uffff",
        "invalid_study_binding_discovery",
      );
      return sql
        .exec<{ key: string; value: string }>(
          `SELECT key,value FROM records INDEXED BY records_linked_study_discovery
        WHERE ${range} AND ${linked}
          AND ${scope.community}=? AND ${scope.learner}=? AND ${scope.chain}=?
          AND ${scope.version}=? AND ${scope.contract}=? AND key>?
        ORDER BY key LIMIT ?`,
          community,
          learner,
          input.target.chainId,
          4,
          contract,
          input.after,
          input.limit,
        )
        .toArray()
        .map((row) => ({
          key: row.key,
          value: JSON.parse(row.value) as unknown,
        }));
    },
  };
}
export type LinkedStudyBindingIndex = ReturnType<
  typeof linkedStudyBindingIndex
>;
