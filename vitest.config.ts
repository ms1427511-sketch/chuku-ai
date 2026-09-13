import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (which sets root: "src/client" for the
// browser build) — tests live at the project root and exercise server/
// shared code, not the client bundle.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
