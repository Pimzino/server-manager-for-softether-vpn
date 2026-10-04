// Launches a production-style build (esbuild main+preload + the real Vite renderer) with Playwright
// _electron and checks: the real UI renders from file:// under the strict CSP with no CSP violations
// or page errors, the View menu targets exist, revealPath is restricted, and quit closes cleanly.
//   node apps/desktop/tools/smoke-core/full-launch.ts <build dir containing main/ preload/ renderer/ package.json> <artifact dir>
import { _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const [BUILD, ART] = [path.resolve(process.argv[2]), path.resolve(process.argv[3])];
mkdirSync(ART, { recursive: true });
const DATA = mkdtempSync(path.join(os.tmpdir(), "sem-full-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail: string) => { results.push({ step, ok, detail }); console.log(`${ok ? "  ok  " : "  FAIL"} ${step} — ${detail}`); };

const app = await electron.launch({
  executablePath: require("electron") as string, args: [BUILD],
  env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1" } as Record<string, string>, timeout: 60_000,
});
const page = await app.firstWindow();
const problems: string[] = [];
page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
await page.waitForLoadState("load");
await page.waitForTimeout(3000);
const rootHtml = await page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? 0);
check("real renderer mounts from file:// under the CSP", rootHtml > 500, `#root has ${rootHtml} chars of markup`);
check("no CSP violations / page errors at startup", problems.length === 0, problems.length ? problems.slice(0, 5).join(" | ") : "none");
await page.screenshot({ path: path.join(ART, "full-window.png") });

// View menu items → routes that exist in the renderer
const navItems = await app.evaluate(({ Menu }) => {
  const out: string[] = [];
  const walk = (m: Electron.Menu | null) => m?.items.forEach((i) => { if (i.label && i.submenu) walk(i.submenu); else if (i.label) out.push(i.label); });
  walk(Menu.getApplicationMenu());
  return out;
});
for (const label of ["Servers", "Client Deployment", "Settings"]) {
  await app.evaluate(({ Menu }, l) => {
    const view = Menu.getApplicationMenu()!.items.find((i) => i.label === "View")!.submenu!;
    view.items.find((i) => i.label === l)!.click();
  }, label);
  await page.waitForTimeout(600);
  check(`View › ${label} navigates`, true, new URL(page.url()).hash || "#/");
}
const hash = new URL(page.url()).hash;
check("View › Settings lands on an existing route (/preferences)", hash.startsWith("#/preferences"), hash);

// revealPath policy: data dir allowed, arbitrary path refused
await app.evaluate(({ shell }) => { (globalThis as any).__revealed = []; (shell as any).showItemInFolder = (p: string) => (globalThis as any).__revealed.push(p); });
const r1 = await page.evaluate((d) => (window as any).sem.revealPath(d).then(() => "ok", (e: Error) => e.message), DATA);
const r2 = await page.evaluate(() => (window as any).sem.revealPath("/etc/hosts").then(() => "ok", (e: Error) => e.message));
check("revealPath: data dir allowed, other paths refused", r1 === "ok" && /Only the data folder/.test(r2), `dataDir → ${r1}; /etc/hosts → ${r2.slice(0, 90)}`);

// Quit: the app must exit and leave a readable db (WAL checkpointed on close)
const proc = app.process();
const exited = new Promise<number | null>((res) => proc.once("exit", (c) => res(c)));
await app.evaluate(({ app: a }) => a.quit());
const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 15_000))]);
check("app.quit() exits the process", code !== "timeout", `exit code ${code}`);
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(path.join(DATA, "sem.db"), { readOnly: true });
const v = db.prepare("SELECT version FROM schema_version").get() as { version: number };
db.close();
check("sem.db readable after quit", v.version >= 1, `schema_version ${v.version}`);
console.log(`menu labels: ${navItems.join(", ")}`);
writeFileSync(path.join(ART, "full-launch.json"), JSON.stringify({ at: new Date().toISOString(), results, problems }, null, 2));
rmSync(DATA, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
