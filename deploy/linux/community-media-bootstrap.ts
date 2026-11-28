import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createCommunityMediaStorage,
  type CommunityMediaStorage,
} from "./community-media-storage.ts";
import { privateDirectory, type OperationLease } from "./backend-state.ts";
import type { createManagedKeyClient } from "./managed-key-channel.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";

/** Packaged construction of the community media credential vault for the
 * backend's wizard factory. The backend owns the key channel, the operation
 * lease and the installation identity; this module owns the directory
 * convention and the lifecycle shape so every packaged backend wires the
 * vault the same way. The symmetric key itself must already exist in the key
 * agent under the given reference — provisioning it is a bootstrap decision,
 * never something this path fabricates. */
export async function openCommunityMediaVault(input: {
  /** Private state root the installation already owns, e.g. the wizard state
   * directory. The vault lives in a dedicated child created mode 0700. */
  stateRoot: string;
  lease: OperationLease;
  channel: Awaited<ReturnType<typeof createManagedKeyClient>>;
  keyRef: string;
  keyGeneration: number;
  installationId: string;
  send?: IpfsTransport;
}): Promise<CommunityMediaStorage> {
  const root = resolve(input.stateRoot);
  await privateDirectory(root);
  const directory = resolve(root, "community-media-vault");
  await mkdir(directory, { mode: 0o700, recursive: false }).catch(
    (error: { code?: string }) => {
      if (error?.code !== "EEXIST") throw error;
    },
  );
  await privateDirectory(directory);
  return createCommunityMediaStorage({
    directory,
    lease: input.lease,
    channel: input.channel,
    keyRef: input.keyRef,
    keyGeneration: input.keyGeneration,
    installationId: input.installationId,
    ...(input.send ? { send: input.send } : {}),
  });
}
