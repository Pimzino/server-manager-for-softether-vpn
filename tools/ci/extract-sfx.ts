// Extracts every file from an official SoftEther self-extracting installer (PE "DATAFILE" resources).
// usage: node tools/ci/extract-sfx.ts <installer.exe> <out dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractSfx } from "../../apps/server/src/deploy/payload.ts";

const [exe, out] = process.argv.slice(2);
if (!exe || !out) { console.error("usage: extract-sfx.ts <installer.exe> <out dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
for (const f of extractSfx(readFileSync(exe))) {
  writeFileSync(path.join(out, path.basename(f.name)), f.data);
  console.log(`${f.name}\t${f.data.length}`);
}
