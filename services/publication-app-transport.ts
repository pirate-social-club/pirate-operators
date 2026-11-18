import type { PublicationInstallation } from "./publication-installed-selection.ts";
import { recoverMessageAddress, sha256, type Address, type Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  consentDigest,
  consentUint64,
} from "../packages/protocol/publication-consent.ts";
import type {
  PreparedConsentCommandV1,
  ConsentCommandReceiptV1,
} from "../packages/protocol/publication-runtime-v1.ts";
import { exact, record, same } from "./publication-command-contract.ts";
import type { CommandRow } from "./publication-command-store.ts";
import {
  publicationSelectionSource,
  type PublicationAppRelease,
} from "./publication-app-selection.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";

/** Managed signing capability. Root installs its existing issuer workflow;
 * this module never reads, serializes or exports a private key. */
export interface ManagedPublicationIssuer {
  readonly address: Address;
  signMessage(input: { message: string }): Promise<Hex>;
}
export function parsePublicationReceipt(
  value: unknown,
  c: PreparedConsentCommandV1,
): ConsentCommandReceiptV1 {
  const v = record(value);
  const base = [
    "schema",
    "commandId",
    "digest",
    "action",
    "purpose",
    "source",
    "transactionHash",
    "state",
  ];
  const observed = v.state === "recorded" || v.state === "reverted";
  const refused = v.state === "withheld" || v.state === "refused";
  exact(v, [
    ...base,
    ...(observed
      ? ["observed", "transactionIndex"]
      : refused
        ? ["reason"]
        : []),
  ]);
  check(
    v.schema === "pirate.publication-command-receipt/1" &&
      v.commandId === c.commandId &&
      v.digest === c.digest &&
      v.action === c.action &&
      v.purpose === c.message.purpose &&
      same(v.source, c.source) &&
      [
        "prepared",
        "queued",
        "pending",
        "unknown",
        "withheld",
        "refused",
        "recorded",
        "reverted",
      ].includes(v.state as string),
    "publication_operator_receipt_changed",
  );
  if (v.transactionHash !== null) consentDigest(v.transactionHash);
  if (refused)
    check(
      typeof v.reason === "string" &&
        v.reason.length > 0 &&
        v.reason.length <= 1024,
      "publication_operator_receipt_changed",
    );
  if (observed) {
    consentDigest(v.transactionHash);
    const o = record(v.observed);
    exact(o, ["blockNumber", "blockHash", "timestampS"]);
    consentDigest(o.blockHash);
    consentUint64(o.blockNumber);
    check(
      consentUint64(o.timestampS) > 0n &&
        typeof v.transactionIndex === "number" &&
        Number.isSafeInteger(v.transactionIndex) &&
        v.transactionIndex >= 0,
      "publication_operator_receipt_changed",
    );
  }
  return v as unknown as ConsentCommandReceiptV1;
}
/** Actual signed canonical HTTP client for the existing operator endpoints.
 * The URL is a service-binding routing URL, never a caller-controlled host. */
export type PublicationOperatorPath =
  | "/publication/v1/fence" | "/publication/v1/accept" | "/publication/v1/reconcile";
