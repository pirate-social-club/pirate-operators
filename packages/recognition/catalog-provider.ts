import { sha256 } from "viem";
import { bytes32, insist, object } from "../community/common.ts";
import {
  providerFetch,
  providerJson,
  providerRequest,
  type ProviderResponse,
  type ProviderTransport,
} from "../moderation/provider-http.ts";
import {
  type CatalogFile,
  type CatalogLookup,
  type RecognitionCatalog,
  type Recording,
} from "./model.ts";

export interface CatalogProviderOptions {
  namespace: string;
  origin: string;
  bucketId: string;
  token: string;
  transport?: ProviderTransport;
  received(
    kind: "lookup" | "upload" | "delete",
    recording: Recording,
    receipt: ProviderResponse,
  ): Promise<void>;
}
/** Fresh release catalog only. No bucket discovery, provisioning, import or fallback. */
export function acrCatalog(
  options: CatalogProviderOptions,
): RecognitionCatalog {
  const namespace = bytes32(options.namespace),
    origin = new URL(options.origin);
  insist(
    origin.protocol === "https:" &&
      origin.origin === options.origin &&
      ["api-v2.acrcloud.com", "us-api-v2.acrcloud.com"].includes(
        origin.hostname,
      ) &&
      /^[1-9][0-9]*$/.test(options.bucketId) &&
      options.token.length >= 8,
    "recognition_catalog_unconfigured",
    503,
  );
  const base = `${origin.origin}/api/buckets/${options.bucketId}/files`,
    title = (r: Recording) => `pirate-${r.recording_id.slice(2)}`;
  const send = async (
    kind: "lookup" | "upload" | "delete",
    r: Recording,
    url: string,
    method: string,
    signal: AbortSignal,
    beforeSend: () => Promise<void>,
    body?: FormData,
  ) => {
    insist(r.namespace === namespace, "recognition_namespace_mismatch", 403);
    const request = new Request(url, {
      method,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body,
    });
    return providerRequest(
      request,
      {
        async request(req) {
          await beforeSend();
          signal.throwIfAborted();
          return (options.transport ?? providerFetch).request(req);
        },
      },
      (receipt) => options.received(kind, r, receipt),
    );
  };
  const decode = (r: Recording, input: unknown): CatalogFile => {
    const v = object(input),
      meta = object(v.user_defined);
    insist(
      v.title === title(r) &&
        String(v.bucket_id) === options.bucketId &&
        meta.namespace === namespace &&
        meta.recording_id === r.recording_id &&
        meta.audio_sha256 === r.audio_sha256 &&
        /^[1-9][0-9]*$/.test(String(v.id)) &&
        typeof v.acr_id === "string" &&
        v.acr_id.length > 0 &&
        v.acr_id.length <= 512 &&
        (v.state === -1 || v.state === 0 || v.state === 1),
      "recognition_catalog_record_invalid",
      503,
    );
    return {
      namespace,
      recordingId: r.recording_id,
      audioSha256: r.audio_sha256,
      fileId: String(v.id),
      matchId: v.acr_id,
      state: v.state === 1 ? "ready" : v.state === 0 ? "processing" : "error",
    };
  };
  return {
    async find(r, signal, beforeSend): Promise<CatalogLookup> {
      const url = new URL(base);
      url.search = new URLSearchParams({
        search: title(r),
        page: "1",
        per_page: "3",
        sort: "id",
        order: "asc",
      }).toString();
      const response = await send(
        "lookup",
        r,
        url.href,
        "GET",
        signal,
        beforeSend,
      );
      if (response.status === 429 || response.status >= 500)
        return { outcome: "retryable" };
      const data = providerJson(response),
        rows = data.data;
      insist(Array.isArray(rows), "recognition_catalog_listing_invalid", 503);
      const meta = data.meta === undefined ? null : object(data.meta),
        links = data.links === undefined ? null : object(data.links);
      if (
        rows.length >= 3 ||
        data.next_page_url ||
        links?.next ||
        (typeof meta?.last_page === "number" && meta.last_page > 1) ||
        (typeof data.last_page === "number" && data.last_page > 1)
      )
        return { outcome: "ambiguous" };
      const exact = rows.filter((v) => object(v).title === title(r));
      if (exact.length === 0) return { outcome: "none" };
      if (exact.length !== 1) return { outcome: "ambiguous" };
      return { outcome: "exact", file: decode(r, exact[0]) };
    },
    async upload(r, audio, signal, beforeSend) {
      insist(
        audio.byteLength === r.audio_bytes && sha256(audio) === r.audio_sha256,
        "recognition_audio_changed",
        409,
      );
      const body = new FormData();
      body.set("title", title(r));
      body.set("data_type", "audio");
      body.set(
        "user_defined",
        JSON.stringify({
          namespace,
          recording_id: r.recording_id,
          audio_sha256: r.audio_sha256,
        }),
      );
      body.set(
        "file",
        new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }),
        "recording.mp3",
      );
      // Any exception after durable intent, including a lost receipt, stays unknown.
      const response = await send(
        "upload",
        r,
        base,
        "POST",
        signal,
        beforeSend,
        body,
      );
      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status)
      )
        return { outcome: "rejected" };
      if (response.status < 200 || response.status >= 300)
        return { outcome: "unknown" };
      return {
        outcome: "accepted",
        file: decode(r, providerJson(response).data),
      };
    },
    async remove(r, signal, beforeSend) {
      insist(
        r.state === "deleting" &&
          r.provider_file_id &&
          /^[1-9][0-9]*$/.test(r.provider_file_id),
        "recognition_delete_identity_missing",
        409,
      );
      const response = await send(
        "delete",
        r,
        `${base}/${r.provider_file_id}`,
        "DELETE",
        signal,
        beforeSend,
      );
      return response.status === 404 ||
        (response.status >= 200 && response.status < 300)
        ? "deleted"
        : "unknown";
    },
  };
}
