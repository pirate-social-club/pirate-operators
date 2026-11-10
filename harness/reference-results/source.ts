// Independent source membership checks from raw directory/post logs and bytes.
// This module does not call the application directory or source readers.
import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  sha256,
  toHex,
  type Hex,
} from "viem";
import { fullLyrics } from "./lyrics.ts";
import { configurationDocument } from "./configuration.ts";
import { postDocument } from "./post.ts";
import { documentIpfs } from "./document-rules.ts";
import { studySource } from "./study.ts";
import type { ReferenceSession } from "./board.ts";
import { directoryAbi } from "../../packages/community/directory-reader.ts";
import { postsAbi } from "../../packages/community/post-chain.ts";
import type { Header, RawLog, ReferenceSnapshot } from "./facts.ts";
import {
  canonical,
  integer,
  lower,
  ordered,
  publicDocument,
  rawCode,
  rawEvent,
  requireFact,
  zero,
} from "./checks.ts";

const sameAddress = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && lower(a) === lower(b);
const hex32 = (x: unknown): x is Hex =>
  typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x);
const excludedCue = (text: string) => {
  const t = text.trim();
  return (
    /^\[[^\[\]\r\n]*\]$/.test(t) ||
    /^\(\s*instrumental(?:\s+solo|\s+breakdown(?:\s+with\s+vocal\s+chops)?)?\s*\)$/iu.test(
      t,
    )
  );
};

