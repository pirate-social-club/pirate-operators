// MOSS conformance of the V4 sign-in text. MOSS signs a SIWE message with
// its host, address and chain check only when the text matches its strict
// pattern; otherwise it shows the text as a plain message and checks nothing.
// This test carries the hosted wallet's own source for that check, verbatim,
// and derives the regular expressions from it by reading its string and
// regular-expression literals. It never executes the bundle.
//
// Evidence: the hosted MOSS wallet bundle, read only.
//   file    index-84d75623598f3ef5bc796d5dd6c31f0a.js
//   sha256  7c258d107f4881b01e8335ca6f4756c95d0d0441b052a0d979252aaad96accaf
//   fetched 2026-11-09T16:25:47Z (pirate-manual-rewards-testnet-20261107
//           .local/moss-origin-check-20261109/hosted/)
//   checkSiwe and the strict pattern  line 1860, module 1693 (requires 776)
//   parseSiweMessage                   line 1234, module 1119 (776 re-exports it)
//   PARENT_ORIGIN / PARENT_HOST        line 846,  module 753
// With MOSS_BUNDLE_PATH set to that file, the test also checks its hash and
// that every fragment below appears in it verbatim.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAddress, hashMessage, keccak256, stringToHex, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import {
  SIGN_IN_STATEMENT_V4,
  readSignInMessageV4,
  signInMessageV4,
  type SignIn,
  type SignInV4Context,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";

const BUNDLE_SHA256 = "7c258d107f4881b01e8335ca6f4756c95d0d0441b052a0d979252aaad96accaf";
/** Verbatim source fragments of the bundle (JSON-escaped here). */
const SOURCE = {
  checkSiwe:
    "e.checkSiwe=function(t,s){if(!o.test(t))return;const c=(0,n.parseSiweMessage)(t);if(!c?.address)return;const u=Date.now(),h=s.chainId!==c.chainId,w=s.host!==c.domain,f=s.address.toLowerCase()!==c.address.toLowerCase(),p=!!c.expirationTime&&new Date(c.expirationTime).getTime()<u,I=!!c.notBefore&&new Date(c.notBefore).getTime()>u;return{siwe:c,domainMismatch:w,addressMismatch:f,expired:p,notYetValid:I,chainIdMismatch:h,blocked:w||f||p||I||h}}",
  strictPattern:
    "const t='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})',o=new RegExp(['^(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?[a-zA-Z0-9+.-]+(?::[0-9]{1,5})?',' wants you to sign in with your Ethereum account:\\n','0x[a-fA-F0-9]{40}\\n\\n','(?:[^\\n]+\\n\\n|\\n)?','URI: \\\\S+\\n','Version: 1\\n','Chain ID: [0-9]+\\n','Nonce: [a-zA-Z0-9]{8,}\\n',`Issued At: ${t}`,`(?:\\nExpiration Time: ${t})?`,`(?:\\nNot Before: ${t})?`,'(?:\\nRequest ID: \\\\S*)?','(?:\\nResources:(?:\\n- \\\\S+)+)?$'].join(''))",
  parser:
    "e.parseSiweMessage=function(n){const{scheme:t,statement:c,...h}=n.match(o)?.groups??{},{chainId:f,expirationTime:I,issuedAt:p,notBefore:A,requestId:N,resources:w,...T}=n.match(u)?.groups??{},x=w?.split('\\n- ').slice(1);return{...h,...T,...f?{chainId:Number(f)}:{},...I?{expirationTime:s(I)}:{},...p?{issuedAt:s(p)}:{},...A?{notBefore:s(A)}:{},...N?{requestId:N}:{},...x?{resources:x}:{},...t?{scheme:t}:{},...c?{statement:c}:{}}}",
  parserDate:
    "const n=/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/;function t(t){return!!n.test(t)&&!Number.isNaN(new Date(t).getTime())}function s(n){return t(n)?new Date(n):new Date(Number.NaN)}",
  parserPatterns:
    "const o=/^(?:(?<scheme>[a-zA-Z][a-zA-Z0-9+\\-.]*):\\/\\/)?(?<domain>[a-zA-Z0-9+-.]*(?::[0-9]{1,5})?) (?:wants you to sign in with your Ethereum account:\\n)(?<address>0x[a-fA-F0-9]{40})\\n\\n(?:(?<statement>.*)\\n\\n)?/,u=/(?:URI: (?<uri>.+))\\n(?:Version: (?<version>.+))\\n(?:Chain ID: (?<chainId>\\d+))\\n(?:Nonce: (?<nonce>[a-zA-Z0-9]+))\\n(?:Issued At: (?<issuedAt>.+))(?:\\nExpiration Time: (?<expirationTime>.+))?(?:\\nNot Before: (?<notBefore>.+))?(?:\\nRequest ID: (?<requestId>.*))?(?:\\nResources:(?<resources>(?:\\n- .+)*))?/",
  parentHost:
    "const s=u?(function(n){if(n)try{const t=new URL(n);return('https:'===t.protocol||'http:'===t.protocol)&&t.origin===n?n:void 0}catch{return}})(o.get('origin')):t&&document.referrer?new URL(document.referrer).origin:void 0,f=c??s,p=s?new URL(s).host:void 0",
} as const;

