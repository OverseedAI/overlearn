import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Dev-only proxy to a running `learn daemon`. The daemon binds an ephemeral
// port and expects a bearer token; export both before `bun run dev`:
//   OVERLEARN_DAEMON_PORT=<port> OVERLEARN_DAEMON_TOKEN=<token> bun run dev
// (Both are in the daemon.json metadata file the daemon writes on startup.)
const daemonPort = process.env.OVERLEARN_DAEMON_PORT;
const daemonToken = process.env.OVERLEARN_DAEMON_TOKEN;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    ...(daemonPort
      ? {
          proxy: {
            "/api": {
              target: `http://127.0.0.1:${daemonPort}`,
              headers: daemonToken
                ? { Authorization: `Bearer ${daemonToken}` }
                : {},
            },
          },
        }
      : {}),
  },
});
