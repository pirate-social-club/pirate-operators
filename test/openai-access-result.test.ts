import test from "node:test";
import assert from "node:assert/strict";
import { openAiAccessResult } from "../harness/openai-access-result.ts";
const response = (value: unknown, status = 403) => ({
  status,
  contentType: "application/json",
  requestId: "req_fixture",
  body: JSON.stringify(value),
  bodySha256: "unused",
});
test("model-access diagnostics retain only allowlisted error codes and never body/message/credential fields", () => {
  const key = "sk-sensitive-fixture";
  const result = openAiAccessResult(
    response({
      error: {
        code: "model_not_found",
        type: "invalid_request_error",
        message: key,
        api_key: key,
      },
      key,
    }),
    key,
  );
  assert.equal(result.errorCode, "model_not_found");
  assert.equal(result.errorType, "invalid_request_error");
  assert(!JSON.stringify(result).includes(key));
  assert(!("message" in result));
  const echo = openAiAccessResult(
    response({ id: key, error: { code: key, type: key, message: key } }),
    key,
  );
  assert.equal(echo.errorCode, null);
  assert.equal(echo.errorType, null);
  assert.equal(echo.modelId, null);
  assert.equal(
    openAiAccessResult(response({ id: "gpt-6-luna" }, 200), key).modelId,
    "gpt-6-luna",
  );
});