/** A JavaScript string literal's value; the fragments use only \\ and \n. */
function literal(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") {
      out += text[i];
      continue;
    }
    const e = text[++i];
    if (e === "n") out += "\n";
    else if (e === "\\") out += "\\";
    else throw new Error(`unsupported escape ${e}`);
  }
  return out;
}
/** The strict pattern: `const t='T',o=new RegExp([...].join(''))`. */
const strict = (() => {
  const src = SOURCE.strictPattern;
  const t = literal(/^const t='((?:[^'\\]|\\.)*)'/.exec(src)![1]!);
  const items = /new RegExp\(\[(.*)\]\.join\(''\)\)$/.exec(src)![1]!;
  const parts = [...items.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) =>
    m[1] !== undefined ? literal(m[1]) : literal(m[2]!).replaceAll("${t}", t),
  );
  assert.equal(parts.length, 13);
  return new RegExp(parts.join(""));
})();
/** The parser's two regular-expression literals and its date rule. */
const [prefix, suffix] = (() => {
  const m = /^const o=\/(.*)\/,u=\/(.*)\/$/.exec(SOURCE.parserPatterns)!;
  return [new RegExp(m[1]!), new RegExp(m[2]!)];
})();
const siweDate = new RegExp(/^const n=\/(.*)\/;function t/.exec(SOURCE.parserDate)![1]!);

// Transcriptions of the bundle's functions, line for line; only Date.now()
// is a parameter.
function validDate(t: string) {
  return !!siweDate.test(t) && !Number.isNaN(new Date(t).getTime());
}
function date(n: string) {
  return validDate(n) ? new Date(n) : new Date(Number.NaN);
}
function parseSiweMessage(n: string) {
  const { scheme: t, statement: c, ...h } = (n.match(prefix)?.groups ?? {}) as Record<string, string>,
    { chainId: f, expirationTime: I, issuedAt: p, notBefore: A, requestId: N, resources: w, ...T } = (n.match(suffix)
      ?.groups ?? {}) as Record<string, string>,
    x = w?.split("\n- ").slice(1);
  return {
    ...h,
    ...T,
    ...(f ? { chainId: Number(f) } : {}),
    ...(I ? { expirationTime: date(I) } : {}),
    ...(p ? { issuedAt: date(p) } : {}),
    ...(A ? { notBefore: date(A) } : {}),
    ...(N ? { requestId: N } : {}),
    ...(x ? { resources: x } : {}),
    ...(t ? { scheme: t } : {}),
    ...(c ? { statement: c } : {}),
  } as Record<string, any>;
}
function checkSiwe(t: string, s: { address: string; host: string; chainId: number }, now: number) {
  if (!strict.test(t)) return;
  const c = parseSiweMessage(t);
  if (!c?.address) return;
  const u = now,
    h = s.chainId !== c.chainId,
    w = s.host !== c.domain,
    f = s.address.toLowerCase() !== c.address.toLowerCase(),
    p = !!c.expirationTime && new Date(c.expirationTime).getTime() < u,
    I = !!c.notBefore && new Date(c.notBefore).getTime() > u;
  return { siwe: c, domainMismatch: w, addressMismatch: f, expired: p, notYetValid: I, chainIdMismatch: h, blocked: w || f || p || I || h };
}
/** PARENT_HOST for a framed wallet: the host of the referrer's origin. */
const parentHost = (referrer: string) => new URL(new URL(referrer).origin).host;

