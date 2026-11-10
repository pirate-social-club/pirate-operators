import { telegramCheck, telegramId } from "../packages/telegram/contracts.ts";
import { decodeBase64url, equalSecret } from "../packages/telegram/security.ts";

export const TELEGRAM_OIDC_ISSUER = "https://oauth.telegram.org";
export interface TelegramOidcProvider {
  exchange(input: {
    requestId: string;
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<string>;
  /** Status lookup only. This cannot exchange an authorization code again. */
  recover?(requestId: string): Promise<string | null>;
  jwks(): Promise<JsonWebKey[]>;
}
function decoded(value: string): Record<string, unknown> {
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64url(value)),
  );
  telegramCheck(
    parsed && typeof parsed === "object" && !Array.isArray(parsed),
    "telegram_token_invalid",
    403,
  );
  return parsed;
}
/** Narrow RS256 profile. The keys come from the configured issuer port, never
 * jku/x5u in an untrusted header. No sub/username substitution for profile id. */
export async function verifyTelegramIdToken(input: {
  token: string;
  clientId: string;
  nonce: string;
  issuer?: string;
  now: number;
  keys: JsonWebKey[];
}) {
  telegramCheck(
    typeof input.token === "string" && input.token.length <= 16_384,
    "telegram_token_invalid",
    403,
  );
  const parts = input.token.split(".");
  telegramCheck(parts.length === 3, "telegram_token_invalid", 403);
  const header = decoded(parts[0]),
    claims = decoded(parts[1]);
  telegramCheck(
    header.alg === "RS256" &&
      typeof header.kid === "string" &&
      !header.crit &&
      !header.jku &&
      !header.x5u &&
      (header.typ === undefined || header.typ === "JWT"),
    "telegram_token_algorithm",
    403,
  );
  const matches = input.keys.filter(
    (key) => (key as JsonWebKey & { kid?: string }).kid === header.kid,
  );
  telegramCheck(matches.length === 1, "telegram_token_key", 403);
  const jwk = matches[0];
  telegramCheck(
    jwk.kty === "RSA" &&
      jwk.n &&
      jwk.e &&
      decodeBase64url(jwk.n).length >= 256 &&
      (!jwk.alg || jwk.alg === "RS256") &&
      (!jwk.use || jwk.use === "sig") &&
      (!jwk.key_ops || jwk.key_ops.includes("verify")),
    "telegram_token_key",
    403,
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    new Uint8Array(decodeBase64url(parts[2])),
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  telegramCheck(valid, "telegram_token_signature", 403);
  const nowS = Math.floor(input.now / 1000);
  telegramCheck(
    claims.iss === (input.issuer ?? TELEGRAM_OIDC_ISSUER),
    "telegram_token_issuer",
    403,
  );
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  telegramCheck(
    Array.isArray(audience) &&
      audience.length > 0 &&
      audience.every((v) => typeof v === "string") &&
      audience.includes(input.clientId) &&
      (audience.length === 1 || claims.azp === input.clientId),
    "telegram_token_audience",
    403,
  );
  telegramCheck(
    Number.isSafeInteger(claims.exp) &&
      Number(claims.exp) > nowS &&
      Number.isSafeInteger(claims.iat) &&
      Number(claims.iat) <= nowS + 30 &&
      Number(claims.exp) > Number(claims.iat) &&
      (claims.nbf === undefined ||
        (Number.isSafeInteger(claims.nbf) && Number(claims.nbf) <= nowS)),
    "telegram_token_expired",
    403,
  );
  telegramCheck(
    typeof claims.nonce === "string" &&
      (await equalSecret(claims.nonce, input.nonce)),
    "telegram_token_nonce",
    403,
  );
  telegramCheck(
    typeof claims.sub === "string" && claims.sub.length > 0,
    "telegram_token_subject",
    403,
  );
  return { telegramId: telegramId(claims.id), verifiedAt: input.now };
}
