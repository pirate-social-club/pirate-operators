// One frozen operation under the shared controller lease. No replacement sends.
import type { Hex, PublicClient } from "viem";
import { insist } from "../../packages/community/common.ts";
import type { TxStore } from "../../services/operator-tx.ts";
import { readControllerInventory } from "./controller-inventory.ts";
import type { StudyDeploymentArtifact } from "./study-deployment-artifact.ts";
import { readActivationReadiness } from "./study-activation-readiness.ts";
import { studyActivationSourceHash } from "./study-activation-source.ts";
import {
  studyActivationPlan,
  activationWindow,
  type StudyActivationOperation,
  type StudyActivationProfile,
} from "./study-activation-plan.ts";
import { observeStudyActivation } from "./study-activation-observation.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";
import {
  activationStatus,
  runActivationOperation,
  type ActivationTransaction,
} from "./configure-activation.ts";

export type StudyActivationTransaction = ActivationTransaction;
export const studyActivationStatus = (
  client: PublicClient,
  operation: StudyActivationOperation,
  stored?: StudyActivationTransaction,
) => activationStatus("study_activation", client, operation, stored);
export async function runStudyActivationOperation(
  client: PublicClient,
  profile: StudyActivationProfile,
  artifact: StudyDeploymentArtifact,
  operation: StudyActivationOperation,
  journal: TxStore,
  loadKey: () => Hex,
  beforeKey: (stored: StudyActivationTransaction) => void,
  now = () => Date.now(),
  transport?: IpfsTransport,
) {
  const plan = await studyActivationPlan(
    profile,
    artifact,
    studyActivationSourceHash(),
  );
  return runActivationOperation(
    {
      prefix: "study_activation",
      controller: profile.controller,
      maximumGasPriceWei: profile.maximumGasPriceWei,
      dataFeeReserveWei: profile.dataFeeReserveWei,
      expected: async () => plan.operation,
      observe: () =>
        observeStudyActivation(
          client,
          profile,
          artifact,
          plan,
          transport,
          false,
          true,
        ),
      inventory: (head) => readControllerInventory(client, profile, head),
      window: (at) => activationWindow(profile, at),
      ready: (at) => {
        readActivationReadiness(profile, at);
        insist(
          studyActivationSourceHash() === profile.sourceHash,
          "study_activation_source_changed",
        );
      },
    },
    client,
    operation,
    journal,
    loadKey,
    beforeKey,
    now,
  );
}
