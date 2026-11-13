// Read-only deployment diagnostics. Prints only public compatibility settings,
// binding names/types and the pinned public profile, never managed values.
import {
  cfLoginToken,
  operatorEnvironment,
  type OperatorOptions,
} from "../apps/community-wizard/server/operator.ts";
import {
  communityAccount,
  communityBase,
  communityPrefix,
} from "./community-package.ts";
import { insist, object } from "../packages/community/common.ts";
import { fetchWorkerModuleDigests } from "./worker-modules.ts";
import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyCommunitySuccessor } from "./community-state.ts";
import { qualifyCommunityConsumer } from "./community-consumer.ts";
import { reviewedPredecessor } from "./reviewed-update.ts";
let phase = "cloudflare";

const safe = operatorEnvironment(process.env),
  options: OperatorOptions = {
    directory: communityBase,
    projectId: "43d2261a-f739-428f-92f2-5f907db24c07",
    environment: "staging",
    secretPath: "/communities/first-song-20261105-runner",
    site: "https://app.infisical.com",
    profile: "",
    mode: "cf-login",
    cfProfile: "default",
    port: "8791",
    accountId: communityAccount,
    check: false,
  };
try {
  const token = await cfLoginToken(options, safe),
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${communityAccount}/workers/scripts/${communityPrefix}/settings`,
      {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
  insist(response.ok, "diagnostic_settings_unavailable");
  const result = object(object(await response.json()).result);
  console.log(
    JSON.stringify(
      {
        compatibilityDate: result.compatibility_date,
        compatibilityFlags: result.compatibility_flags,
        bindings: Array.isArray(result.bindings)
          ? result.bindings.map((raw) => {
              const b = object(raw);
              return {
                name: b.name,
                type: b.type,
                ...([
                  "CREATOR_PROFILE_HASH",
                  "APPLICATION_PROFILE_HASH",
                  "PLAN_ID",
                ].includes(String(b.name))
                  ? { value: b.text }
                  : {}),
              };
            })
          : [],
      },
      null,
      2,
    ),
  );
  console.log({
    modules: await fetchWorkerModuleDigests(
      token,
      communityAccount,
      communityPrefix,
      ["worker.mjs"],
    ),
  });
  phase = "existing_state_password";
  const sdk = await infisicalAuth().client(),
    secret = await sdk.secrets().getSecret({
      projectId: options.projectId,
      environment: "staging",
      secretPath: options.secretPath,
      secretName: "PIRATE_WIZARD_STATE_PASSWORD",
      includeImports: false,
      expandSecretReferences: false,
    });
  insist(
    secret.secretValue && secret.secretValue.length >= 32,
    "existing_state_password_unavailable",
  );
  console.log({ existingStatePassword: "available" });
  const candidate = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.application-plan.json",
      "utf8",
    ),
  );
  phase = "encrypted_state";
  const currentPackage = await verifyCommunitySuccessor(
    join(communityBase, "application-service"),
    candidate.profile,
    secret.secretValue,
  );
  await qualifyCommunityConsumer(
    join(communityBase, "application-service"),
    secret.secretValue,
    {
      ...safe,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: communityAccount,
    },
    true,
    undefined,
    {
      profileHash: candidate.profileHash,
      policy: candidate.profile.reviewedUpdate,
    },
  );
  console.log({
    encryptedState: "authenticated current identities",
    packageBinding: currentPackage.binding,
  });
  phase = "reviewed_predecessor";
  await reviewedPredecessor(
    join(communityBase, "application-service"),
    candidate,
  );
  console.log({ predecessor: "verified" });
} catch (error) {
  if (error instanceof Error) console.error(phase, error.name);
  console.error("community_readonly_diagnostic_failed");
  process.exitCode = 1;
}
