// Builds the main process + preload exactly like scripts/build.mjs (production options), into a
// separate output directory so the smoke test never touches dist/ that other builds use.
// The renderer is a minimal placeholder page (the core smoke test drives window.sem directly).
//   node tools/smoke-core/build.mjs <outdir>
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.resolve(process.argv[2] ?? path.join(root, ".smoke-build"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true, platform: "node", target: "node24", sourcemap: true, logLevel: "warning", external: ["electron"],
  define: { "process.env.SEM_DEV_SERVER": "undefined" },
};
const t0 = Date.now();
await build({
  ...common,
  entryPoints: { main: path.join(root, "src/main/main.ts") },
  outdir: path.join(out, "main"),
  outExtension: { ".js": ".mjs" },
  format: "esm",
  banner: { js: "import { createRequire as __semCreateRequire } from 'node:module'; const require = __semCreateRequire(import.meta.url);" },
  loader: { ".node": "copy" },
  metafile: true,
}).then((r) => writeFileSync(path.join(out, "main-meta.json"), JSON.stringify(r.metafile)));
await build({
  ...common,
  entryPoints: { preload: path.join(root, "src/preload/preload.ts") },
  outdir: path.join(out, "preload"),
  outExtension: { ".js": ".cjs" },
  format: "cjs",
});

// Placeholder renderer: an external script (allowed by script-src 'self') and an inline one (must be blocked by the CSP).
mkdirSync(path.join(out, "renderer"), { recursive: true });
writeFileSync(path.join(out, "renderer/index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Server Manager for SoftEther VPN (core smoke)</title></head>
<body><h1>core smoke</h1><script src="./app.js"></script><script>window.__inlineRan = true;</script></body></html>
`);
// eval must be tested from page script: DevTools' Runtime.evaluate bypasses CSP eval checks by default.
writeFileSync(path.join(out, "renderer/app.js"), "window.__externalRan = true;\ntry { eval('1'); window.__evalAllowed = true; } catch { window.__evalAllowed = false; }\n");

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
writeFileSync(path.join(out, "package.json"), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, type: "module", main: "main/main.mjs",
}, null, 2));
console.log(`built main+preload into ${out} in ${Date.now() - t0} ms`);
