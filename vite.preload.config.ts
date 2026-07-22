import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  esbuild: {
    include: /electron[\\/]preload\.cts$/,
    loader: "ts",
  },
  build: {
    outDir: "dist-v3/electron",
    emptyOutDir: false,
    target: "node22",
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve("electron/preload.cts"),
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rollupOptions: {
      // Electron is the only module exposed by the sandboxed preload loader.
      // Everything owned by Candor, including the event buffer, must be inlined.
      external: ["electron"],
      output: {
        exports: "auto",
        inlineDynamicImports: true,
      },
    },
  },
});
