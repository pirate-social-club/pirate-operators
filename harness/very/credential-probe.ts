import { parseArgs } from "node:util";
import { Probe } from "./probe.ts";
import { serveProbe } from "./server.ts";
import { hostedProvider } from "./transport.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      "app-id": { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm run very:probe -- --live --app-id <existing-public-app-id> [--port <loopback-port>]",
    );
    return;
  }
  if (
    !values.live ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      values["app-id"] ?? "",
    )
  )
    throw new Error("live_mode_and_public_app_id_required");
  const server = await serveProbe(
    new Probe(hostedProvider(), values["app-id"]!, "live"),
    values.port === undefined ? 0 : Number(values.port),
  );
  console.log(`Very diagnostic: ${server.url}`);
  console.log(
    "Use one existing enrollment for all four requests. No provider request occurs until Start. No reward attestation or funds. This process stops after 30 minutes.",
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    await server.close();
  };
  const timer = setTimeout(() => void stop(), 30 * 60_000);
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch(() => {
  // Deliberately exclude CLI values and provider errors from logs.
  console.error(
    "Probe could not start. Use --help for the required public app ID and live flag.",
  );
  process.exitCode = 1;
});
