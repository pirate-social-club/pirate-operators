// Entry consumed by the Linux bootstrap owner. This creates no backend or
// credential fallback: all three real owning adapters/custody are required.
import { access, realpath, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import { createLinuxSetup } from "./linux-setup.ts";
import { createWizardServer } from "./http.ts";
import type {
  LinuxDeploymentPort,
  NamespaceAuthorityPort,
} from "./linux-contracts.ts";
export interface LinuxWizardCustody {
  // The Linux runtime owner supplies an actual exclusive process/state lease.
  // Expired/stale ownership must be reconciled by that owner, never guessed.
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
export async function createLinuxWizardRuntime(input: {
  directory: string;
  dist: string;
  backend: LinuxDeploymentPort;
  naming: NamespaceAuthorityPort;
  custody: LinuxWizardCustody;
  authorization: {
    authorize(
      request: IncomingMessage,
      action: "read" | "write",
    ): Promise<void>;
  };
}) {
  await input.custody.assertHeld();
  const directory = await realpath(resolve(input.directory));
  for (let parent = directory; ; parent = dirname(parent)) {
    const repository = await access(join(parent, ".git")).then(
      () => true,
      () => false,
    );
    if (repository)
      throw new Error(
        "Use an owned private wizard state directory outside Git repositories.",
      );
    if (dirname(parent) === parent) break;
  }
  const setup = await createLinuxSetup(directory, input.backend, input.naming);
  // No Cloudflare account/API token, provider password or Infisical login is
  // manufactured to start a Linux-only browser runner.
  const server = createWizardServer(
    undefined,
    input.dist,
    { infisical: false, cloudflare: false },
    {
      linux: setup,
      authorizeLinux: async (request, action) => {
        await input.custody.assertHeld();
        await input.authorization.authorize(request, action);
      },
    },
  );
  // Bind only loopback. The owning bootstrap may offer an authenticated SSH
  // tunnel; publishing this unauthenticated setup listener is unsupported.
  const listen = async (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid loopback port");
    await input.custody.assertHeld();
    await readFile(join(input.dist, "index.html"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  };
  let closed = false;
  return {
    server,
    setup,
    listen,
    async close() {
      if (closed) return;
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      setup.cancel();
      await setup.settled();
      const state = setup.snapshot();
      if (
        (state.operation && state.operation.custody !== "cleared") ||
        state.secretRequest ||
        state.uploadRequest || state.namespaceRequest
      )
        throw new Error(
          "The original claim remains held. Reconcile actual custody and pending writes before releasing this runner.",
        );
      await input.custody.release();
      closed = true;
    },
  };
}
