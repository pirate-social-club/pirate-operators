import { createPublicClient, http, type Hex } from "viem";
import { requireDedicatedManagedSigner } from "../packages/release/managed-publishing-admission.ts";
import { canonical, exact, hashText, insist, object } from "../packages/community/common.ts";
import { httpsOrigin } from "../packages/community/manifest-core.ts";
import { parsePolicyDocument, policyDocument } from "../packages/community/hosted-enrollment.ts";
import { ownHostedSchemaContext, type HostedSchemaContext } from "../packages/community/hosted-enrollment-store.ts";
import type { HostedRuntime, HostedSigner } from "../packages/community/hosted-topup-chain.ts";

const stagingEnrollmentServiceOrigin = "https://pirate-web2-enrollment-staging.piratesocialclub.workers.dev";
const stagingApplicationOrigin = "https://staging.jazleeuw.club";

export interface HostedCommunityConfiguration {
  schema: "pirate.hosted-community-runtime/1";
  policy: ReturnType<typeof policyDocument>;
  rpcUrl: string;
  configurationGateway: string;
  schemaContext: HostedSchemaContext;
  stagingApplicationOrigin?: string;
}
export interface HostedCommunityEnv {
  DB: D1Database;
  HOSTED_COMMUNITY_PROFILE: "hosted-enrollment";
  HOSTED_COMMUNITY_CONFIGURATION_JSON: string;
  HOSTED_COMMUNITY_CONFIGURATION_SHA256: string;
  HOSTED_STAGING_APPLICATION_ORIGIN?: string;
  HOSTED_REGISTRAR_PRIVATE_KEY?: string;
  HOSTED_FUNDER_PRIVATE_KEY?: string;
}
export function hostedCommunityConfiguration(input: unknown): Readonly<HostedCommunityConfiguration> {
  const value = object(structuredClone(input));
  const hasStageOrigin = Object.hasOwn(value, "stagingApplicationOrigin");
  exact(value, [
    "schema", "policy", "rpcUrl", "configurationGateway", "schemaContext",
    ...(hasStageOrigin ? ["stagingApplicationOrigin"] : []),
  ]);
  insist(value.schema === "pirate.hosted-community-runtime/1", "hosted_configuration_unavailable", 503);
  const policy = parsePolicyDocument(value.policy);
  const applicationOrigin = hasStageOrigin ? httpsOrigin(value.stagingApplicationOrigin) : undefined;
  insist(
    policy.serviceOrigin !== stagingEnrollmentServiceOrigin || applicationOrigin === stagingApplicationOrigin,
    "hosted_staging_origin_required",
    503,
  );
  const endpoint = (raw: unknown, gateway: boolean) => {
    insist(typeof raw === "string" && raw.length <= 2048 && !/[\x00-\x20\x7f\u2028\u2029]/.test(raw), "hosted_transport_unavailable", 503);
    const url = new URL(raw);
    insist(!url.username && !url.password && !url.search && !url.hash && url.href === raw &&
      (url.protocol === "https:" || policy.deployment.chainId === 31337 && url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port) &&
      (!gateway || url.pathname.endsWith("/")), "hosted_transport_unavailable", 503);
    return raw;
  };
  return Object.freeze({ schema: "pirate.hosted-community-runtime/1", policy: Object.freeze(policyDocument(policy)),
    rpcUrl: endpoint(value.rpcUrl, false), configurationGateway: endpoint(value.configurationGateway, true),
    schemaContext: ownHostedSchemaContext(value.schemaContext),
    ...(applicationOrigin === undefined ? {} : { stagingApplicationOrigin: applicationOrigin }),
  });
}
/** Request-owned ports. Public role identity never requires a current effect key.
 * A role secret is decoded only to authorize an effect or sign, never returned or logged. */
export function configuredHostedRuntime(env: HostedCommunityEnv): HostedRuntime {
  insist(env.HOSTED_COMMUNITY_PROFILE === "hosted-enrollment" && typeof env.HOSTED_COMMUNITY_CONFIGURATION_JSON === "string" &&
    env.HOSTED_COMMUNITY_CONFIGURATION_JSON.length <= 256 * 1024 &&
    /^0x[0-9a-f]{64}(?![\s\S])/.test(env.HOSTED_COMMUNITY_CONFIGURATION_SHA256) &&
    hashText(env.HOSTED_COMMUNITY_CONFIGURATION_JSON) === env.HOSTED_COMMUNITY_CONFIGURATION_SHA256,
    "hosted_configuration_unavailable", 503);
  let config: Readonly<HostedCommunityConfiguration>;
  try { config = hostedCommunityConfiguration(JSON.parse(env.HOSTED_COMMUNITY_CONFIGURATION_JSON)); }
  catch { insist(false, "hosted_configuration_unavailable", 503); }
  insist(
    env.HOSTED_STAGING_APPLICATION_ORIGIN === config.stagingApplicationOrigin,
    "hosted_staging_origin_binding_changed",
    503,
  );
  const policy = parsePolicyDocument(config.policy);
  insist(env.DB && typeof env.DB.prepare === "function", "hosted_database_unavailable", 503);
  const effectSecret = (role: "registrar" | "funder") =>
    role === "registrar" ? env.HOSTED_REGISTRAR_PRIVATE_KEY : env.HOSTED_FUNDER_PRIVATE_KEY;
  const requireRoleSigner = (role: "registrar" | "funder", secret: string | undefined) => {
    insist(typeof secret === "string" && /^0x[0-9a-fA-F]{64}(?![\s\S])/.test(secret), "hosted_effect_key_unavailable", 503);
    const account = requireDedicatedManagedSigner(secret.toLowerCase() as Hex, config.rpcUrl);
    insist(account.address.toLowerCase() === policy[role], "hosted_effect_key_mismatch", 503);
    return account;
  };
  const signer = (role: "registrar" | "funder"): HostedSigner => Object.freeze<HostedSigner>({
    address: policy[role],
    async signTransaction(transaction) {
      const frozen = Object.freeze({ ...transaction });
      const secret = effectSecret(role);
      const raw = await requireRoleSigner(role, secret).signTransaction(frozen);
      insist(effectSecret(role) === secret &&
        env.HOSTED_COMMUNITY_CONFIGURATION_SHA256 === hashText(canonical(config)), "hosted_effect_binding_changed", 503);
      return raw;
    },
  });
  return { db: env.DB, policy, schemaContext: config.schemaContext,
    client: createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0, timeout: 10000, fetchOptions: { redirect: "manual" } }) }),
    now: () => Math.floor(Date.now() / 1000), registrar: signer("registrar"), funder: signer("funder"),
    ...(config.stagingApplicationOrigin === undefined ? {} : {
      stagingApplicationOrigin: config.stagingApplicationOrigin,
      assertRegistrarArmed: () => {
        const secret = effectSecret("registrar");
        insist(typeof secret === "string" && secret.length > 0, "hosted_registrar_disarmed", 503);
        requireRoleSigner("registrar", secret);
      },
    }),
    readConfiguration: async uri => {
      insist(/^ipfs:\/\/[a-zA-Z0-9]+(?![\s\S])/.test(uri) && uri.length <= 256, "configuration_pin_unavailable", 503);
      const url = new URL(uri.slice(7), config.configurationGateway);
      insist(url.href.startsWith(config.configurationGateway) && url.origin === new URL(config.configurationGateway).origin, "configuration_pin_unavailable", 503);
      const response = await fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(10000) });
      insist(response.ok, "configuration_pin_unavailable", 503);
      return response;
    } };
}
