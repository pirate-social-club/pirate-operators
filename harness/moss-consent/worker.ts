// The MOSS consent probe as a temporary Worker on HTTPS, served the way the
// creator spike's working page is. Deploy with harness/moss-consent/deploy.ts;
// delete the Worker once the signature is captured. It sends no transaction.
import { createPublicClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { consentTypes, recordsDomain } from "../../packages/protocol/records.ts";
import { MESSAGE, RECORDS, RPC, analyse, consentFor, consentFromJson, consentJson } from "./consent-probe.ts";

/** The page, with the MOSS SDK bundled in, injected at build time. */
declare const PROBE_PAGE: string;

const megaeth = defineChain({
  id: 6343,
  name: "MegaETH testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/")
        return new Response(PROBE_PAGE, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            // As the creator spike: MOSS's wallet frame may use passkeys here.
            "Permissions-Policy":
              'publickey-credentials-create=(self "https://account.megaeth.com"), publickey-credentials-get=(self "https://account.megaeth.com")',
          },
        });
      if (request.method !== "POST") return json({ error: "not_found" }, 404);
      const text = await request.text();
      if (text.length > 70000) return json({ error: "request_too_large" }, 413);
      const body = JSON.parse(text) as Record<string, unknown>;
      const chain = createPublicClient({ chain: megaeth, transport: http(RPC, { timeout: 15_000 }) }) as PublicClient;
      if (url.pathname === "/consent-request") {
        const consent = await consentFor(chain, body.address as `0x${string}`);
        return json({ domain: recordsDomain(6343, RECORDS), types: consentTypes, message: consentJson(consent), messageToSign: MESSAGE });
      }
      if (url.pathname === "/analyse") {
        const consent = consentFromJson(body.consent as Record<string, unknown>);
        const signature = body.signature as Hex;
        const messageSignature = body.messageSignature as Hex | undefined;
        const analysis = await analyse(chain, consent, signature, messageSignature);
        return json({ kind: "moss-consent-probe", recordedAt: new Date().toISOString(), records: RECORDS, analysis, consent: consentJson(consent), signature, messageSignature });
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
};
