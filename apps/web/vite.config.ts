import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.SEM_API ?? "https://127.0.0.1:8443", secure: false, changeOrigin: false },
      "/metrics": { target: process.env.SEM_API ?? "https://127.0.0.1:8443", secure: false },
    },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 2000 },
});
