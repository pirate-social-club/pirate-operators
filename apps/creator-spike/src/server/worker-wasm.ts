// Cloudflare provides a precompiled WebAssembly.Module. Avoid the SDK's Node
// filesystem loader and runtime compilation, neither of which works in Workers.
// @ts-expect-error Cloudflare's compiled module import differs from upstream types.
import module from "../../node_modules/@ika.xyz/ika-wasm/dist/web/dwallet_mpc_wasm_bg.wasm";
import * as wasm from "@ika.xyz/ika-wasm/web";
wasm.initSync({ module });
export * from "@ika.xyz/ika-wasm/web";
export default wasm;