const origin = "https://community.example";
const ctx: SignInV4Context = {
  origin,
  chainId: 6343,
  contract: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  communityId: keccak256(stringToHex("community")),
  publicationPolicy: learningV4PublicityPolicy,
};
const learner = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
const signIn: SignIn = {
  learner,
  nonce: "0x7f3e9a1c5b2d4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7",
  issuedAt: 1794240000n,
};
const text = signInMessageV4(ctx, signIn);
const issuedMs = Number(signIn.issuedAt) * 1000;

test("the transcription is the hosted bundle's source, when the bundle is supplied", { skip: !process.env.MOSS_BUNDLE_PATH && "MOSS_BUNDLE_PATH unset" }, async () => {
  const bytes = await readFile(process.env.MOSS_BUNDLE_PATH!);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), BUNDLE_SHA256);
  const source = bytes.toString("utf8"),
    lines = source.split("\n");
  for (const [name, fragment] of Object.entries(SOURCE)) assert.ok(source.includes(fragment), name);
  assert.ok(lines[1859]!.includes(SOURCE.checkSiwe) && lines[1859]!.includes(SOURCE.strictPattern));
  assert.ok(lines[1859]!.endsWith("},1693,[776]);"));
  assert.ok(lines[1233]!.includes(SOURCE.parser) && lines[1233]!.endsWith("},1119,[]);"));
  assert.ok(lines[845]!.includes(SOURCE.parentHost));
});

