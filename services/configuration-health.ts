import { sha256 } from "viem";
import {
  preparePin,
  readBounded,
  publicGateways,
} from "../packages/community/ipfs.ts";
import { CommunityError } from "../packages/community/common.ts";

// Fixed public configuration only. No arbitrary URL, credential, user content,
// raw upstream body or caller headers can enter this diagnostic.
const reference = {
  uri: "ipfs://bafkreiabsnyic5vcde6vn37d3ljdpwqyxbyaqgjrkwqmbw4o545i6hpqfy",
  sha256: "0x0193708176a2193d56efe3dad237da18b87008193155a0c0db8eef3a8f1df02e",
};
export async function configurationHealth() {
  return Promise.all(
    publicGateways.map(async (gateway) => {
      let stage = "request";
      try {
        const response = await fetch(
          gateway + "/ipfs/" + reference.uri.slice(7),
          {
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
            headers: { "cache-control": "no-cache" },
          },
        );
        const status = response.status,
          contentType =
            response.headers.get("content-type")?.slice(0, 256) ?? null;
        if (!response.ok) return { gateway, status, contentType };
        stage = "body";
        const bytes = await readBounded(response, 65536);
        const digest = sha256(bytes);
        stage = "cid";
        const pin = await preparePin(bytes, "application/json");
        return {
          gateway,
          status,
          contentType,
          byteLength: bytes.length,
          sha256: digest,
          uri: pin.uri,
          matches: pin.uri === reference.uri && digest === reference.sha256,
        };
      } catch (error) {
        return {
          gateway,
          stage,
          error:
            error instanceof CommunityError
              ? error.code
              : "gateway_unavailable",
        };
      }
    }),
  );
}
