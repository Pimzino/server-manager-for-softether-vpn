import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src/renderer") } },
  server: { host: "127.0.0.1", port: 5190, strictPort: true },
  build: { outDir: path.resolve(import.meta.dirname, "dist/renderer"), emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 4000 },
});
