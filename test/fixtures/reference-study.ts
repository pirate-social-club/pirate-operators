// Synthetic V3 suffix over retained public V2 source evidence. No key, provider,
// account activation or transaction is sent; raw ABI events/receipts are fixtures.
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  hexToBytes,
  keccak256,
  sha256,
  toHex,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { postsAbi } from "../../packages/community/post-chain.ts";
import type { LyricManifest } from "../../packages/community/lyric-manifest.ts";
import type { PinIntent } from "../../packages/community/ipfs.ts";
import { directoryAbi } from "../../packages/community/directory-reader.ts";
import { canonical } from "../../packages/community/common.ts";
import {
  packStudyOutcomes,
  studyExercisesHash,
  enrollmentV3Id,
  resultCommitment,
  STUDY_SCORING_POLICY_HASH,
  type TerminalResult,
} from "../../packages/protocol/learning-results-v3.ts";
import { studySourceLines } from "../../packages/study/public-source.ts";
import { studyQualificationPolicy } from "../../packages/records/study-qualification.ts";
import { learningV3PublicityPolicy } from "../../services/learning-policy-v3.ts";
import {
  v3Abi,
  resultManifestUri,
  type RawLog,
} from "../../harness/reference-results/facts.ts";
import { trace, learner, timestamp, hash } from "./reference-results.ts";

