// Separate, explicitly testnet operator stack. Existing community resources stay owned by their stack.
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { resolve } from "node:path";
import { encryptedLocalState } from "./encrypted-state.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const community = required("LEARNING_COMMUNITY_ID"),
  contract = required("LEARNING_RESULTS_CONTRACT");
if (
  !/^0x[0-9a-f]{64}$/.test(community) ||
  !/^0x[0-9a-f]{40}$/.test(contract) ||
  /^0x0+$/.test(contract)
)
  throw new Error("Invalid testnet deployment identity");
const values = {
  OPERATOR_PROFILE: "pirate-karaoke-testnet-v2",
  ROLE: "operator",
  LOCAL_ONLY: "disabled",
  PAYMENT_CHAIN_ID: "6343",
  SIGNATURE_CHAIN_ID: "6343",
  RPC_URL: "https://carrot.megaeth.com/rpc",
  SERVICE_MODE: "internal",
  COMMUNITY_ID: community,
  RESULTS_V2_CONTRACT: contract,
  ACCOUNT_DELEGATE: "0xf655611abe392f35cbb36181d920a302c4df2284",
  ACCOUNT_INITIALIZER: "0xdb03009c44a36a7490d80c9a9e1a03b53497dc42",
  ...(process.env.LEARNING_APPROVED_ACTIVATION_ACCOUNT
    ? {
        APPROVED_ACTIVATION_ACCOUNT:
          process.env.LEARNING_APPROVED_ACTIVATION_ACCOUNT,
      }
    : {}),
  OPERATOR_ADDRESS: required("LEARNING_GRADER_ADDRESS"),
  ISSUER: required("LEARNING_ISSUER_ADDRESS"),
  SPONSOR_CAP_WEI: required("LEARNING_SPONSOR_CAP_WEI"),
  SPONSOR_GAS_PRICE_WEI: required("LEARNING_GAS_PRICE_WEI"),
  SPONSOR_GAS_LIMIT: required("LEARNING_GAS_LIMIT"),
  SPONSOR_DATA_FEE_WEI: required("LEARNING_DATA_FEE_WEI"),
  SPEECH_DAILY_LIMIT: required("LEARNING_SPEECH_DAILY_LIMIT"),
  HISTORY_RETENTION_DAYS: "30",
  QUOTE_VALID_FROM: required("LEARNING_QUOTE_VALID_FROM"),
  QUOTE_VALID_UNTIL: required("LEARNING_QUOTE_VALID_UNTIL"),
};
export default Alchemy.Stack(
  "pirate-learning-testnet-v2",
  { providers: Cloudflare.providers(), state: encryptedLocalState() },
  Effect.gen(function* () {
    const app = yield* Cloudflare.Worker("Operator", {
      name: "pirate-learning-testnet-v2",
      main: resolve(
        import.meta.dirname,
        "../../../.local/learning-testnet/operator.mjs",
      ),
      bundle: false,
      compatibility: { date: "2026-11-06", flags: ["nodejs_compat"] },
      workersDev: { enabled: true, previewsEnabled: false },
      observability: {
        enabled: true,
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
      env: {
        ...values,
        PRIVATE_KEY: Config.Redacted("LEARNING_OPERATOR_PRIVATE_KEY"),
        ELEVENLABS_API_KEY: Config.Redacted("LEARNING_ELEVENLABS_API_KEY"),
        STATE: Cloudflare.DurableObject("STATE", {
          className: "ServiceState",
          storage: "sqlite",
        }),
        SPEECH_BUDGET: Cloudflare.DurableObject("SPEECH_BUDGET", {
          className: "SpeechBudget",
          storage: "sqlite",
        }),
      },
    });
    return {
      operatorOrigin: app.url,
      chainId: 6343,
      communityId: community,
      learningResults: contract,
    };
  }),
);
