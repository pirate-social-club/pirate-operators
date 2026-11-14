import assert from "node:assert/strict";
/** The same normalized health exclusion as Nativev2, ported without changing it. */
export function actualBusinessPath(raw:string,origin:string) {
 assert(raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\"));
 const url=new URL(raw,origin);assert(url.origin===origin && !url.hash);
 const decoded=decodeURIComponent(url.pathname);assert(decodeURIComponent(decoded)===decoded);
 const normalized=new URL(decoded.replace(/\/{2,}/g,"/"),origin).pathname;
 const parts=normalized.toLowerCase().replace(/^\/|\/$/g,"").split("/");
 const health=new Set(["health","healthz","ready","readyz","live","livez","ping","metrics","status"]);
 assert(!(parts.length===1 && health.has(parts[0]!) || parts.length===2 && ["api","internal","_internal"].includes(parts[0]!) && health.has(parts[1]!)),"health_only_probe_refused");
 return normalized+url.search;
}

