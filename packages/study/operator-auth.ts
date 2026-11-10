// Community-to-operator authority uses the existing ticket signer, never a new key.
import { recoverMessageAddress, sha256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, check } from "../protocol/index.ts";

export const STUDY_AUTH_HEADER = "x-pirate-study-authorization";
export type StudyOperatorPath =
  | "/study/bind"
  | "/study/terminal"
  | "/study/speech"
  | "/study/speech/status";
export interface StudyOperatorAuthority {
  chainId: 31337 | 6343;
  communityId: Hex;
  operator: Address;
  contract: Address;
}
export interface StudyAuthorization extends StudyOperatorAuthority {
  schema: "pirate.study.operator-request/1";
  path: StudyOperatorPath;
  method: "POST";
  issuedAt: number;
  expiresAt: number;
  bodyHash: Hex;
  parameters: Record<string, unknown>;
}
export async function authorizeStudyRequest(
  authority: StudyOperatorAuthority,
  path: StudyOperatorPath,
  bytes: Uint8Array,
  parameters: Record<string, unknown>,
  privateKey: Hex,
  nowS: number,
) {
  const request: StudyAuthorization = {
    ...authority,
    schema: "pirate.study.operator-request/1",
    path,
    method: "POST",
    issuedAt: nowS,
    expiresAt: nowS + 60,
    bodyHash: sha256(bytes),
    parameters,
  };
  return JSON.stringify({
    request,
    signature: await privateKeyToAccount(privateKey).signMessage({
      message: canonical(request),
    }),
  });
}
/** Authenticate before reading audio; its exact digest is verified separately. */
export async function verifyStudyAuthorization(
  request: Request,
  authority: StudyOperatorAuthority,
  issuer: Address,
  nowS: number,
): Promise<StudyAuthorization> {
  const raw = request.headers.get(STUDY_AUTH_HEADER);
  check(raw && raw.length <= 4096, "study_authorization_required");
  const signed = JSON.parse(raw) as {
      request: StudyAuthorization;
      signature: Hex;
    },
    a = signed.request;
  check(
    a &&
      typeof a === "object" &&
      a.schema === "pirate.study.operator-request/1" &&
      a.method === "POST" &&
      request.method === a.method &&
      [
        "/study/bind",
        "/study/terminal",
        "/study/speech",
        "/study/speech/status",
      ].includes(a.path) &&
      new URL(request.url).pathname === a.path &&
      a.chainId === authority.chainId &&
      a.communityId === authority.communityId &&
      a.operator?.toLowerCase() === authority.operator.toLowerCase() &&
      a.contract?.toLowerCase() === authority.contract.toLowerCase() &&
      Number.isSafeInteger(a.issuedAt) &&
      Number.isSafeInteger(a.expiresAt) &&
      a.expiresAt > nowS &&
      a.issuedAt <= nowS + 5 &&
      a.issuedAt <= a.expiresAt &&
      a.expiresAt - a.issuedAt === 60 &&
      /^0x[0-9a-f]{64}$/.test(a.bodyHash) &&
      a.parameters &&
      typeof a.parameters === "object" &&
      !Array.isArray(a.parameters),
    "invalid_study_authorization",
  );
  check(
    (
      await recoverMessageAddress({
        message: canonical(a),
        signature: signed.signature,
      })
    ).toLowerCase() === issuer.toLowerCase(),
    "invalid_study_authorization",
  );
  return a;
}
