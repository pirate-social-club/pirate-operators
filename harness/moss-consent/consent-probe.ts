// The MOSS consent probe's checks (docs/learning-records-contract.md section
// 9): build a LearningRecords Consent for a learner, then classify a returned
// signature (plain, ERC-6492 or ERC-8010), verify it over the MegaETH RPC and
// simulate openAttempt as the grader would send it. Nothing here sends a
// transaction.
import {
  encodeFunctionData,
  isErc6492Signature,
  isErc8010Signature,
  keccak256,
  parseErc8010Signature,
  size,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { check } from "../../packages/protocol/index.ts";
import {
  ACTIVITY_KARAOKE,
  CONSENT_LIFETIME_S,
  consentMessage,
  consentTypes,
  recordsAbi,
  recordsDomain,
  scoringPolicyOf,
  songKeyOf,
  standInSong,
  type Consent,
} from "../../packages/protocol/records.ts";

export const RPC = "https://carrot.megaeth.com/rpc";
export const RECORDS = "0x0eae432258c5954cf3d06e707acb3490a2f20a12" as Address;
/** The deployed LearningRecords' karaoke grader. */
export const OPERATOR = "0x14B90A55657D9695A727254EAec5E0e32D20d602" as Address;
/** The plain message signed first, as the creator spike's sign-in did. */
export const MESSAGE = "Pirate MOSS consent probe: message check. This authorizes nothing.";
// The four-line fixture manifest's root (fixtures/learning-records-v1.json).
const LINES_ROOT = "0x307f78ef4bd386a2dec53316e75f678f689bb009e935b531f2f0fe44ae632c07" as Hex;
export const song = standInSong(6343, "moss-consent-probe", keccak256(stringToBytes("moss-consent-probe-song")));

export async function consentFor(chain: PublicClient, learner: Address): Promise<Consent> {
  check(/^0x[0-9a-fA-F]{40}$/.test(learner), "invalid_address");
  const now = Number((await chain.getBlock()).timestamp);
  return {
    learner,
    attemptId: keccak256(stringToBytes(`moss-consent-probe:${learner}:${now}`)),
    songKey: songKeyOf(song),
    contentRevision: keccak256(stringToBytes("moss-consent-probe-manifest")),
    linesRoot: LINES_ROOT,
    linesTotal: 4,
    activity: ACTIVITY_KARAOKE,
    grader: OPERATOR,
    scoringPolicy: scoringPolicyOf(5),
    expiresAt: now + CONSENT_LIFETIME_S,
  };
}
/** The consent as JSON carries it: expiresAt as a decimal string. */
export const consentJson = (c: Consent) => ({ ...c, expiresAt: String(c.expiresAt) });
export function consentFromJson(value: Record<string, unknown>): Consent {
  const c = { ...value, expiresAt: Number(value.expiresAt) } as unknown as Consent;
  check(
    c.grader === OPERATOR && c.linesRoot === LINES_ROOT && c.songKey === songKeyOf(song) && Number.isSafeInteger(c.expiresAt),
    "not_a_probe_consent",
  );
  return c;
}

const describe = (signature: Hex) => {
  const erc8010 = isErc8010Signature(signature);
  const wrapped = erc8010 ? parseErc8010Signature(signature) : undefined;
  return {
    bytes: size(signature),
    hash: keccak256(signature),
    erc6492: isErc6492Signature(signature),
    erc8010,
    erc8010Parts:
      wrapped && "authorization" in wrapped && wrapped.authorization
        ? {
            delegate: wrapped.authorization.address,
            authorizationChainId: wrapped.authorization.chainId,
            authorizationNonce: wrapped.authorization.nonce,
            initializer: wrapped.address ?? null,
            initDataBytes: wrapped.data ? size(wrapped.data) : 0,
            innerSignatureBytes: size(wrapped.signature),
          }
        : null,
    inner: wrapped?.signature,
  };
};
const reason = (error: Error) =>
  /reverted with the following reason:\s*(\S+)/.exec(error.message)?.[1] ?? error.message.split("\n")[0];

/** What each signature is, whether the RPC accepts it, and what openAttempt would do with it today. */
export async function analyse(chain: PublicClient, consent: Consent, signature: Hex, messageSignature?: Hex) {
  const consentSig = describe(signature);
  const simulate = (sig: Hex) =>
    chain
      .call({
        account: OPERATOR,
        to: RECORDS,
        data: encodeFunctionData({
          abi: recordsAbi,
          functionName: "openAttempt",
          args: [consentMessage(consent), sig, { ...song, chainId: 6343n }],
        }),
      })
      .then(() => "would_succeed")
      .catch((error: Error) => `reverts: ${reason(error)}`);
  const { inner, ...consentShape } = consentSig;
  return {
    learner: consent.learner,
    learnerCode: (await chain.getCode({ address: consent.learner })) ?? "0x",
    message: messageSignature
      ? {
          ...(({ inner: _inner, ...rest }) => rest)(describe(messageSignature)),
          verifiedOverRpc: await chain
            .verifyMessage({ address: consent.learner, message: MESSAGE, signature: messageSignature })
            .catch((error: Error) => `error: ${reason(error)}`),
        }
      : null,
    consent: {
      ...consentShape,
      verifiedOverRpc: await chain
        .verifyTypedData({
          address: consent.learner,
          domain: recordsDomain(6343, RECORDS),
          types: consentTypes,
          primaryType: "Consent",
          message: consentMessage(consent),
          signature,
        })
        .catch((error: Error) => `error: ${reason(error)}`),
      openAttemptAsSigned: await simulate(signature),
      openAttemptWithInnerSignature: inner ? await simulate(inner) : null,
    },
  };
}
