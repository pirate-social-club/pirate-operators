import { defineConfig } from "vite";
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist/client",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
