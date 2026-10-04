// Writes e2e/artifacts/SUMMARY.md from Playwright's results.json plus hashes of generated artifacts.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "artifacts");
const results = JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8"));
const rows: string[] = [];
let passed = 0, failed = 0, skipped = 0;
const walk = (suite: any, file: string) => {
  for (const s of suite.suites ?? []) walk(s, s.file ?? file);
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      const r = t.results.at(-1);
      const status = r?.status ?? "skipped";
      if (status === "passed") passed++; else if (status === "skipped") skipped++; else failed++;
      rows.push(`| ${status === "passed" ? "✅" : status === "skipped" ? "⏭️" : "❌"} | ${path.basename(file)} | ${spec.title} | ${((r?.duration ?? 0) / 1000).toFixed(1)} s |`);
    }
  }
};
for (const s of results.suites) walk(s, s.file);

const files: string[] = [];
const list = (d: string) => {
  for (const f of readdirSync(d)) {
    if (f.startsWith("._")) continue;
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) { if (!["test-results", "report"].includes(f)) list(p); continue; }
    if (/\.(msi|vpn|txt|png)$/.test(f)) files.push(p);
  }
};
list(dir);
const hashes = files.filter((f) => !f.endsWith(".png")).map((f) => `| ${path.relative(dir, f)} | ${statSync(f).size} | \`${createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16)}…\` |`);

const md = `# SoftEther Manager — E2E run

- Started: ${results.stats?.startTime ?? "?"}
- Duration: ${((results.stats?.duration ?? 0) / 1000).toFixed(1)} s
- Result: **${passed} passed, ${failed} failed, ${skipped} skipped**

Environment: two real SoftEther VPN Servers (built from vendor/SoftEtherVPN), a real SoftEther VPN Client,
fresh SoftEther Manager backend + built UI, Chromium (Playwright). Assertions are checked against the
SoftEther servers directly over JSON-RPC and against the client via vpncmd.

## Tests

| | File | Test | Time |
|---|---|---|---|
${rows.join("\n")}

## Generated artifacts

| File | Bytes | SHA-256 |
|---|---|---|
${hashes.join("\n")}

Screenshots: \`screenshots/\` (${files.filter((f) => f.endsWith(".png")).length} files). HTML report: \`report/index.html\`.
`;
writeFileSync(path.join(dir, "SUMMARY.md"), md);
console.log(md.split("\n").slice(0, 6).join("\n"));
if (failed) process.exitCode = 1;
void existsSync;
