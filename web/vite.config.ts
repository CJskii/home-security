import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveProxy, localLiveOptions } from "./dev/live-proxy";
import { isIPv4 } from "node:net";
const lan = process.env.DASHBOARD_DEV_LAN === "true";
const lanIp = process.env.DEV_LAN_IP;
if (lan && (!lanIp || !isIPv4(lanIp))) throw new Error("Set DEV_LAN_IP before LAN development");
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), ...(command === "serve" ? [liveProxy(localLiveOptions(
    lan ? `https://${lanIp}:5173` : "http://127.0.0.1:5173", !lan,
  ))] : [])],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router"],
          validation: ["zod"],
        },
      },
    },
  },
  server: {
    host: lan ? lanIp! : "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.cache/**"],
    },
    ...(lan
      ? {
          https: {
            key: readFileSync(
              new URL("./.cache/lan-tls/key.pem", import.meta.url),
            ),
            cert: readFileSync(
              new URL("./.cache/lan-tls/cert.pem", import.meta.url),
            ),
          },
        }
      : {}),
    proxy: { "/api": { target: "http://127.0.0.1:3001" } },
  },
}));
