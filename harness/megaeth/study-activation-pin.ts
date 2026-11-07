// Stable content-addressed journal: changing the execution window never adds again.
import { canonical, insist, object } from "../../packages/community/common.ts";
import type { TxStore } from "../../services/operator-tx.ts";
import {
  addPin,
  reconcilePin,
  type IpfsTransport,
} from "../../packages/community/ipfs.ts";
import {
  activationWindow,
  type StudyActivationProfile,
  type StudyActivationPlan,
} from "./study-activation-plan.ts";
export async function pinStudyActivation(
  p: StudyActivationProfile,
  plan: StudyActivationPlan,
  journal: TxStore,
  secret: () => Promise<string>,
  now: () => number,
  transport?: IpfsTransport,
) {
  activationWindow(p, now());
  const old = journal.get<unknown>("activation-pin");
  let saved = old === undefined ? undefined : object(old);
  if (saved)
    insist(
      canonical(saved.pin) === canonical(plan.pin) &&
        ["dispatched", "received", "retained"].includes(String(saved.state)),
      "study_activation_pin_journal_changed",
    );
  const token = await secret();
  activationWindow(p, now());
  if (saved) await reconcilePin(plan.pin, token, transport);
  else {
    saved = { pin: plan.pin, state: "dispatched" };
    journal.set("activation-pin", saved); // Before the only non-idempotent request.
    activationWindow(p, now());
    await addPin(
      plan.pin,
      plan.bytes,
      token,
      async (receipt) => {
        saved = { ...saved, pin: plan.pin, state: "received", receipt };
        journal.set("activation-pin", saved);
      },
      transport,
    );
  }
  journal.set("activation-pin", { ...saved, state: "retained" });
  return {
    uri: plan.pin.uri,
    sha256: plan.pin.sha256,
    state: "retained",
    maximumAdds: 1,
  };
}
