import { communityOrigin, walletOrigin, rpId, hash } from "./shared.ts";
import {
  HttpError,
  insist,
  jsonBody,
  session,
  credential,
  record,
  type Env,
} from "./server/store.ts";
import * as auth from "./server/auth.ts";
import * as activation from "./server/activation.ts";
import * as signing from "./server/signing.ts";
import {
  retainedActivation,
  retainActivation,
} from "./server/activation-recovery.ts";
import {
  clients,
  ikaType,
  operatorAddress,
  verifyWallet,
} from "./server/chain.ts";
import {
  communityConnection,
  scopedConnectionInfo,
} from "./server/community-connection.ts";

const communityRoutes = new Set([
  "/api/auth/challenge",
  "/api/auth/verify",
  "/api/launch",
  "/api/exchange",
  "/api/logout",
]);
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      isWallet = url.origin === walletOrigin;
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": isWallet
        ? "no-referrer"
        : "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": `publickey-credentials-create=(self${isWallet ? "" : ' "https://account.megaeth.com"'}), publickey-credentials-get=(self${isWallet ? "" : ' "https://account.megaeth.com"'})`,
      "Content-Security-Policy": `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://fullnode.testnet.sui.io https://carrot.megaeth.com https://*.megaeth.com; frame-src ${isWallet ? "'none'" : "https://*.megaeth.com"}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
    });
    try {
      insist(url.origin === communityOrigin || isWallet, "unknown_origin", 404);
      if (!url.pathname.startsWith("/api/")) {
        const response = await env.ASSETS.fetch(request);
        const assetHeaders = new Headers(response.headers);
        for (const [key, value] of headers) assetHeaders.set(key, value);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: assetHeaders,
        });
      }
      let result: Record<string, unknown>;
      if (request.method === "GET" && url.pathname === "/api/health") {
        insist(
          typeof env.NATIVE_PROFILE_HASH === "string" &&
            /^0x[0-9a-f]{64}$/.test(env.NATIVE_PROFILE_HASH),
          "native_profile_unavailable",
          503,
        );
        result = {
          service: "pirate-native-creator/1",
          profileHash: env.NATIVE_PROFILE_HASH,
          testnet: true,
        };
      } else if (
        isWallet &&
        request.method === "POST" &&
        ["/api/communities/launch", "/api/communities/exchange"].includes(
          url.pathname,
        )
      ) {
        result = await communityConnection(
          env,
          url.pathname.endsWith("/launch")
            ? "creator_launch"
            : "creator_exchange",
          await jsonBody(request),
        );
      } else if (
        isWallet &&
        request.method === "GET" &&
        url.pathname === "/api/connection"
      ) {
        const id = url.searchParams.get("request") ?? "";
        insist(
          /^[A-Za-z0-9_-]{43}$|^[a-f0-9]{64}$/.test(id),
          "invalid_connection",
        );
        result = (await scopedConnectionInfo(env, id)) ?? {
          scoped: false,
          communityOrigin,
        };
      } else if (request.method === "GET" && url.pathname === "/api/config") {
        result = {
          communityOrigin,
          walletOrigin,
          rpId,
          operatorAddress,
          testnet: true,
        };
      } else if (request.method === "GET" && url.pathname === "/api/session") {
        const s = await session(
          request,
          env,
          isWallet ? "creator" : "community",
        );
        if (isWallet)
          result = { wallet: record(await credential(env, s.account)) };
        else {
          const binding = await env.DB.prepare(
            "SELECT c.evm_address,c.dwallet_id,c.sui_address FROM bindings b JOIN credentials c ON c.id=b.credential_id WHERE b.account=?",
          )
            .bind(s.account)
            .first();
          result = { address: s.account, creator: binding };
        }
      } else if (
        request.method === "GET" &&
        url.pathname === "/api/readiness"
      ) {
        const { sui } = clients();
        const [s, i] = await Promise.all([
          sui.getBalance({ owner: operatorAddress }),
          sui.getBalance({ owner: operatorAddress, coinType: ikaType }),
        ]);
        const ready =
          !!env.SUI_OPERATOR_SECRET_KEY &&
          BigInt(s.balance.balance) >= 600_000_000n &&
          BigInt(i.balance.balance) >= 22_000_000_000n;
        result = {
          ready,
          reason: ready
            ? null
            : "The test operator is waiting for testnet funding.",
          sui: s.balance.balance,
          ika: i.balance.balance,
        };
      } else {
        insist(request.method === "POST", "method_not_allowed", 405);
        insist(
          request.headers.get("origin") === url.origin &&
            (!request.headers.has("sec-fetch-site") ||
              request.headers.get("sec-fetch-site") === "same-origin"),
          "cross_origin_write_rejected",
          403,
        );
        insist(
          isWallet !== communityRoutes.has(url.pathname),
          "route_not_available",
          404,
        );
        const body = await jsonBody(request);
        switch (url.pathname) {
          case "/api/auth/challenge":
            result = await auth.mossChallenge(env, body);
            break;
          case "/api/auth/verify":
            result = await auth.mossVerify(env, body);
            break;
          case "/api/launch":
            result = await auth.launch(request, env, body);
            break;
          case "/api/exchange":
            result = await auth.exchange(request, env, body);
            break;
          case "/api/passkey/options":
            result = await auth.passkeyOptions(env, body);
            break;
          case "/api/passkey/register":
            result = await auth.registerPasskey(env, body);
            break;
          case "/api/passkey/authenticate":
            result = await auth.authenticatePasskey(env, body);
            break;
          case "/api/activation/reserve":
            result = await activation.reserve(request, env, body);
            break;
          case "/api/activation/dkg":
            result = await activation.dkg(request, env, body);
            break;
          case "/api/activation/recovery": {
            const { row } = await activation.context(request, env, body);
            const attempt = await activation.currentAttempt(env, row);
            result = {
              recovery:
                body.recovery === undefined
                  ? await retainedActivation(env, attempt.id, row.id)
                  : await retainActivation(
                      env,
                      attempt.id,
                      row.id,
                      body.recovery,
                    ),
            };
            break;
          }
          case "/api/activation/accept":
            result = await activation.activate(request, env, body);
            break;
          case "/api/activation/status": {
            const { row } = await activation.context(request, env, body);
            const a = await activation.currentAttempt(env, row);
            result = await activation.activationStatus(env, row, a);
            break;
          }
          case "/api/finish":
            result = await activation.finish(request, env, body);
            break;
          case "/api/sign/start":
            result = await signing.startSign(request, env, body);
            break;
          case "/api/sign/prepare":
            result = await signing.prepareSign(request, env, body);
            break;
          case "/api/sign/execute":
            result = await signing.executeSign(request, env, body);
            break;
          case "/api/sign/status":
            result = await signing.signStatus(request, env, body);
            break;
          case "/api/logout": {
            const s = await session(request, env, "community");
            await env.DB.prepare("DELETE FROM sessions WHERE hash=?")
              .bind(s.hash)
              .run();
            result = {
              cookie:
                "__Host-community_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
            };
            break;
          }
          default:
            throw new HttpError(404, "not_found");
        }
      }
      if (typeof result.cookie === "string") {
        headers.set("Set-Cookie", result.cookie);
        delete result.cookie;
      }
      return Response.json(result, { headers });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      // Provider errors can include request payloads. Never log bodies, tokens,
      // signatures, credentials, ciphertext, or operator key material.
      const code =
        error instanceof HttpError
          ? error.message
          : "service_unavailable_retry_same_step";
      if (env.LOCAL_TEST_DIAGNOSTICS === "true" && error instanceof Error)
        console.error(
          error.name,
          error.message
            .slice(0, 1800)
            .replaceAll(/[A-Za-z0-9_+/=-]{64,}/g, "[long value omitted]"),
        );
      return Response.json({ error: code }, { status, headers });
    }
  },
} satisfies ExportedHandler<Env>;
