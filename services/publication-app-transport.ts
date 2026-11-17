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
export class PublicationOperatorTransport {
  private readonly fetcher: Pick<Fetcher, "fetch">;
  private readonly signer: ManagedPublicationIssuer;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(
    fetcher: Pick<Fetcher, "fetch">,
    signer: ManagedPublicationIssuer,
    clock: () => number,
    timeoutMs: number,
    maxResponseBytes: number,
  ) {
    check(
      Number.isSafeInteger(timeoutMs) &&
        timeoutMs > 0 &&
        timeoutMs <= 30000 &&
        Number.isSafeInteger(maxResponseBytes) &&
        maxResponseBytes > 0 &&
        maxResponseBytes <= 32768,
      "publication_transport_bounds_invalid",
    );
    this.fetcher = fetcher;
    this.signer = signer;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }
  async request(
    path:
      | "/publication/v1/fence"
      | "/publication/v1/accept"
      | "/publication/v1/reconcile",
    row: CommandRow,
    release: PublicationAppRelease,
    body: unknown,
  ) {
    const s = publicationSelectionSource(release),
      json = canonical(body),
      issuedAt = this.clock();
    check(
      Number.isSafeInteger(issuedAt) &&
        issuedAt > 0 &&
        this.signer.address.toLowerCase() === release.issuer,
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
      }, this.timeoutMs);
    });
    const operation = async () => {
      const signature = await this.signer.signMessage({
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
      const now = this.clock();
      check(
        now >= issuedAt &&
          now < envelope.expiresAt &&
          !controller.signal.aborted,
        "publication_operator_request_expired",
      );
      const response = await this.fetcher.fetch(
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
        this.maxResponseBytes,
      );
      const ended = this.clock();
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
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
}
