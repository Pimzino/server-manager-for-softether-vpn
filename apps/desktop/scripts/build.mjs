// Builds the desktop app: main process (ESM bundle), preload (CJS, sandbox-compatible) and renderer (Vite).
//   node scripts/build.mjs          production build into dist/
//   node scripts/build.mjs --dev    watch main/preload, run the Vite dev server, launch Electron against it
import { build, context } from "esbuild";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dev = process.argv.includes("--dev");
const dist = path.join(root, "dist");

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  external: ["electron"],
  // Renderer-only code must never be pulled into main
  define: { "process.env.SEM_DEV_SERVER": dev ? JSON.stringify("http://127.0.0.1:5190") : "undefined" },
};

const mainOpts = {
  ...common,
  entryPoints: { main: path.join(root, "src/main/main.ts") },
  outdir: path.join(dist, "main"),
  outExtension: { ".js": ".mjs" },
  format: "esm",
  // Bundled CommonJS dependencies (fastify, undici, ...) still call require()
  banner: { js: "import { createRequire as __semCreateRequire } from 'node:module'; const require = __semCreateRequire(import.meta.url);" },
  loader: { ".node": "copy" },
};
const preloadOpts = {
  ...common,
  entryPoints: { preload: path.join(root, "src/preload/preload.ts") },
  outdir: path.join(dist, "preload"),
  outExtension: { ".js": ".cjs" },
  format: "cjs",
};

if (!dev) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  await build(mainOpts);
  await build(preloadOpts);
  const vite = await import("vite");
  await vite.build({ configFile: path.join(root, "vite.config.ts"), mode: "production" });
} else {
  const m = await context(mainOpts);
  const p = await context(preloadOpts);
  await m.rebuild();
  await p.rebuild();
  await m.watch();
  await p.watch();
  const vite = await import("vite");
  const server = await vite.createServer({ configFile: path.join(root, "vite.config.ts") });
  await server.listen();
  const electron = (await import("electron")).default;
  const child = spawn(electron, [root], { stdio: "inherit", env: { ...process.env, SEM_DEV_SERVER: "http://127.0.0.1:5190" } });
  child.on("exit", async (code) => { await server.close(); await m.dispose(); await p.dispose(); process.exit(code ?? 0); });
}
