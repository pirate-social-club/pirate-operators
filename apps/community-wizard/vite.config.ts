import { defineConfig } from "vite";
import {fileURLToPath} from "node:url";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  plugins: [solid()],
  build: { sourcemap: false,manifest:true,rollupOptions:{input:{wizard:fileURLToPath(new URL("./index.html",import.meta.url)),mossSigning:fileURLToPath(new URL("./moss-signing.html",import.meta.url))}} },
});
