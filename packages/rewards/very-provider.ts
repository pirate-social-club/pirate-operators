import { boundSubject } from "./very-proof.ts";
import { hostedProvider } from "./very-transport.ts";
import type { RewardVerificationProvider } from "./contracts.ts";

/** No credential/palm data is accepted from a browser callback. Poll the encrypted provider session. */
export function rewardVeryProvider(
  fetcher: typeof fetch = fetch,
): RewardVerificationProvider {
  const hosted = hostedProvider(fetcher);
  return {
    async open(appId, scope, challenge, key, expiresAt) {
      const session = await hosted.open(
        appId,
        scope,
        challenge,
        Buffer.from(key),
        expiresAt,
      );
      return {
        id: session.id,
        launchUrl: `veros://verify?${new URLSearchParams({ sessionId: session.id, key: Buffer.from(key).toString("base64"), action: "verify" })}`,
      };
    },
    async subject(id, key, scope, challenge, expiresAt) {
      const proof = await hosted.poll({ id }, Buffer.from(key));
      if (proof === null) return null;
      const subject = boundSubject(proof, scope, challenge, expiresAt);
      await hosted.verify(proof);
      return subject;
    },
  };
}
