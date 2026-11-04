import {
  check,
  digest,
  inputHashes,
  sign,
  type Song,
  type Evidence,
  type Signed,
} from "../packages/protocol/index.ts";
import type { SignedPurchase } from "../packages/protocol/payments.ts";
import { karaokeRoute } from "./karaoke.ts";
import { acceptPurchase } from "./purchases.ts";
import { body, type Env, type Store, signatureChainId } from "./runtime.ts";

export async function operator(
  request: Request,
  env: Env,
  store: Store,
  ctx: DurableObjectState,
) {
  const url = new URL(request.url);
  if (url.pathname === "/admit") {
    // docs/operator-payments.md section 4: one redeemed purchase per revision.
    const { song, purchase } = await body<{ song: Song; purchase: SignedPurchase }>(request);
    check(
      song.communityId === env.COMMUNITY_ID &&
        typeof song.audio === "string" &&
        typeof song.lyrics === "string" &&
        typeof song.title === "string" &&
        typeof song.artwork === "string",
      "invalid_song",
    );
    const jobId = digest({ kind: "admission", song });
    const old = store.get<Signed<Evidence>[]>(`admission:${jobId}`);
    if (old) return Response.json(old);
    await acceptPurchase(env, store, purchase, { kind: "admission", jobId });
    const evidence = await Promise.all(
      Object.entries(inputHashes(song)).map(([input, inputHash]) =>
        sign(
          "evidence",
          {
            communityId: song.communityId,
            check: input,
            inputHash,
            outcome: input === "audio" ? "no_match" : "allow",
            expiresAt: store.now() + 3600,
          },
          env.PRIVATE_KEY,
          signatureChainId(env),
        ),
      ),
    );
    store.set(`admission:${jobId}`, evidence);
    return Response.json(evidence);
  }
  const karaoke = await karaokeRoute(request, env, store, ctx);
  return karaoke ?? new Response("not_found", { status: 404 });
}
