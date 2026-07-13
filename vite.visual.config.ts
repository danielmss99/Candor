import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(repoRoot, "tests", "visual"),
  base: "./",
  publicDir: path.join(repoRoot, "v3", "renderer", "public"),
  plugins: [react()],
  clearScreen: false,
  build: {
    outDir: path.join(repoRoot, "release-v3", "visual-fixtures"),
    emptyOutDir: true,
  },
});
