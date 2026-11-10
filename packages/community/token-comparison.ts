// Session and creator-state comparison needs Node compatibility. Keep that
// dependency out of public manifest validation, which also runs in the operator.
import { timingSafeEqual } from "node:crypto";
import { hashText } from "./common.ts";

export const equalTokens = (a: string, b: string) =>
  timingSafeEqual(
    Buffer.from(hashText(a).slice(2), "hex"),
    Buffer.from(hashText(b).slice(2), "hex"),
  );