export function sourceIndex(snapshot: ReferenceSnapshot) {
  const p = snapshot.profile;
  rawCode(snapshot, p.directory);
  rawCode(snapshot, p.posts);
  const expectedCommunity = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }],
      [BigInt(p.chainId), p.registry],
    ),
  );
  requireFact(
    expectedCommunity === p.communityId,
    "community_identity_changed",
  );
  const configurations = new Map<
    number,
    { value: Record<string, any>; log: RawLog }
  >();
  const revocations: string[] = [];
  const knownPublishers = new Set<string>();
  for (const log of ordered(snapshot, p.directory.address)) {
    let event;
    try {
      event = decodeEventLog({
        abi: directoryAbi,
        eventName: "ConfigurationPublished",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
    } catch {
      continue;
    }
    if (event.args.communityId !== p.communityId) continue;
    rawEvent(snapshot, log);
    const a = event.args;
    documentIpfs(a.uri);
    const c = publicDocument(snapshot, a.uri, a.sha256Digest, 65536);
    configurationDocument(c);
    requireFact(
      configurations.size === 0 || c.tld === configurations.get(1)!.value.tld,
      "configuration_tld_changed",
    );
    const revision = integer(a.revision);
    requireFact(
      revision === configurations.size + 1 &&
        c.schema === "pirate.community-config/1" &&
        c.chainId === p.chainId &&
        c.communityId === p.communityId &&
        sameAddress(c.registry, p.registry) &&
        sameAddress(c.directory, p.directory.address) &&
        sameAddress(c.postsContract, p.posts.address) &&
        c.configurationRevision === revision &&
        sameAddress(c.controller, a.controller) &&
        sameAddress(c.publisher, a.publisher) &&
        sameAddress(c.operatorPayments, a.operatorPayments) &&
        sameAddress(c.learningRecords, a.learningRecords),
      "configuration_binding_changed",
    );
    requireFact(
      Array.isArray(c.publisherRevocations) &&
        c.publisherRevocations.length <= 256,
      "invalid_revocations",
    );
    const now = c.publisherRevocations.map((r: any) => {
      requireFact(
        sameAddress(r.postsContract, p.posts.address) &&
          typeof r.publisher === "string" &&
          knownPublishers.has(lower(r.publisher)) &&
          !sameAddress(r.publisher, c.publisher) &&
          /^(0|[1-9][0-9]*)$/.test(r.fromBlock) &&
          BigInt(r.fromBlock) <= BigInt(log.blockNumber),
        "invalid_revocation",
      );
      return canonical(r);
    });
    requireFact(
      revocations.every((x) => now.includes(x)),
      "revocation_removed",
    );
    revocations.splice(0, revocations.length, ...now);
    knownPublishers.add(lower(c.publisher));
    configurations.set(revision, { value: c, log });
  }
  const latest = configurations.get(configurations.size)?.value;
  requireFact(latest, "configuration_history_missing");
  const state = snapshot.directoryState as any;
  requireFact(
    sameAddress(state.registry, p.registry) &&
      integer(state.configurationRevision) === configurations.size &&
      typeof latest.tld === "string" &&
      sha256(toHex(latest.tld)) === state.tldHash,
    "directory_state_changed",
  );
  for (const field of [
    "controller",
    "publisher",
    "operatorPayments",
    "learningRecords",
  ])
    requireFact(
      sameAddress(state.configuration?.[field], latest[field]),
      "directory_state_changed",
    );
  const lastLog = configurations.get(configurations.size)!.log;
  const lastEvent = decodeEventLog({
    abi: directoryAbi,
    eventName: "ConfigurationPublished",
    data: lastLog.data,
    topics: lastLog.topics,
    strict: true,
  }).args;
  requireFact(
    state.configuration?.uri === lastEvent.uri &&
      state.configuration?.sha256Digest === lastEvent.sha256Digest,
    "directory_document_changed",
  );
  const contracts = new Set(p.results.map((c) => lower(c.address)));
  for (const { value: c } of configurations.values())
    requireFact(
      c.learningRecords === `0x${"0".repeat(40)}` ||
        contracts.has(lower(c.learningRecords)),
      "unsupported_historical_result_contract",
    );
  const referenced = new Set(
    [...configurations.values()].map((c) => lower(c.value.learningRecords)),
  );
  requireFact(
    p.results.every((c) => referenced.has(lower(c.address))),
    "unconfigured_result_contract",
  );

  const posts: {
    log: RawLog;
    args: any;
    value?: Record<string, any>;
    problem?: string;
  }[] = [];
  for (const log of ordered(snapshot, p.posts.address)) {
    let event;
    try {
      event = decodeEventLog({
        abi: postsAbi,
        eventName: "PostRevisionPublished",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
    } catch {
      continue;
    }
    const a = event.args;
    if (a.communityId !== p.communityId || a.kind !== 0) continue;
    rawEvent(snapshot, log);
    const config = configurations.get(integer(a.configurationRevision));
    let value: Record<string, any> | undefined;
    let problem: string | undefined;
    try {
      requireFact(
        config && BigInt(config.log.blockNumber) <= BigInt(log.blockNumber),
        "post_configuration_missing",
      );
      requireFact(
        !latest.publisherRevocations.some(
          (r: any) =>
            sameAddress(r.postsContract, p.posts.address) &&
            sameAddress(r.publisher, config.value.publisher) &&
            BigInt(log.blockNumber) >= BigInt(r.fromBlock),
        ),
        "post_quarantined",
      );
      documentIpfs(a.manifestURI);
      value = publicDocument(
        snapshot,
        a.manifestURI,
        a.manifestSha256,
        1024 * 1024,
      );
      postDocument(value, config.value);
      requireFact(
        ["pirate.community-post/1", "pirate.community-post/2"].includes(
          value.schema,
        ) &&
          value.kind === "song" &&
          value.chainId === p.chainId &&
          sameAddress(value.postsContract, p.posts.address) &&
          value.communityId === p.communityId &&
          value.postId === a.postId &&
          value.authorId === a.authorId &&
          value.revision === integer(a.revision) &&
          value.configurationRevision === integer(a.configurationRevision) &&
          Array.isArray(value.media),
        "post_binding_changed",
      );
    } catch (error) {
      problem = String(error);
    }
    posts.push({ log, args: a, value, problem });
  }
  return (
    r: Header,
    manifest: Record<string, any>,
    outcomes: ReferenceSession["outcomes"] = [],
  ) => {
    requireFact(
      r.song.chainId === BigInt(p.chainId) &&
        r.song.communityId === p.communityId &&
        sameAddress(r.song.posts, p.posts.address),
      "foreign_song",
    );
    const songHash = keccak256(
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "address" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [r.song.chainId, r.song.posts, r.song.communityId, r.song.postId],
      ),
    );
    if (r.activity === 2) {
      studySource(r, manifest, outcomes);
      let problem = "reference_study_source_not_published";
      for (const post of posts.filter(
        (post) => post.args.postId === r.song.postId,
      )) {
        try {
          requireFact(
            post.value && !post.problem,
            "study_source_post_unavailable",
          );
          requireFact(
            BigInt(snapshot.blocks[post.log.blockNumber]!.timestamp) <=
              r.startedAt,
            "study_source_published_after_start",
          );
          const media = post.value.media.filter(
            (m: any) => m.role === "lyrics" && m.sha256 === r.contentRevision,
          );
          requireFact(
            media.length === 1 && typeof media[0].uri === "string",
            "study_source_lyrics_missing",
          );
          const published = publicDocument(
            snapshot,
            media[0].uri,
            r.contentRevision,
            media[0].byteLength,
          );
          requireFact(
            canonical(published) === canonical(manifest),
            "study_source_document_changed",
          );
          return songHash;
        } catch (error) {
          problem = String(error);
        }
      }
      throw Error(problem);
    }
    requireFact(
      manifest.manifestVersion === "pirate.karaoke.manifest/1" &&
        manifest.song &&
        manifest.song.chainId === p.chainId &&
        sameAddress(manifest.song.posts, r.song.posts) &&
        manifest.song.communityId === r.song.communityId &&
        manifest.song.postId === r.song.postId &&
        manifest.source &&
        hex32(manifest.source.lyricsSha256) &&
        Array.isArray(manifest.lines) &&
        manifest.lines.length === r.linesTotal,
      "manifest_binding_changed",
    );
    requireFact(manifest.songHash === songHash, "manifest_song_hash_changed");
    let lastProblem = "reference_source_not_published";
    for (const post of posts.filter((x) => x.args.postId === r.song.postId)) {
      try {
        requireFact(post.value && !post.problem, "source_post_unavailable");
        const sourceTime = BigInt(
          snapshot.blocks[post.log.blockNumber]!.timestamp,
        );
        requireFact(sourceTime <= r.startedAt, "source_published_after_start");
        const media = post.value.media.filter(
          (m: any) =>
            m.role === "lyrics" && m.sha256 === manifest.source.lyricsSha256,
        );
        requireFact(
          media.length === 1 && typeof media[0].uri === "string",
          "source_lyrics_missing",
        );
        const lyrics = publicDocument(
          snapshot,
          media[0].uri,
          media[0].sha256,
          media[0].byteLength,
        );
        const lines = fullLyrics(lyrics, r.song, manifest.source.lyricsSha256);
        requireFact(
          lyrics.revision === manifest.source.lyricsRevision,
          "lyric_revision_changed",
        );
        const expected = lines.filter((line) => !excludedCue(line.text));
        requireFact(
          expected.length === r.linesTotal,
          "shortened_source_manifest",
        );
        for (let i = 0; i < expected.length; i++) {
          const actual = manifest.lines[i],
            source = expected[i];
          requireFact(
            actual.ordinal === i + 1 &&
              actual.lineId === source.lineId &&
              actual.lineVersion === source.lineVersion &&
              actual.text === source.text,
            "manifest_occurrence_changed",
          );
        }
        return songHash;
      } catch (error) {
        lastProblem = String(error);
      }
    }
    throw Error(lastProblem);
  };
}
