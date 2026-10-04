// Builds the REAL desktop app for the E2E suite into e2e-desktop/.build/ with exactly the esbuild/Vite options
// of apps/desktop/scripts/build.mjs (production mode), so the tests never depend on apps/desktop/dist.
//   node e2e-desktop/build.mjs
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const appRoot = path.resolve(here, "../apps/desktop");
const out = path.join(here, ".build");

// --- identical to apps/desktop/scripts/build.mjs (dev = false) ---
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "warning",
  external: ["electron"],
  define: { "process.env.SEM_DEV_SERVER": "undefined" },
};
const mainOpts = {
  ...common,
  entryPoints: { main: path.join(appRoot, "src/main/main.ts") },
  outdir: path.join(out, "main"),
  outExtension: { ".js": ".mjs" },
  format: "esm",
  banner: { js: "import { createRequire as __semCreateRequire } from 'node:module'; const require = __semCreateRequire(import.meta.url);" },
  loader: { ".node": "copy" },
};
const preloadOpts = {
  ...common,
  entryPoints: { preload: path.join(appRoot, "src/preload/preload.ts") },
  outdir: path.join(out, "preload"),
  outExtension: { ".js": ".cjs" },
  format: "cjs",
};

const t0 = Date.now();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build(mainOpts);
await build(preloadOpts);
const vite = await import("vite");
// Same config file; only the output directory differs (dist/renderer -> .build/renderer).
await vite.build({
  configFile: path.join(appRoot, "vite.config.ts"),
  mode: "production",
  logLevel: "warn",
  build: { outDir: path.join(out, "renderer"), emptyOutDir: true },
});
// Electron app root: `electron e2e-desktop/.build` behaves like `electron .` in apps/desktop.
const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
writeFileSync(path.join(out, "package.json"), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description,
  private: true, type: "module", main: "main/main.mjs",
}, null, 2));
console.log(`desktop app built into ${out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
