// Writes e2e-desktop/artifacts/SUMMARY.md from Playwright's results.json: every test with status and duration,
// annotations (notices, error states), every generated .vpn/.msi (and other outputs) with SHA-256, and the
// screenshots. Exit code 1 when a test failed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "artifacts");
const resultsFile = path.join(dir, "results.json");
if (!existsSync(resultsFile)) {
  console.error(`No ${resultsFile}: the Playwright run did not produce results`);
  process.exit(1);
}
const results = JSON.parse(readFileSync(resultsFile, "utf8"));
const rows: string[] = [];
const notes: string[] = [];
const failures: string[] = [];
let passed = 0, failed = 0, skipped = 0, flaky = 0;
const walk = (suite: any, file: string) => {
  for (const s of suite.suites ?? []) walk(s, s.file ?? file);
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      const r = t.results.at(-1);
      const status: string = t.status === "flaky" ? "flaky" : r?.status ?? "skipped";
      if (status === "passed") passed++; else if (status === "skipped") skipped++; else if (status === "flaky") flaky++; else failed++;
      const mark = status === "passed" ? "PASS" : status === "skipped" ? "SKIP" : status === "flaky" ? "FLAKY" : "FAIL";
      rows.push(`| ${mark} | ${path.basename(file)} | ${spec.title.replace(/\|/g, "\\|")} | ${((r?.duration ?? 0) / 1000).toFixed(1)} s |`);
      const seen = new Set<string>();
      for (const a of [...(t.annotations ?? []), ...(r?.annotations ?? [])]) {
        if (!a.description) continue; // describe-level markers without content
        const line = `- **${spec.title}** — ${a.type}: ${String(a.description).replace(/\n/g, " ")}`;
        if (!seen.has(line)) { seen.add(line); notes.push(line); }
      }
      if (status !== "passed" && status !== "skipped" && r?.error?.message) {
        failures.push(`### ${spec.title}\n\n\`\`\`\n${String(r.error.message).replace(/\x1b\[[0-9;]*m/g, "").slice(0, 2000)}\n\`\`\``);
      }
    }
  }
};
for (const s of results.suites) walk(s, s.file);

const list = (d: string, pred: (f: string) => boolean): string[] => {
  if (!existsSync(d)) return [];
  const out: string[] = [];
  for (const f of readdirSync(d).sort()) {
    if (f.startsWith("._")) continue;
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) out.push(...list(p, pred));
    else if (pred(f)) out.push(p);
  }
  return out;
};
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const outputs = list(path.join(dir, "outputs"), () => true);
const hashes = outputs.map((f) => `| ${path.relative(dir, f)} | ${statSync(f).size} | \`${sha(f)}\` |`);
const shots = list(path.join(dir, "screenshots"), (f) => f.endsWith(".png"));

const md = `# Server Manager for SoftEther VPN Desktop — E2E run

- Started: ${results.stats?.startTime ?? "?"}
- Duration: ${((results.stats?.duration ?? 0) / 1000).toFixed(1)} s
- Result: **${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped**
- Playwright ${results.config?.version ?? "?"} \`_electron\` driving the real app built into \`e2e-desktop/.build\` (same esbuild/Vite options as \`apps/desktop/scripts/build.mjs\`)

Environment: two real SoftEther VPN Servers built from source (A on 16101 with \`DisableJsonRpcWebApi true\` and an empty
admin password, checked with vpncmd over the native admin protocol; B on 16102 with an admin password, checked over
JSON-RPC), a real SoftEther VPN Client on 9931 (\`.vpn\` import), a fresh \`SEM_DATA_DIR\` and \`SEM_INSECURE_KEYSTORE=1\`.
Every test drives the UI (clicks, typing, native menu items); native Save/Open dialogs are stubbed in the main process.

Not verified on this machine (safety policy): SFX extraction of official client installers, the setup.exe wrapper,
GitHub import, and installing the generated MSI on Windows. The client package is a ZIP of plain-text placeholders
(no MZ header) plus the real hamcore.se2.

## Tests

| | File | Test | Time |
|---|---|---|---|
${rows.join("\n")}

${failures.length ? `## Failures\n\n${failures.join("\n\n")}\n` : ""}
## Notes recorded by the tests

${notes.length ? notes.join("\n") : "_none_"}

## Generated artifacts

| File | Bytes | SHA-256 |
|---|---|---|
${hashes.join("\n")}

## Screenshots (${shots.length})

${shots.map((f) => `- \`${path.relative(dir, f)}\``).join("\n")}

HTML report: \`report/index.html\` (\`pnpm exec playwright show-report e2e-desktop/artifacts/report\`).
`;
writeFileSync(path.join(dir, "SUMMARY.md"), md);
console.log(md.split("\n").slice(0, 5).join("\n"));
if (failed) process.exitCode = 1;
