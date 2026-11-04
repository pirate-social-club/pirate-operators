import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const format = "pirate.protected-data/1";
export function statePassword() {
  const password = process.env.PIRATE_WIZARD_STATE_PASSWORD;
  if (!password || Buffer.byteLength(password) < 32)
    throw new Error(
      "Inject a state protection password of at least 32 bytes through the approved secret workflow.",
    );
  return password;
}
function key(password: string, salt: Buffer) {
  return scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
export function seal(text: string, password: string, context: string): string {
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(password, salt), iv);
  cipher.setAAD(Buffer.from(`${format}:${context}`));
  const ciphertext = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    format,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}
export function unseal(
  encoded: string,
  password: string,
  context: string,
): string {
  try {
    const data = JSON.parse(encoded);
    if (data.format !== format) throw new Error("Unsupported state format");
    const decode = (field: string, length?: number) => {
      if (
        typeof data[field] !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data[field])
      )
        throw new Error("Invalid envelope");
      const value = Buffer.from(data[field], "base64");
      if (length !== undefined && value.length !== length)
        throw new Error("Invalid envelope");
      return value;
    };
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(password, decode("salt", 16)),
      decode("iv", 12),
    );
    decipher.setAAD(Buffer.from(`${format}:${context}`));
    decipher.setAuthTag(decode("tag", 16));
    return Buffer.concat([
      decipher.update(decode("ciphertext")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Protected data could not be authenticated. Preserve it; check the password and recovery copy. Plaintext state is not accepted.",
    );
  }
}
