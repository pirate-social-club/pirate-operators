// Complete persisted fields stay well below D1's 2,000,000-byte row limit,
// including worst-case sixfold JSON escaping of a raw provider response.
// https://developers.cloudflare.com/d1/platform/limits/
export const ALIGNMENT_RESPONSE_BYTES = 192 * 1024;
export const ALIGNMENT_REQUEST_BYTES = 64 * 1024;
export const ALIGNMENT_RECEIPT_BYTES = 6 * ALIGNMENT_RESPONSE_BYTES + 16 * 1024;
export const ALIGNMENT_RESULT_BYTES = 256 * 1024;
export const ALIGNMENT_ROW_BYTES = 1800000;
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;
