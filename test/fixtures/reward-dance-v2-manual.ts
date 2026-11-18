/** Offline ABI/scripted RPC and persisted producer after-images. Run the actual
 * historical Posts verifier, V2 reader and manual ledger on in-memory SQLite.
 * The caller's real capture/command journal and chain are separately qualified. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { canonical, hashJson, hashText } from "../../packages/community/common.ts";
import type { Web2CommunityConfig } from "../../packages/community/web2-config-manifest.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import {
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../../packages/community/owner-policy.ts";
import { postsAbi } from "../../packages/community/post-chain.ts";
import { validatePost } from "../../packages/community/post-manifest.ts";
import { DANCE_PRIVATE_MEDIA_POLICY } from "../../packages/dance/contracts.ts";
import type { PublicationCaptureV2 } from "../../packages/dance/capture-v2.ts";
import { danceShapes } from "../../packages/dance-chain/v2/wire-shapes.ts";
import { preparePublicationGrant } from "../../packages/protocol/publication-consent.ts";
import type {
  ConsentSourceV1,
  GrantWireV1,
} from "../../packages/protocol/publication-runtime-v1.ts";
import type {
  RewardOfferInput,
  RewardsProfile,
} from "../../packages/rewards/contracts.ts";
import { rehearsalTerms } from "../../packages/rewards/rehearsal.ts";
import { RewardStore } from "../../packages/rewards/store.ts";
import type { PublicReadPorts } from "../../services/community-public.ts";
import { DANCE_HOST_INPUTS_SCHEMA_PROPOSAL } from "../../services/dance-account-facts-store.ts";
import { DANCE_PUBLICATION_BINDINGS_SCHEMA_PROPOSAL } from "../../services/dance-publication-journal.ts";
import {
  commandId,
  sourceId,
} from "../../services/publication-command-contract.ts";
import { MemorySqliteD1 } from "../dance-sqlite-fixture.ts";
import { rewardTestProfile } from "../manual-rewards-fixture.ts";
import {
  accountA,
  address,
  rewardDanceV2Fixture,
  word,
} from "./reward-dance-v2.ts";

type Fault =
  | "missing-capture"
  | "missing-binding"
  | "foreign-installation"
  | "pending-observation"
  | "missing-post";

export async function rewardDanceV2ManualFixture(t: TestContext) {
  const db = new MemorySqliteD1();
  t.after(() => db.close());
  db.sqlite.exec("CREATE TABLE setup_schema(version INTEGER)");
  for (const file of [
    "0002_first_song",
    "0011_manual_rewards",
    "0014_reward_closure_snapshots",
    "0016_dance",
    "0020_publication_consent",
  ])
    db.sqlite.exec(
      readFileSync(
        new URL(
          `../../apps/community-wizard/infra/migrations/${file}.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  for (const sql of DANCE_PUBLICATION_BINDINGS_SCHEMA_PROPOSAL)
    db.sqlite.exec(sql);
  db.sqlite.exec(DANCE_HOST_INPUTS_SCHEMA_PROPOSAL);

  const chain = rewardDanceV2Fixture(BigInt(Math.floor(Date.now() / 1000) + 3600));
  const { domain, pin, sourceHash } = chain.source;
  const profile: RewardsProfile = {
    ...rewardTestProfile,
    mode: "live-testnet",
    decimals: 18,
    rehearsal: {
      schema: "pirate.reward-rehearsal/1",
      offerId: chain.offer.offerId,
      prizeUsdcAtomic: "30000",
    },
  };
  const terms = rehearsalTerms(profile)!;
  const offer: RewardOfferInput = {
    ...chain.offer,
    drawingId: terms.drawingId,
    purchaseHash: terms.purchaseHash,
    ticketIds: terms.ticketIds,
  };
  const { resultSources: _pins, ...withoutPins } = offer;
  const installationId = word(5894);
  const historical: Web2CommunityConfig = {
    schema: "pirate.community-config/4",
    chainId: 6343,
    directory: pin.directory,
    postsContract: pin.posts,
    communityId: domain.communityId,
    communityKey: word(5895),
    installationId,
    configurationRevision: 1,
    controller: address(23),
    publisher: address(24),
    operatorPayments: profile.operatorWallet as Hex,
    learningRecords: pin.consentRegistry,
    app: { label: "Dance fixture", origin: "https://installed-reward.invalid" },
    feed: { endpoint: "https://fixture.invalid/feed", signingKeyId: "fixture" },
    policies: {
      admission: {
        version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH,
      },
      moderationSigner: address(22),
    },
    publisherRevocations: [],
  };
  const configuration = { ...historical, configurationRevision: 2 };
  for (const config of [historical, configuration]) {
    db.sqlite.prepare("INSERT INTO public_configurations VALUES(?,?,?,?,?,?,?,?,?)").run(
      config.communityId, config.configurationRevision, config.publisher, "offline-config-uri",
      hashJson(config), canonical(config), "10", word(5896), word(5897),
    );
  }
  const postBlock = chain.blocks.get(10n)!;
  const postTx = word(5891);
  postBlock.transactions.push(postTx);
  const audioBytes = new TextEncoder().encode("offline original audio fixture");
  const audio = await preparePin(audioBytes, "audio/mpeg");
  const post = validatePost({
    schema: "pirate.community-post/3",
    chainId: 6343,
    postsContract: pin.posts,
    communityId: domain.communityId,
    postId: word(14),
    authorId: word(5892),
    kind: "song",
    revision: 1,
    configurationRevision: 1,
    publishedAt: Number(postBlock.timestamp * 1000n),
    title: "Local rehearsal song",
    language: "und",
    rating: "general",
    media: [{ role: "audio", ...audio }],
    admission: {
      policyVersion: UNREGISTERED_OWNER_POLICY_VERSION,
      policySha256: UNREGISTERED_OWNER_POLICY_HASH,
      decision: "publish",
      rating: "general",
      coverDisplayed: false,
      evidenceSha256: word(5893),
      automatedContent: "deferred",
      declarationSource: "operator_declared",
    },
    registration: { status: "absent", reason: "deferred_for_launch" },
  });
  const manifestBytes = new TextEncoder().encode(canonical(post));
  const manifest = await preparePin(manifestBytes, "application/json");
  const args = {
    communityId: post.communityId,
    postId: post.postId,
    authorId: post.authorId,
    kind: 0,
    revision: 1n,
    configurationRevision: 1n,
    manifestSha256: manifest.sha256,
    manifestURI: manifest.uri,
  };
  const log = {
    address: pin.posts,
    blockNumber: postBlock.number,
    blockHash: postBlock.hash,
    transactionHash: postTx,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    args,
    topics: encodeEventTopics({
      abi: postsAbi,
      eventName: "PostRevisionPublished",
      args,
    }),
    data: encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "string" },
      ],
      [0, 1n, 1n, manifest.sha256, manifest.uri],
    ),
  };
  let fault: Fault | undefined;
  const client = new Proxy(chain.client, {
    get(target, property, receiver) {
      if (property === "getBlockNumber") return async () => chain.state.safeNumber + 1n;
      if (property === "getCode")
        return async (query: { address: Hex }) => chain.state.codes.get(query.address);
      if (property === "readContract")
        return async (query: { address: Hex; functionName: string; args?: [Hex, Hex] }) => {
          assert.equal(query.address, pin.posts);
          if (query.functionName === "directory") return pin.directory;
          assert.equal(query.functionName, "getPost");
          assert.deepEqual(query.args, [domain.communityId, post.postId]);
          return args;
        };
      if (property === "getLogs")
        return async (query: {
          address: Hex;
          fromBlock: bigint;
          toBlock: bigint;
        }) => {
          assert.equal(query.address, pin.posts);
          return fault !== "missing-post" &&
            query.fromBlock <= postBlock.number &&
            query.toBlock >= postBlock.number
            ? [log]
            : [];
        };
      if (property === "getTransactionReceipt")
        return async (query: { hash: Hex }) =>
          query.hash === postTx
            ? {
                status: "success",
                transactionHash: postTx,
                blockNumber: postBlock.number,
                blockHash: postBlock.hash,
                transactionHash: postTx,
                transactionIndex: 0,
                logs: [log],
              }
            : target.getTransactionReceipt(query);
      return Reflect.get(target, property, receiver);
    },
  });
  const reads = {
    client,
    profile: {
      address: pin.posts,
      runtimeCodeHash: pin.postsRuntimeHash,
      deploymentBlock: postBlock.number,
    },
    configurationHistory: async () => [historical, configuration],
    async transport(request) {
      const cid = new URL(request.url).pathname.split("/").at(-1);
      if (cid === manifest.uri.slice(7)) return new Response(manifestBytes);
      if (cid === audio.uri.slice(7)) return new Response(audioBytes);
      return new Response(null, { status: 404 });
    },
  } satisfies PublicReadPorts;
  const input = {
    db: db.asD1(),
    profile,
    reads,
    source: chain.source,
    installationId,
  };
  const store = new RewardStore(input.db, profile);
  const principal = { accountId: accountA, wallet: address(20) };
  db.sqlite
    .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
    .run(principal.accountId, word(5897), offer.opensAt);
  db.sqlite
    .prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)")
    .run(
      "fixture_binding",
      principal.accountId,
      principal.wallet,
      offer.opensAt,
    );

  const probe = "offline measured audio fixture";
  db.sqlite.prepare("INSERT INTO dance_host_song_keys VALUES(?,?,?)")
    .run(domain.communityId, offer.songKey, post.postId);
  db.sqlite.prepare("INSERT INTO dance_host_audio_probes VALUES(?,?,?,?,?)")
    .run(domain.communityId, audio.sha256, hashText(probe), 288000, probe);
  db.sqlite.prepare("INSERT INTO dance_host_selections VALUES(?,?, '', '', 1, ?)")
    .run(domain.communityId, offer.songKey, canonical({
      version: "pirate.dance-selected-song/1",
      postId: post.postId, songRevision: post.revision, manifestSha256: manifest.sha256,
      audioSha256: audio.sha256, songDurationSamples: 288000, probeEvidenceSha256: hashText(probe),
      startSample: 0, durationSamples: 288000, reference: null, offerProgramId: null, offer: null,
    }));

  let now = offer.opensAt - 1000;
  chain.state.safeNumber = 10n;
  function retainCapture(inputHash: string, broken?: Fault) {
    fault = broken;
    const source: ConsentSourceV1 = {
      schema: "pirate.publication-source/1",
      resultsVersion: 5,
      chainId: 6343,
      communityId: domain.communityId,
      installationId:
        broken === "foreign-installation" ? word(5898) : installationId,
      directory: pin.directory,
      directoryRuntimeHash: pin.directoryRuntimeHash,
      registry: pin.consentRegistry,
      registryRuntimeHash: pin.consentRegistryRuntimeHash,
      releaseSelectionSha256: word(5899),
    };
    const grant: GrantWireV1 = {
      learner: principal.wallet,
      communityId: domain.communityId,
      purpose: "dance-verdict",
      publicationTarget: domain.verifier,
      publicationTargetRuntimeHash: pin.runtimeCodeHash,
      permissionRevision: "1",
      policyHash: pin.learnerConsentPolicyHash,
      withdrawalEpoch: "0",
      nonce: word(5901),
      issuedAt: String(chain.baseS - 3n),
      validAfter: String(chain.baseS - 3n),
      expiresAt: String(chain.baseS + 90n),
      submitBefore: String(chain.baseS + 10n),
    };
    const { digest } = preparePublicationGrant(
      6343n,
      pin.consentRegistry,
      grant,
      "0x",
    );
    const verdict = chain.add({
      changeCapture(capture) {
        capture.song = {
          ...capture.song,
          manifestSha256: manifest.sha256,
          audioSha256: audio.sha256,
        };
        capture.offer = { ...capture.offer, inputHash: inputHash as Hex };
        capture.publicationGrantId = digest;
      },
    });
    if (broken === "missing-capture") return;
    const wire = verdict.capture;
    const requestId = "fixture_original_dance_grant";
    const command = {
      schema: "pirate.publication-command/1",
      commandId: commandId({
        source,
        accountId: principal.accountId,
        requestId,
        action: "grant",
        purpose: grant.purpose,
      }),
      requestId,
      accountId: principal.accountId,
      source,
      digest,
      preparedAtMs: offer.opensAt - 2000,
      localFenceGeneration: "1",
      action: "grant",
      message: grant,
    };
    const recordedAtS = String(chain.baseS - 1n);
    const observation = {
      schema: "pirate.publication-command-receipt/1",
      commandId: command.commandId,
      digest,
      action: command.action,
      purpose: grant.purpose,
      source,
      ...(broken === "pending-observation"
        ? { state: "pending", transactionHash: null }
        : {
            state: "recorded",
            transactionHash: word(5902),
            transactionIndex: 0,
            observed: {
              blockNumber: "10",
              blockHash: postBlock.hash,
              timestampS: recordedAtS,
            },
          }),
    };
    const binding = {
      schema: "pirate.bound-publication-grant/1",
      source,
      grantId: digest,
      grant,
      recordedAtS,
      boundAtS: String(chain.baseS),
      localFenceGeneration: command.localFenceGeneration,
    } as const;
    const capture: PublicationCaptureV2 = {
      version: "pirate.dance/2",
      captureId: wire.captureId,
      communityId: domain.communityId,
      learner: principal,
      songKey: offer.songKey,
      songRevision: 1,
      songDurationSamples: 288000,
      manifestSha256: manifest.sha256,
      audioSha256: audio.sha256,
      mediaPolicyVersion: DANCE_PRIVATE_MEDIA_POLICY.version,
      mediaPolicyHash: pin.mediaPolicySha256,
      reference: null,
      startSample: 0,
      durationSamples: 288000,
      policy: "moderator-review-policy-v2",
      rulesHash: pin.rulesSha256,
      termsHash: pin.termsSha256,
      rubricHash: pin.rubricSha256,
      rubricText: "Explicit rehearsal rubric",
      offer: {
        offerId: offer.offerId,
        offerIdCommitment: wire.offer.offerIdCommitment,
        inputHash,
        sourceHash,
        opensAtMs: offer.opensAt,
        cutoffAtMs: offer.cutoffAt,
      },
      reservedAtMs: offer.opensAt,
      expiresAtMs: offer.opensAt + 60000,
      captureHash: verdict.submission.captureHash,
      consent: null,
      publication: {
        kind: "publication-bound",
        publicationCommandId: command.commandId,
        binding,
      },
      canonical: {
        encoding: "pirate.dance-capture-abi/2",
        domain: { ...domain, chainId: "6343" },
        sourceHash,
        sourcePinAbi: encodeAbiParameters([danceShapes.sourcePin], [pin]),
        captureAbi: verdict.registration[0],
      },
      expected: {
        ownerEpoch: "1",
        configurationRevision: String(configuration.configurationRevision),
        rulesEpoch: "0",
        mediaEpoch: "0",
      },
    };
    db.sqlite
      .prepare("INSERT INTO dance_captures VALUES(?,?,?,?,?,?)")
      .run(
        capture.captureId,
        capture.communityId,
        principal.accountId,
        "fixture_capture",
        word(5903),
        JSON.stringify(capture),
      );
    db.sqlite.prepare("INSERT INTO dance_consents VALUES(?,?)").run(
      capture.captureId,
      canonical({
        accepted: true,
        version: "consent-fixture/2",
        termsHash: capture.termsHash,
        publicityPolicyHash: pin.publicityPolicyHash,
        receiptId: "fixture_consent",
        accountId: principal.accountId,
        captureId: capture.captureId,
        captureHash: capture.captureHash,
        acceptedAtMs: capture.reservedAtMs,
      }),
    );
    if (broken === "missing-binding") return;
    const headKey = [
      domain.communityId,
      principal.accountId,
      sourceId(source),
      grant.purpose,
    ] as const;
    const observationHash = hashJson(observation);
    db.sqlite
      .prepare("INSERT INTO publication_v1_heads VALUES(?,?,?,?,1,0,NULL)")
      .run(...headKey);
    db.sqlite
      .prepare(
        `INSERT INTO publication_v1_commands
      (command_id,community_id,account_id,source_id,purpose,action,request_id,request_hash,request_json,
        nonce_hex,fence_generation,phase,version,created_at,due_ms,typed_json,digest,signature,accepted_json,result_state,observation_hash)
      VALUES(?,?,?,?,?,'grant',?,?,?, ?,1,'accepted',1,?,0,?,?,?,?,?,?)`,
      )
      .run(
        command.commandId,
        ...headKey,
        requestId,
        word(5904),
        "{}",
        grant.nonce,
        command.preparedAtMs,
        canonical(command),
        digest,
        "0xab",
        "{}",
        observation.state,
        observationHash,
      );
    db.sqlite
      .prepare("INSERT INTO publication_v1_observations VALUES(?,?,?)")
      .run(command.commandId, observationHash, canonical(observation));
    db.sqlite
      .prepare("INSERT INTO dance_publication_bindings VALUES(?,?,?,?,?,?,?)")
      .run(
        domain.communityId,
        capture.captureId,
        capture.captureHash,
        principal.accountId,
        grant.purpose,
        command.commandId,
        canonical({
          schema: "pirate.dance-publication-binding/1",
          kind: "capture",
          captureId: capture.captureId,
          captureHash: capture.captureHash,
          accountId: principal.accountId,
          commandId: command.commandId,
          originalSha256: word(5905),
          receiptSha256: observationHash,
          boundAtMs: capture.reservedAtMs,
          configurationRevision: capture.expected.configurationRevision,
          ownerEpoch: capture.expected.ownerEpoch,
          actionHex: null,
          binding,
        }),
      );
    return capture;
  }
  function afterCutoff() {
    now = offer.cutoffAt;
    chain.state.safeNumber = 16n;
  }
  return {
    db,
    chain,
    input,
    offer,
    withoutPins,
    store,
    principal,
    configuration,
    post,
    now: () => now,
    retainCapture,
    afterCutoff,
  };
}