export type PublicationOperatorIdentity = Pick<CommandRow, "command_id" | "nonce_hex">;
export type PublicationOperatorReferenceExchange = (
  path: PublicationOperatorPath, row: PublicationOperatorIdentity, release: PublicationAppRelease,
  body: unknown, signal: AbortSignal,
) => Promise<unknown>;
type DirectTransport = {
  fetcher: Pick<Fetcher, "fetch">;
  signer: ManagedPublicationIssuer;
  clock: () => number;
  timeoutMs: number;
  maxResponseBytes: number;
  drainOnTimeout: boolean;
};
type ReferenceTransport = { exchange: PublicationOperatorReferenceExchange; timeoutMs: number };
export class PublicationOperatorTransport {
  private readonly transport: DirectTransport | ReferenceTransport;
  constructor(reference: ReferenceTransport);
  constructor(fetcher: Pick<Fetcher, "fetch">, signer: ManagedPublicationIssuer,
    clock: () => number, timeoutMs: number, maxResponseBytes: number, custody?: { drainOnTimeout: true });
  constructor(first: Pick<Fetcher, "fetch"> | ReferenceTransport, signer?: ManagedPublicationIssuer,
    clock?: () => number, timeoutMs?: number, maxResponseBytes?: number, custody?: { drainOnTimeout: true }) {
    if ("exchange" in first) {
      check(typeof first.exchange === "function" && Number.isSafeInteger(first.timeoutMs) &&
        first.timeoutMs > 0 && first.timeoutMs <= 30000, "publication_transport_bounds_invalid");
      this.transport = { ...first };
    } else {
      check(signer && clock && typeof timeoutMs === "number" && Number.isSafeInteger(timeoutMs) &&
        timeoutMs > 0 && timeoutMs <= 30000 && typeof maxResponseBytes === "number" &&
        Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= 32768,
        "publication_transport_bounds_invalid");
      this.transport = { fetcher: first, signer, clock, timeoutMs, maxResponseBytes,
        drainOnTimeout: custody?.drainOnTimeout === true };
    }
  }
  async request(
    path: PublicationOperatorPath,
    row: PublicationOperatorIdentity,
    release: PublicationAppRelease,
    body: unknown,
    installation?: PublicationInstallation,
  ) {
    const selected = this.transport;
    if ("exchange" in selected) {
      check(installation, "publication_installation_required");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("publication_operator_timeout"));
        }, selected.timeoutMs);
      });
      const observed = async () => {
        await installation.check();
        controller.signal.throwIfAborted();
        const value = await selected.exchange(path, row, release, body, controller.signal);
        await installation.check();
        controller.signal.throwIfAborted();
        return value;
      };
      try { return await Promise.race([observed(), deadline]); }
      finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
    const s = publicationSelectionSource(release),
      json = canonical(body),
      issuedAt = selected.clock();
    check(
      Number.isSafeInteger(issuedAt) &&
        issuedAt > 0 &&
        selected.signer.address.toLowerCase() === release.issuer,
      "publication_issuer_changed",
    );
    check(
      new TextEncoder().encode(json).length <= 32768,
      "publication_request_too_large",
    );
    const envelope = {
      schema: "pirate.publication.operator-request/1",
      method: "POST",
      path,
      chainId: s.chainId,
      communityId: s.communityId,
      installationId: s.installationId,
      sourceSha256: digest(s),
      operator: release.operator,
      issuedAt,
      expiresAt: issuedAt + 60,
      bodyHash: sha256(new TextEncoder().encode(json)),
      commandId: row.command_id,
      nonce: row.nonce_hex,
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("publication_operator_timeout"));
      }, selected.timeoutMs);
    });
    const operation = async () => {
      const signature = await selected.signer.signMessage({
        message: canonical(envelope),
      });
      check(
        /^0x[0-9a-f]{130}(?![\s\S])/.test(signature) &&
          (
            await recoverMessageAddress({
              message: canonical(envelope),
              signature,
            })
          ).toLowerCase() === release.issuer,
        "publication_issuer_changed",
      );
      const now = selected.clock();
      check(
        now >= issuedAt &&
          now < envelope.expiresAt &&
          !controller.signal.aborted,
        "publication_operator_request_expired",
      );
      await installation?.check();
      check(!controller.signal.aborted, "publication_operator_timeout");
      const response = await selected.fetcher.fetch(
        new Request("https://publication.internal" + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pirate-publication-authorization": canonical({
              request: envelope,
              signature,
            }),
          },
          body: json,
          signal: controller.signal,
          redirect: "error",
        }),
      );
      const bytes = await publicationResponseBytes(
        response,
        selected.maxResponseBytes,
      );
      const ended = selected.clock();
      check(
        ended >= now &&
          ended < envelope.expiresAt &&
          !controller.signal.aborted,
        "publication_operator_request_expired",
      );
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    };
    const pending = operation();
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      // The local host owns this in-process signer and handler. The deadline
      // fixes the request outcome, but its slot and teardown must also wait
      // for the original work, including a rejected late RPC or Store read.
      if (selected.drainOnTimeout) await pending.then(() => undefined, () => undefined);
    }
  }
}
