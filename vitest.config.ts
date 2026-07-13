import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "dist-v3/**",
      "release-v3/**",
      "crates/**/target/**",
      "tests/e2e/**",
    ],
  },
});