test("the V4 text matches MOSS's strict SIWE pattern and parses field for field", () => {
  assert.equal(Buffer.byteLength(text), 874);
  assert.equal(hashMessage(text), "0x70de2a412bf605d73c7827f8fceff25eff23f8ab24b0f6346bca3c096b3d6210");
  assert.ok(strict.test(text));
  const m = parseSiweMessage(text);
  assert.equal(m.domain, "community.example");
  assert.equal(m.address, learner);
  assert.equal(m.statement, SIGN_IN_STATEMENT_V4);
  assert.equal(m.uri, origin);
  assert.equal(m.version, "1");
  assert.equal(m.chainId, 6343);
  assert.equal(m.nonce, signIn.nonce.slice(2));
  assert.equal(m.issuedAt.getTime(), issuedMs);
  assert.equal(m.notBefore.getTime(), issuedMs);
  assert.equal(m.expirationTime, undefined);
  assert.deepEqual(m.resources, [
    `${origin}/learning/v4/terms`,
    `${origin}/learning/v4/privacy`,
    `urn:pirate:publication-policy:4:${learningV4PublicityPolicy}`,
    `urn:pirate:community:${ctx.communityId}`,
    `eip155:6343:${ctx.contract}`,
  ]);
  // Other origins, chains and learners the builder renders also match.
  for (const c of [
    { ...ctx, origin: "https://study.example:8443", chainId: 31337 },
    { ...ctx, origin: "https://pirate-first-song-20261105.piratesocialclub.workers.dev" },
  ])
    for (const who of [learner, getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"), getAddress("0x1234567890123456789012345678901234567890")]) {
      const t = signInMessageV4(c, { ...signIn, learner: who });
      assert.ok(strict.test(t), t);
      assert.equal(parseSiweMessage(t).domain, new URL(c.origin).host);
      assert.equal(parseSiweMessage(t).statement, SIGN_IN_STATEMENT_V4);
    }
});

test("checkSiwe passes the community's own host, learner and chain from issuedAt on, and blocks everything else", () => {
  const host = parentHost(origin + "/study");
  assert.equal(host, "community.example");
  const own = { address: learner.toLowerCase(), host, chainId: 6343 };
  for (const now of [issuedMs, issuedMs + 1, issuedMs + 30 * 86400_000, issuedMs + 400 * 86400_000])
    assert.equal(checkSiwe(text, own, now)!.blocked, false, String(now));
  const cases = [
    ["before issuedAt", own, issuedMs - 1, "notYetValid"],
    ["another host", { ...own, host: "phish.example" }, issuedMs, "domainMismatch"],
    ["the host with a port", { ...own, host: "community.example:443" }, issuedMs, "domainMismatch"],
    ["another chain", { ...own, chainId: 31337 }, issuedMs, "chainIdMismatch"],
    ["another account", { ...own, address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" }, issuedMs, "addressMismatch"],
  ] as const;
  for (const [name, s, now, flag] of cases) {
    const r = checkSiwe(text, s, now)!;
    assert.equal(r.blocked, true, name);
    assert.equal(r[flag], true, name);
  }
  // A text that misses the strict pattern gets no checks at all, which is
  // why the V4 text must match it: here, a trailing newline.
  assert.equal(checkSiwe(text + "\n", own, issuedMs), undefined);
});

test("statement, resources and nonce stay inside what EIP-4361, viem and MOSS accept", () => {
  // EIP-4361 statement: RFC 3986 reserved and unreserved characters and space.
  assert.match(SIGN_IN_STATEMENT_V4, /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]+$/);
  assert.doesNotMatch(SIGN_IN_STATEMENT_V4, /[\r\n\u2028\u2029]/);
  const m = parseSiweMessage(text);
  for (const r of m.resources as string[]) {
    assert.match(r, /^\S+$/);
    // viem's isUri check, through createSiweMessage, which throws otherwise.
    assert.doesNotThrow(() =>
      createSiweMessage({ address: learner, chainId: 6343, domain: "community.example", nonce: "abcdefgh", uri: origin, version: "1", resources: [r] }),
    );
  }
  assert.throws(() =>
    createSiweMessage({ address: learner, chainId: 6343, domain: "community.example", nonce: "abcdefgh", uri: origin, version: "1", resources: ["not a uri"] }),
  );
  assert.match(m.nonce, /^[a-zA-Z0-9]{8,}$/);
});

test("readSignInMessageV4 refuses any one-byte change outside the free hex fields, and reads one inside them as another sign-in", () => {
  const original = readSignInMessageV4(text)!;
  assert.deepEqual(original, { context: ctx, signIn });
  // The free fields: the nonce, the policy and community hashes and the
  // contract address. A changed digit there is another valid sign-in.
  const free = [signIn.nonce.slice(2), ctx.publicationPolicy.slice(2), ctx.communityId.slice(2), ctx.contract.slice(2)].map(
    (v) => {
      const at = text.indexOf(v);
      assert.ok(at > 0 && text.indexOf(v, at + 1) === -1);
      return [at, at + v.length] as const;
    },
  );
  let refused = 0;
  for (let i = 0; i < text.length; i++) {
    for (const replacement of [text[i] === "a" ? "b" : "a", text[i] === "0" ? "1" : "0", text[i] === " " ? "_" : " "]) {
      const changed = text.slice(0, i) + replacement + text.slice(i + 1);
      const read = readSignInMessageV4(changed);
      if (free.some(([a, b]) => i >= a && i < b)) {
        if (read) assert.notDeepEqual(read, original);
      } else {
        assert.equal(read, undefined, `byte ${i}: ${JSON.stringify(text.slice(Math.max(0, i - 10), i + 10))}`);
        refused++;
      }
    }
  }
  assert.equal(refused, (text.length - 232) * 3);
  // Truncation, a trailing newline and CRLF are refused too.
  for (const changed of [text.slice(0, -1), text + "\n", text.replaceAll("\n", "\r\n")])
    assert.equal(readSignInMessageV4(changed), undefined);
});
