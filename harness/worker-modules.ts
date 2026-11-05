import { insist } from "../packages/community/common.ts";
import { fileDigest } from "./creator-state.ts";

/** Hash raw multipart fields without FormData's UTF-8 decoding. Cloudflare
 * returns binary module fields without filenames, which FormData treats as text. */
export function workerModuleDigests(
  bytes: Uint8Array,
  contentType: string,
  expectedNames: readonly string[] = ["index.js", "ika.wasm"],
) {
  insist(
    expectedNames.length > 0 &&
      expectedNames.every((n) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(n)),
    "invalid_expected_worker_modules",
    503,
  );
  if (!contentType.startsWith("multipart/"))
    return { [expectedNames[0]!]: fileDigest(bytes) };
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType),
    boundary = match?.[1] ?? match?.[2];
  insist(
    boundary && /^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(boundary),
    "invalid_worker_multipart_boundary",
    503,
  );
  const data = Buffer.from(bytes),
    marker = Buffer.from(`--${boundary}`),
    separator = Buffer.from(`\r\n--${boundary}`),
    modules: Record<string, string> = {};
  insist(
    data.subarray(0, marker.length).equals(marker),
    "invalid_worker_multipart_prefix",
    503,
  );
  let cursor = marker.length,
    parts = 0;
  for (;;) {
    if (data.subarray(cursor, cursor + 2).toString() === "--") {
      insist(
        data.subarray(cursor + 2).length === 0 ||
          data.subarray(cursor + 2).equals(Buffer.from("\r\n")),
        "invalid_worker_multipart_suffix",
        503,
      );
      insist(Object.keys(modules).length > 0, "worker_modules_missing", 503);
      return modules;
    }
    insist(
      ++parts <= expectedNames.length + 1 &&
        data.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n")),
      "invalid_worker_multipart_part",
      503,
    );
    const start = cursor + 2,
      headerEnd = data.indexOf("\r\n\r\n", start);
    insist(
      headerEnd >= start && headerEnd - start <= 8192,
      "invalid_worker_multipart_headers",
      503,
    );
    const headers = data.subarray(start, headerEnd).toString("latin1"),
      name = /(?:^|\r\n)content-disposition:[^\r\n]*;\s*name="([^"]+)"/i.exec(
        headers,
      )?.[1],
      bodyStart = headerEnd + 4,
      end = data.indexOf(separator, bodyStart);
    insist(
      name && end >= bodyStart && !/content-transfer-encoding:/i.test(headers),
      "invalid_worker_module_encoding",
      503,
    );
    if (name !== "metadata") {
      insist(
        expectedNames.includes(name) && !(name in modules),
        "unexpected_worker_module",
        503,
      );
      modules[name] = fileDigest(data.subarray(bodyStart, end));
    }
    cursor = end + 2 + marker.length;
  }
}

/** Read-only script download; caller admits the owned account/name before use.
 * Only digests escape this function. Runtime binding values are not requested. */
export async function fetchWorkerModuleDigests(
  token: string,
  accountId: string,
  name: string,
  expectedNames: readonly string[],
) {
  insist(
    /^[a-f0-9]{32}$/.test(accountId) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name),
    "invalid_worker_download_target",
    503,
  );
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    },
  );
  insist(response.ok && response.body, "worker_download_failed", 503);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16 * 1024 * 1024) {
        await reader.cancel();
        insist(false, "worker_download_too_large", 503);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return workerModuleDigests(
    bytes,
    response.headers.get("content-type") ?? "",
    expectedNames,
  );
}
