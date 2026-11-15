import {
  decodeEventLog,
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type AbiParameterToPrimitiveType,
  type Address,
  type Hex,
} from "viem";
import { learningResultsV5Abi } from "./generated/learning-results-v5.ts";
import { insist } from "../community/common.ts";

const publish = learningResultsV5Abi.find(
  (e) => e.type === "function" && e.name === "publish",
);
if (!publish) throw Error("missing_compiled_publish_abi");
export type LearningResultV5 = AbiParameterToPrimitiveType<
  (typeof publish.inputs)[0]
>;
export function learningCommitmentV5(
  result: LearningResultV5,
  outcomes: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, publish!.inputs[0], { type: "bytes" }],
      [keccak256(stringToHex("pirate.learning-result/5")), result, outcomes],
    ),
  );
}
export interface LearningPublicationEvidence {
  address: Address;
  data: Hex;
  topics: readonly [Hex, ...Hex[]];
  removed: boolean;
}
// Historical decoder, not an RPC/finality verifier. Its caller must authenticate
// source, canonical receipt, ordered configuration and current feed eligibility.
export function readLearningPublicationV5(
  log: LearningPublicationEvidence,
  expected: {
    registry: Address;
    publisherAtEvent: Address;
    configurationRevision: bigint;
    previous?: { result: LearningResultV5; outcomes: Hex };
  },
) {
  insist(
    !log.removed &&
      log.address.toLowerCase() === expected.registry.toLowerCase(),
    "wrong_learning_source",
  );
  const event = decodeEventLog({
    abi: learningResultsV5Abi,
    eventName: "ResultPublishedV5",
    data: log.data,
    topics: [...log.topics],
    strict: true,
  });
  const {
    result,
    outcomes,
    commitment,
    publisher,
    configurationRevision,
    sessionId,
    learner,
    revision,
  } = event.args;
  insist(
    publisher.toLowerCase() === expected.publisherAtEvent.toLowerCase() &&
      configurationRevision === expected.configurationRevision &&
      result.sessionId === sessionId &&
      result.learner.toLowerCase() === learner.toLowerCase() &&
      result.revision === revision &&
      learningCommitmentV5(result, outcomes) === commitment,
    "invalid_learning_publication",
  );
  const definition = learningResultsV5Abi.find(
    (e) => e.type === "event" && e.name === "ResultPublishedV5",
  )!;
  const encoded = encodeAbiParameters(
    definition.inputs.filter((i) => !i.indexed),
    [result, outcomes, commitment, publisher, configurationRevision],
  );
  const topics = encodeEventTopics({
    abi: learningResultsV5Abi,
    eventName: "ResultPublishedV5",
    args: { sessionId, learner, revision },
  });
  insist(
    encoded.toLowerCase() === log.data.toLowerCase() &&
      topics.length === log.topics.length &&
      topics.every(
        (t, i) =>
          typeof t === "string" &&
          t.toLowerCase() === log.topics[i].toLowerCase(),
      ),
    "noncanonical_learning_event",
  );
  const prior = expected.previous;
  if (!prior) {
    insist(
      result.revision === 1 &&
        BigInt(result.supersedes) === 0n &&
        result.grader.toLowerCase() === publisher.toLowerCase(),
      "invalid_initial_grader",
    );
  } else {
    insist(
      result.revision === prior.result.revision + 1 &&
        result.supersedes ===
          learningCommitmentV5(prior.result, prior.outcomes),
      "broken_learning_history",
    );
    const unchanged = {
      ...result,
      status: prior.result.status,
      revision: prior.result.revision,
      supersedes: prior.result.supersedes,
    };
    insist(
      learningCommitmentV5(unchanged, prior.outcomes) ===
        learningCommitmentV5(prior.result, prior.outcomes),
      "changed_learning_attribution",
    );
  }
  return { result, outcomes, commitment, publisher, configurationRevision };
}
