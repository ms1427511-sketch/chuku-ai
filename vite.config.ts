import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Client dev server proxies /api calls to the local Chuku server only —
// the client never talks to LightX or holds a provider secret. The port
// here is only a proxy target address (not a secret) so it's safe to read
// directly from process.env rather than importing server config code.
const serverPort = Number(process.env.CHUKU_PORT ?? 4317);

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${serverPort}`,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
