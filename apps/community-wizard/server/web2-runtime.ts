import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import { insist } from "../../../packages/community/common.ts";
import { createWizardServer } from "./http.ts";
import { createWeb2Setup, type Web2SetupInputs } from "./web2-setup.ts";

/** The Linux bootstrap supplies real policy, pin transport, custody and pairing.
 * No provider, installer, credentials or successful capability is fabricated. */
export async function createWeb2WizardRuntime(
  input: Web2SetupInputs & {
    directory: string;
    dist: string;
    /** Borrowed guard only. The persistent service retains and releases its lease. */
    custody: { assertHeld(): Promise<void> };
    authorization: {
      authorize(
        request: IncomingMessage,
        action: "read" | "write",
      ): Promise<void>;
    };
  },
) {
  await input.custody.assertHeld();
  const directory = await realpath(resolve(input.directory));
  for (let parent = directory; ; parent = dirname(parent)) {
    if (
      await access(join(parent, ".git")).then(
        () => true,
        () => false,
      )
    )
      throw new Error(
        "Use a private Web2 wizard state directory outside Git repositories.",
      );
    if (dirname(parent) === parent) break;
  }
  const setup = await createWeb2Setup(directory, input);
  const server = createWizardServer(
    undefined,
    input.dist,
    { infisical: false, cloudflare: false },
    {
      web2: setup,
      authorizeWeb2: async (request, action) => {
        await input.custody.assertHeld();
        await input.authorization.authorize(request, action);
        insist(!input.pairingOnly || action === "read", "web2_pairing_only", 403);
      },
    },
  );
  let closed = false;
  return {
    server,
    setup,
    async listen(port: number) {
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
    },
    async close() {
      if (closed) return;
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await setup.settled();
      // Closing a paired browser runner detaches it. The Linux service owns the
      // persistent host and its own lifecycle; do not stop it or discard work.
      closed = true;
    },
  };
}
