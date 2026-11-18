import { insist } from "../packages/community/common.ts";
import { openNativePublicationApplication, reuseNativePublicationApplication } from "./linux-web2-publication.ts";
import { installedDanceParticipants } from "./web2-installed-dance-participants.ts";
import {
  openInstalledPublicDance,
  type InstalledPublicDanceMount,
  type NativeInstalledDanceAuthority,
} from "./web2-installed-public-dance.ts";

type Input = Parameters<typeof openInstalledPublicDance>[0];
/** The native install owns the verified scope and both retained command IDs.
 * Workerd owns the read of the two exact accepted application grant originals. */
export type InstalledDanceOwnerScope = Omit<NativeInstalledDanceAuthority, "participants"> & {
  readonly grants: Parameters<typeof installedDanceParticipants>[1];
};

export async function openInstalledDanceOrdinary(
  input: Omit<Input, "authority"> & { scope?: InstalledDanceOwnerScope },
): Promise<InstalledPublicDanceMount> {
  const { scope } = input;
  insist(scope && typeof scope.assertCurrent === "function" && scope.grants?.length === 2,
    "dance_installed_authority_unavailable", 503);
  const { env, deployment, reads, reward, publication } = input;
  insist(scope.attachmentDigest === reward.attachmentDigest && scope.configHash === reward.configurationHash,
    "dance_installed_authority_changed", 503);
  await scope.assertCurrent();
  const selected = publication
    ? await reuseNativePublicationApplication(env, deployment, publication)
    : (await openNativePublicationApplication(env, deployment, reads.client)).publication;
  const current = scope.assertCurrent.bind(scope);
  const participants = await installedDanceParticipants(selected, scope.grants, current);
  await current();
  return openInstalledPublicDance({
    ...input, publication: selected,
    authority: {
      attachmentDigest: scope.attachmentDigest,
      releaseSelectionHash: scope.releaseSelectionHash,
      configHash: scope.configHash,
      owner: scope.owner,
      policy: scope.policy,
      participants,
      actionOriginals: scope.actionOriginals,
      assertCurrent: current,
    },
  });
}

export type InstalledDanceOwnerScopeReader = (
  selected: Readonly<Pick<Input, "deployment" | "config" | "reward">>,
) => Promise<InstalledDanceOwnerScope | undefined>;
