import {
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { canonical, check } from "../packages/protocol/index.ts";
import { hashText } from "../packages/community/common.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import {
  directoryV3Abi,
  parseWeb2ProfileDocument,
  web2Binding,
} from "../packages/community/web2-directory.ts";
import { assertWeb2Origin } from "../packages/community/web2-config-manifest.ts";
import type { Web2EligibilityPolicy } from "../packages/community/web2-directory-reader.ts";
import {
  learningResultsV5Abi,
  learningResultsV5Build,
  learningResultsV5RuntimeTemplate,
} from "../packages/protocol/generated/learning-results-v5.ts";
import { publicationConsentAbi } from "../packages/protocol/generated/publication-consent-v1.ts";
import {
  consentUint64,
  type PublicationPurpose,
} from "../packages/protocol/publication-consent.ts";
import { preparedCall } from "./publication-command-contract.ts";
import type { PreparedConsentCommandV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { PublicationRequestSession } from "./publication-app-request.ts";
import {
  publicationSelectionSource,
  type PublicationAppRelease,
} from "./publication-app-selection.ts";

function acceptedRegistryCode(code: Hex) {
  check(
    (code.length - 2) / 2 === learningResultsV5Build.runtimeBytes,
    "publication_registry_build_changed",
  );
  let actual = code.slice(2),
    template = learningResultsV5RuntimeTemplate.slice(2);
  for (const references of Object.values(
    learningResultsV5Build.immutableReferences,
  )) {
    for (const { start, length } of references) {
      const zero = "0".repeat(length * 2),
        offset = start * 2;
      actual =
        actual.slice(0, offset) + zero + actual.slice(offset + length * 2);
      template =
        template.slice(0, offset) + zero + template.slice(offset + length * 2);
    }
  }
  check(actual === template, "publication_registry_build_changed");
}
/** Generated ABI reads at one canonical EIP-1898 hash. A retained withdrawal
 * intentionally omits current Directory/descriptor eligibility. */
export async function publicationPolicyRead(input: {
  client: PublicClient;
  release: PublicationAppRelease;
  learner: Address;
  purpose: PublicationPurpose;
  mode: "grant" | "withdraw";
  clock: Web2EligibilityPolicy;
  session: PublicationRequestSession;
}) {
  const { client, session } = input,
    release = structuredClone(input.release),
    s = publicationSelectionSource(release);
  check(
    session instanceof PublicationRequestSession,
    "publication_request_session_required",
  );
  const purpose = input.purpose,
    learner = input.learner,
    mode = input.mode;
  const clock = { ...input.clock },
    rpc = danceReadPort(client);
  check(
    typeof clock.now === "function" &&
      typeof clock.maxSafeBlockAgeSeconds === "bigint" &&
      clock.maxSafeBlockAgeSeconds >= 0n &&
      clock.maxSafeBlockAgeSeconds < 2n ** 64n,
    "publication_freshness_required",
  );
  let last = clock.now();
  check(typeof last === "bigint" && last >= 0n, "publication_clock_invalid");
  const waited = async <T>(p: Promise<T>): Promise<T> => {
    const value = await p;
    await session.check();
    return value;
  };
  check(
    (await waited(rpc.chainId())) === s.chainId,
    "publication_chain_changed",
  );
  const a = await waited(rpc.safe()),
    at = { blockHash: a.hash, requireCanonical: true as const };
  const fresh = () => {
    const now = clock.now();
    check(
      typeof now === "bigint" &&
        now >= last &&
        now >= a.timestamp &&
        now - a.timestamp <= clock.maxSafeBlockAgeSeconds,
      "publication_source_stale",
    );
    last = now;
    return now;
  };
  check(a.timestamp > 0n, "publication_source_unconfirmed");
  fresh();
  const r = { address: s.registry, abi: learningResultsV5Abi, ...at } as const;
  const [rv, cv, community, directory, dh, code, epoch] = await waited(
    Promise.all([
      client.readContract({ ...r, functionName: "VERSION" }),
      client.readContract({ ...r, functionName: "consentVersion" }),
      client.readContract({ ...r, functionName: "communityId" }),
      client.readContract({ ...r, functionName: "directory" }),
      client.readContract({ ...r, functionName: "directoryRuntimeHash" }),
      danceReadPort(client, a).code(s.registry, a.number),
      client.readContract({
        address: s.registry,
        abi: publicationConsentAbi,
        functionName: "withdrawalEpoch",
        args: [learner, keccak256(stringToHex(purpose))],
        ...at,
      }),
    ]),
  );
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  check(
    rv === 5 &&
      cv === 1 &&
      community === s.communityId &&
      eq(directory, s.directory) &&
      dh === s.directoryRuntimeHash &&
      code &&
      keccak256(code) === s.registryRuntimeHash,
    "publication_runtime_source_changed",
  );
  acceptedRegistryCode(code);
  fresh();
  let descriptor: PublicationAppRelease["policies"][PublicationPurpose];
  if (mode === "grant") {
    const p = parseWeb2ProfileDocument(release.profile),
      c = release.configuration;
    check(a.number >= p.deploymentBlock, "publication_source_unconfirmed");
    const q = {
      address: s.directory,
      abi: directoryV3Abi,
      args: [s.communityId],
      ...at,
    } as const;
    const selected = release.policies[purpose];
    check(selected, "publication_purpose_disabled");
    const [row, binding, origin, dc, targetCode, tuple] = await waited(
      Promise.all([
        client.readContract({ ...q, functionName: "getCommunity" }),
        client.readContract({ ...q, functionName: "getBinding" }),
        client.readContract({ ...q, functionName: "getOrigin" }),
        danceReadPort(client, a).code(s.directory, a.number),
        danceReadPort(client, a).code(selected.target, a.number),
        client.readContract({
          address: s.registry,
          abi: publicationConsentAbi,
          functionName: "purpose",
          args: [keccak256(stringToHex(purpose))],
          ...at,
        }),
      ]),
    );
    check(
      dc &&
        keccak256(dc) === s.directoryRuntimeHash &&
        c.learningRecords === s.registry &&
        row.configurationRevision === BigInt(c.configurationRevision) &&
        row.configuration.sha256Digest === hashText(canonical(c)) &&
        eq(row.configuration.controller, c.controller) &&
        eq(row.configuration.publisher, c.publisher) &&
        eq(row.configuration.learningRecords, s.registry) &&
        canonical(binding) === canonical(web2Binding(p)),
      "publication_directory_changed",
    );
    assertWeb2Origin(c, origin);
    const [revision, d] = tuple;
    check(
      d.enabled &&
        revision === consentUint64(selected.permissionRevision) &&
        eq(d.target, selected.target) &&
        d.runtimeHash === selected.runtimeHash &&
        d.policyHash === selected.policyHash &&
        d.maxGrantDurationSeconds ===
          consentUint64(selected.maxGrantDurationSeconds) &&
        d.maxSubmissionDelaySeconds ===
          consentUint64(selected.maxSubmissionDelaySeconds) &&
        targetCode &&
        keccak256(targetCode) === selected.runtimeHash,
      "publication_descriptor_changed",
    );
    descriptor = selected;
  }
  const finish = async () => {
    const [end, chain] = await waited(
      Promise.all([rpc.block(a.number), rpc.chainId()]),
    );
    check(
      chain === s.chainId &&
        end.number === a.number &&
        end.hash === a.hash &&
        end.timestamp === a.timestamp,
      "publication_anchor_changed",
    );
    fresh();
  };
  await finish();
  return {
    source: s,
    anchor: a,
    at,
    epoch,
    descriptor,
    finish,
    async simulate(command: PreparedConsentCommandV1, signature: Hex) {
      check(
        canonical(command.source) === canonical(s) &&
          command.message.learner === learner &&
          command.message.purpose === purpose &&
          command.action === mode,
        "publication_simulation_changed",
      );
      const prepared = preparedCall(command, signature);
      // The actual operator is msg.sender; a withdrawal cannot bypass the
      // signature branch by simulating with learner as sender.
      await waited(
        client.call({
          account: release.operator,
          to: s.registry,
          data: prepared.data,
          ...at,
        }),
      );
      await finish();
    },
  };
}
