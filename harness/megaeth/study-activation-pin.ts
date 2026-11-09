// Stable content-addressed journal: changing the execution window never adds again.
import type { TxStore } from "../../services/operator-tx.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";
import {
  activationWindow,
  type StudyActivationProfile,
  type StudyActivationPlan,
} from "./study-activation-plan.ts";
import { pinActivationManifest } from "./configure-activation.ts";
export const pinStudyActivation = (
  p: StudyActivationProfile,
  plan: StudyActivationPlan,
  journal: TxStore,
  secret: () => Promise<string>,
  now: () => number,
  transport?: IpfsTransport,
) =>
  pinActivationManifest(
    "study_activation",
    (at) => activationWindow(p, at),
    plan,
    journal,
    secret,
    now,
    transport,
  );
