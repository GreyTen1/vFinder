import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "lucide-react",
      "@tauri-apps/api/core",
      "@tauri-apps/api/window",
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    warmup: {
      clientFiles: ["./src/main.tsx", "./src/App.tsx", "./src/components/*.tsx"],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