export function studyTrace(override?: {
  source: LyricManifest;
  pin: PinIntent;
  post: Record<string, any>;
  postPin: PinIntent;
}) {
  const legacy = trace(),
    snapshot = legacy.snapshot,
    address = `0x${"9".repeat(40)}` as Address;
  const who = learner(8);
  legacy.enroll(who);
  const source =
    override?.source ??
    Object.values(snapshot.documents)
      .map((bytes) => JSON.parse(new TextDecoder().decode(hexToBytes(bytes))))
      .find((doc) => doc.schema === "pirate.song-lyrics/1");
  const selected = studySourceLines(source)
    .lines.slice(0, 4)
    .map((line) => line.ordinal);
  const sourceHash = sha256(toHex(canonical(source))),
    policy = studyQualificationPolicy([legacy.original.grader]);
  const policyHash = sha256(toHex(canonical(policy))),
    policyUri = resultManifestUri(policyHash);
  snapshot.documents[policyUri] = toHex(canonical(policy));
  let serial = 0;
  function append(
    abi: Abi,
    name: string,
    args: Record<string, any>,
    target = address,
    at = Number(snapshot.head.timestamp) + 1,
    extra?: { name: string; args: Record<string, any> },
  ) {
    const number = String(BigInt(snapshot.head.number) + 1n),
      time = Math.max(at, Number(snapshot.head.timestamp) + 1),
      blockHash = hash(`study-block-${number}-${time}-${++serial}`),
      transactionHash = hash(`study-tx-${serial}`);
    const block = { number, hash: blockHash, timestamp: String(time) };
    snapshot.head = block;
    snapshot.checkedHeadHash = blockHash;
    snapshot.blocks[number] = block;
    snapshot.evaluationTimestamp = time;
    const encode = (eventName: string, values: Record<string, any>) => {
      const event = getAbiItem({ abi, name: eventName });
      if (!event || event.type !== "event")
        throw Error("missing_study_fixture_event");
      const inputs = event.inputs.filter((input) => !input.indexed);
      return {
        topics: encodeEventTopics({ abi, eventName, args: values }) as [
          Hex,
          ...Hex[],
        ],
        data: encodeAbiParameters(
          inputs,
          inputs.map((input) => values[input.name!]),
        ),
      };
    };
    const log: RawLog = {
        address: target,
        blockNumber: number,
        blockHash,
        transactionHash,
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
        ...encode(name, args),
      },
      logs = [log];
    if (extra)
      logs.push({ ...log, logIndex: 1, ...encode(extra.name, extra.args) });
    snapshot.logs.push(...logs);
    snapshot.receipts[transactionHash] = {
      hash: transactionHash,
      blockNumber: number,
      blockHash,
      status: "success",
      logs,
    };
    return log;
  }
  const lastConfiguration = [...snapshot.logs]
    .reverse()
    .find(
      (log) =>
        log.address.toLowerCase() ===
        snapshot.profile.directory.address.toLowerCase(),
    )!;
  const last = decodeEventLog({
    abi: directoryAbi,
    eventName: "ConfigurationPublished",
    data: lastConfiguration.data,
    topics: lastConfiguration.topics,
  }).args;
  const config = JSON.parse(
    new TextDecoder().decode(hexToBytes(snapshot.documents[last.uri])),
  );
  const nextConfig = {
    ...config,
    configurationRevision: config.configurationRevision + 1,
    learningRecords: address,
  };
  const bytes = toHex(canonical(nextConfig)),
    configHash = sha256(bytes),
    uri = resultManifestUri(configHash);
  snapshot.documents[uri] = bytes;
  const code = "0x6003600055" as Hex;
  snapshot.profile.results.push({
    version: 3,
    address,
    fromBlock: String(BigInt(snapshot.head.number) + 1n),
    codeHash: keccak256(code),
  });
  snapshot.codes[address] = code;
  append(
    directoryAbi,
    "ConfigurationPublished",
    {
      ...last,
      revision: BigInt(nextConfig.configurationRevision),
      learningRecords: address,
      sha256Digest: configHash,
      uri,
    },
    snapshot.profile.directory.address,
  );
  snapshot.directoryState.configurationRevision = String(
    nextConfig.configurationRevision,
  );
  snapshot.directoryState.configuration = {
    ...(snapshot.directoryState.configuration as object),
    learningRecords: address,
    sha256Digest: configHash,
    uri,
  };
  if (override) {
    snapshot.documents[override.pin.uri] = toHex(canonical(override.source));
    snapshot.documents[override.postPin.uri] = toHex(canonical(override.post));
    append(
      postsAbi,
      "PostRevisionPublished",
      {
        communityId: override.source.communityId,
        postId: override.source.postId,
        authorId: override.post.authorId,
        kind: 0,
        revision: BigInt(override.post.revision),
        configurationRevision: BigInt(nextConfig.configurationRevision),
        manifestSha256: override.postPin.sha256,
        manifestURI: override.postPin.uri,
      },
      snapshot.profile.posts.address,
    );
  }
  const state = {
    version: 3 as const,
    address,
    communityId: snapshot.profile.communityId,
    publicityPolicy: learningV3PublicityPolicy,
    commitments: {} as Record<string, Hex>,
    policies: {} as Record<string, Hex>,
  };
  snapshot.contractStates.push(state);
  append(v3Abi, "ControllerChanged", { controller: legacy.controller });
  for (const activity of [1, 2])
    append(v3Abi, "GraderSet", {
      grader: legacy.original.grader,
      activity,
      allowed: true,
    });
  const oldPolicyUri = Object.entries(snapshot.documents).find(
    ([, bytes]) => sha256(bytes) === legacy.policyHash,
  )![0];
  for (const activity of [1, 2])
    append(v3Abi, "PolicyActivated", {
      activity,
      policyHash: activity === 1 ? legacy.policyHash : policyHash,
      policyURI: activity === 1 ? oldPolicyUri : policyUri,
      effectivePeriod: 5n,
      clockVersion: 1,
    });
  const issuedAt = BigInt(Number(snapshot.head.timestamp) + 1),
    enrollment = {
      learner: who,
      communityId: state.communityId,
      activities: 3n,
      publicityPolicy: state.publicityPolicy,
      expiresAt: BigInt(timestamp(100)),
      nonce: 0n,
    };
  const grant = enrollmentV3Id(snapshot.profile.chainId, address, enrollment);
  append(
    v3Abi,
    "Enrolled",
    { learner: who, enrollmentId: grant, enrollment, issuedAt },
    address,
    Number(issuedAt),
  );
  const latest = new Map<
    Hex,
    { header: TerminalResult; wire: Hex; commitment: Hex }
  >();
  function publish(
    period: number,
    correct = [false, true, true, true],
    status = 1,
    finalStatus?: "unmeasured" | "unattempted",
  ) {
    const id = hash(`study-session-${serial}-${period}`),
      header: TerminalResult = {
        ...legacy.original,
        sessionId: id,
        learner: who,
        enrollmentId: grant,
        activity: 2,
        linesTotal: selected.length,
        exercisesHash: studyExercisesHash(selected),
        contentRevision: sourceHash,
        scoringPolicy: STUDY_SCORING_POLICY_HASH,
        qualificationPolicy: policyHash,
        startedAt: BigInt(timestamp(period) - 10),
        completedAt: BigInt(timestamp(period)),
        revision: 1,
        supersedes: zeroHash,
        status,
      };
    const wire = packStudyOutcomes(
      selected.map((sourceOrdinal, i) => ({
        sourceOrdinal,
        status:
          finalStatus && i === 0
            ? finalStatus
            : correct[i]
              ? "correct"
              : "incorrect",
      })),
    );
    const commitment = resultCommitment(header, wire);
    append(
      v3Abi,
      "ResultPublished",
      {
        sessionId: id,
        learner: who,
        revision: 1,
        result: header,
        outcomes: wire,
        commitment,
        publisher: header.grader,
      },
      address,
      timestamp(period) + 1,
    );
    latest.set(id, { header, wire, commitment });
    state.commitments[id] = commitment;
    state.policies[`2:${period}`] = policyHash;
    return id;
  }
  function correct(
    id: Hex,
    correct: boolean[] = [true, true, true, true],
    status = 1,
    publisher = legacy.controller,
  ) {
    const prior = latest.get(id)!;
    const wire =
      status === 5
        ? prior.wire
        : packStudyOutcomes(
            selected.map((sourceOrdinal, i) => ({
              sourceOrdinal,
              status: correct[i] ? "correct" : "incorrect",
            })),
          );
    const header = {
        ...prior.header,
        revision: prior.header.revision + 1,
        supersedes: prior.commitment,
        status,
      },
      commitment = resultCommitment(header, wire);
    append(
      v3Abi,
      "ResultPublished",
      {
        sessionId: id,
        learner: who,
        revision: header.revision,
        result: header,
        outcomes: wire,
        commitment,
        publisher,
      },
      address,
      Number(snapshot.head.timestamp) + 1,
      status === 5
        ? {
            name: "ResultInvalidated",
            args: {
              sessionId: id,
              revision: header.revision,
              reason: hash("review"),
            },
          }
        : undefined,
    );
    latest.set(id, { header, wire, commitment });
    state.commitments[id] = commitment;
    return header;
  }
  const revoke = () =>
    append(v3Abi, "Revoked", { learner: who, enrollmentId: grant, nonce: 1n });
  return {
    ...legacy,
    address,
    snapshot,
    state,
    source,
    selected,
    sourceHash,
    sourceUri: override?.pin.uri,
    who,
    policy,
    policyHash,
    grant,
    enrollment,
    latest,
    publish,
    correct,
    revoke,
    appendV3: append,
    publishLegacy: (period: number) => legacy.publish(who, period),
  };
}
