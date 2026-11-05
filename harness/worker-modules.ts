import { insist } from "../packages/community/common.ts";
import { fileDigest } from "./creator-state.ts";

/** Hash raw multipart fields without FormData's UTF-8 decoding. Cloudflare
 * returns binary module fields without filenames, which FormData treats as text. */
export function workerModuleDigests(bytes: Uint8Array, contentType: string) {
  if (!contentType.startsWith("multipart/"))
    return { "index.js": fileDigest(bytes) };
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
      ++parts <= 3 &&
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
        ["index.js", "ika.wasm"].includes(name) && !(name in modules),
        "unexpected_worker_module",
        503,
      );
      modules[name] = fileDigest(data.subarray(bodyStart, end));
    }
    cursor = end + 2 + marker.length;
  }
}
