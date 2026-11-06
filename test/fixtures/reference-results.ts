// Explicitly synthetic offline traces over retained public source documents.
// No key, account activation, provider call or transaction is performed.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  keccak256,
  sha256,
  toHex,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import {
  enrollmentIdOf,
  resultCommitment,
  type TerminalResult,
} from "../../packages/protocol/learning-results.ts";
import { canonical } from "../../packages/community/common.ts";
import {
  abi,
  resultManifestUri,
  type ReferenceSnapshot,
  type RawLog,
} from "../../harness/reference-results/facts.ts";

export const publicCapture = () =>
  JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "../../fixtures/results-v2-reference/public-before-policy.json.gz",
          import.meta.url,
        ),
      ),
    ).toString("utf8"),
  ) as ReferenceSnapshot;
export const epoch = 1793552400;
export const timestamp = (period: number, offset = 120) =>
  epoch + period * 86400 + offset;
// Public local fixture keys only. Never fund these identities on a public chain.
export const learner = (n: number) =>
  privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}` as Hex).address;
export const hash = (text: string) => keccak256(toHex(text));

export function encodeEvent(name: string, args: Record<string, any>) {
  const event = getAbiItem({ abi: abi as Abi, name });
  if (!event || event.type !== "event") throw Error("missing_fixture_event");
  const inputs = event.inputs.filter((x) => !x.indexed);
  return {
    topics: encodeEventTopics({ abi: abi as Abi, eventName: name, args }) as [
      Hex,
      ...Hex[],
    ],
    data: encodeAbiParameters(
      inputs,
      inputs.map((x) => args[x.name!]),
    ),
  };
}
export function rewritePublication(
  snapshot: ReferenceSnapshot,
  change: (
    header: TerminalResult,
    wire: Hex,
  ) => { header: TerminalResult; wire: Hex },
) {
  const log = [...snapshot.logs].reverse().find((l) => {
    if (
      l.address.toLowerCase() !==
      snapshot.profile.results[0]!.address.toLowerCase()
    )
      return false;
    return (
      decodeEventLog({ abi, data: l.data, topics: l.topics, strict: true })
        .eventName === "ResultPublished"
    );
  })!;
  const event = decodeEventLog({
    abi,
    eventName: "ResultPublished",
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  const next = change(event.args.result, event.args.outcomes),
    commitment = resultCommitment(next.header, next.wire);
  const packet = encodeEvent("ResultPublished", {
    sessionId: next.header.sessionId,
    learner: next.header.learner,
    revision: next.header.revision,
    result: next.header,
    outcomes: next.wire,
    commitment,
    publisher: event.args.publisher,
  });
  Object.assign(log, packet);
  const receipt = snapshot.receipts[log.transactionHash]!;
  Object.assign(receipt.logs.find((l) => l.logIndex === log.logIndex)!, packet);
  snapshot.contractStates[0]!.commitments[next.header.sessionId] = commitment;
  return log;
}
export function trace() {
  const snapshot = publicCapture();
  const address = snapshot.profile.results[0]!.address;
  const original = snapshot.logs
    .filter((l) => l.address.toLowerCase() === address.toLowerCase())
    .flatMap((l) => {
      const event = decodeEventLog({
        abi,
        data: l.data,
        topics: l.topics,
        strict: true,
      });
      return event.eventName === "ResultPublished" ? [event.args.result] : [];
    })[0]!;
  snapshot.logs = snapshot.logs.filter((l) => {
    if (l.address.toLowerCase() !== address.toLowerCase()) return true;
    const e = decodeEventLog({
      abi,
      data: l.data,
      topics: l.topics,
      strict: true,
    });
    return ![
      "Enrolled",
      "Revoked",
      "ResultPublished",
      "ResultInvalidated",
      "EligibilityChanged",
    ].includes(e.eventName);
  });
  const used = new Set(snapshot.logs.map((l) => l.transactionHash));
  snapshot.receipts = Object.fromEntries(
    Object.entries(snapshot.receipts).filter(([key]) => used.has(key as Hex)),
  );
  const state = snapshot.contractStates[0]!;
  state.commitments = {};
  state.policies = {};
  let serial = 0;
  const grants = new Map<Address, Hex>();
  const nonces = new Map<Address, bigint>();
  const latest = new Map<
    Hex,
    { header: TerminalResult; wire: Hex; commitment: Hex }
  >();
  const policyHash = snapshot.logs.flatMap((l) => {
    if (l.address.toLowerCase() !== address.toLowerCase()) return [];
    const e = decodeEventLog({
      abi,
      data: l.data,
      topics: l.topics,
      strict: true,
    });
    return e.eventName === "PolicyActivated" ? [e.args.policyHash] : [];
  })[0]!;
  const controller = snapshot.logs.flatMap((l) => {
    if (l.address.toLowerCase() !== address.toLowerCase()) return [];
    const e = decodeEventLog({
      abi,
      data: l.data,
      topics: l.topics,
      strict: true,
    });
    return e.eventName === "ControllerChanged" ? [e.args.controller] : [];
  })[0]!;
  function append(
    name: string,
    args: Record<string, any>,
    at = Number(snapshot.head.timestamp) + 1,
    extra?: { name: string; args: Record<string, any> },
  ) {
    const number = String(BigInt(snapshot.head.number) + 1n),
      time = Math.max(Number(snapshot.head.timestamp) + 1, at);
    const blockHash = hash(`synthetic-block-${number}-${time}-${++serial}`),
      tx = hash(`synthetic-tx-${serial}`);
    const header = { number, hash: blockHash, timestamp: String(time) };
    snapshot.head = header;
    snapshot.checkedHeadHash = blockHash;
    snapshot.blocks[number] = header;
    const log: RawLog = {
      address,
      blockNumber: number,
      blockHash,
      transactionHash: tx,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
      ...encodeEvent(name, args),
    };
    const logs = [log];
    if (extra)
      logs.push({
        ...log,
        logIndex: 1,
        ...encodeEvent(extra.name, extra.args),
      });
    snapshot.logs.push(...logs);
    snapshot.receipts[tx] = {
      hash: tx,
      blockNumber: number,
      blockHash,
      status: "success",
      logs,
    };
    snapshot.evaluationTimestamp = time;
    return log;
  }
  function enroll(who: Address) {
    const issued = BigInt(Number(snapshot.head.timestamp) + 1),
      nonce = nonces.get(who) ?? 0n;
    const e = {
      learner: who,
      communityId: state.communityId,
      activities: 1n,
      publicityPolicy: state.publicityPolicy,
      expiresAt: BigInt(timestamp(100)),
      nonce,
    };
    const id = enrollmentIdOf(snapshot.profile.chainId, address, e);
    append(
      "Enrolled",
      { learner: who, enrollmentId: id, enrollment: e, issuedAt: issued },
      Number(issued),
    );
    grants.set(who, id);
    nonces.set(who, nonce + 1n);
    return id;
  }
  function wire(
    grade = 10000,
    changes: Record<number, { status: number; grade?: number }> = {},
  ) {
    const bytes = new Uint8Array(original.linesTotal * 5),
      view = new DataView(bytes.buffer);
    for (let i = 0; i < original.linesTotal; i++) {
      const line = changes[i + 1] ?? { status: 1, grade };
      view.setUint16(i * 5, i + 1);
      view.setUint8(i * 5 + 2, line.status);
      view.setUint16(i * 5 + 3, line.status === 1 ? (line.grade ?? grade) : 0);
    }
    return toHex(bytes);
  }
  function publish(
    who: Address,
    period: number,
    grade = 10000,
    changes: Record<number, { status: number; grade?: number }> = {},
    options: Partial<TerminalResult> = {},
  ) {
    const id = hash(`synthetic-session-${serial}-${who}-${period}`);
    const r: TerminalResult = {
      ...original,
      sessionId: id,
      learner: who,
      enrollmentId: grants.get(who)!,
      startedAt: BigInt(timestamp(period) - 10),
      completedAt: BigInt(timestamp(period)),
      qualificationPolicy: period >= 5 ? policyHash : `0x${"0".repeat(64)}`,
      revision: 1,
      supersedes: `0x${"0".repeat(64)}`,
      status: 1,
      ...options,
    };
    const body = wire(grade, changes),
      commitment = resultCommitment(r, body);
    append(
      "ResultPublished",
      {
        sessionId: r.sessionId,
        learner: who,
        revision: r.revision,
        result: r,
        outcomes: body,
        commitment,
        publisher: r.grader,
      },
      Number(r.completedAt) + 1,
    );
    state.commitments[r.sessionId] = commitment;
    state.policies[
      String(Math.floor((Number(r.completedAt) - epoch) / 86400))
    ] = r.qualificationPolicy;
    latest.set(id, { header: r, wire: body, commitment });
    return id;
  }
  function correct(id: Hex, body: Hex, status = 1, publisher = controller) {
    const previous = latest.get(id)!;
    const r = {
      ...previous.header,
      revision: previous.header.revision + 1,
      supersedes: previous.commitment,
      status,
    };
    const commitment = resultCommitment(r, body);
    append(
      "ResultPublished",
      {
        sessionId: id,
        learner: r.learner,
        revision: r.revision,
        result: r,
        outcomes: body,
        commitment,
        publisher,
      },
      undefined,
      status === 5
        ? {
            name: "ResultInvalidated",
            args: {
              sessionId: id,
              revision: r.revision,
              reason: hash("synthetic-invalidation"),
            },
          }
        : undefined,
    );
    state.commitments[id] = commitment;
    latest.set(id, { header: r, wire: body, commitment });
    return r;
  }
  function addPolicy(period: number, overrides: Record<string, unknown> = {}) {
    const document = {
      schema: "pirate.learning-policy/2",
      version: `synthetic-policy-${period}`,
      clockVersion: 1,
      activity: 1,
      graders: [original.grader.toLowerCase()],
      scoringPolicies: [original.scoringPolicy],
      terminalStatuses: [1, 2, 3, 4],
      minScoreBps: 7000,
      maxUnmeasuredBps: 1000,
      rewards: false,
      ...overrides,
    };
    const bytes = toHex(canonical(document)),
      digest = sha256(bytes),
      uri = resultManifestUri(digest);
    snapshot.documents[uri] = bytes;
    append("PolicyActivated", {
      policyHash: digest,
      policyURI: uri,
      effectivePeriod: BigInt(period),
      clockVersion: 1,
    });
    return { hash: digest, uri };
  }
  return {
    snapshot,
    address,
    original,
    controller,
    policyHash,
    latest,
    append,
    enroll,
    publish,
    wire,
    correct,
    addPolicy,
  };
}
