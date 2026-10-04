// Background jobs of the main process: health polling, scheduled config backups and pruning of
// per-user packages (they contain credentials). Timers are unref'd and stopped on quit.
import { rmSync } from "node:fs";
import { all, get, getSetting, run, setSetting } from "./db.ts";
import { config } from "./config.ts";
import { backupSettings, takeBackup } from "./backups.ts";
import { isUnlocked, listServers, refreshState } from "./servers.ts";

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

let polling = false;
let stopped = true;
const timers = new Set<NodeJS.Timeout>();

function later(fn: () => void, ms: number) {
  const t = setTimeout(() => { timers.delete(t); if (!stopped) fn(); }, ms);
  t.unref();
  timers.add(t);
}
function every(fn: () => void, ms: number) {
  const t = setInterval(() => { if (!stopped) fn(); }, ms);
  t.unref();
  timers.add(t);
}

export function pollIntervalSec(): number {
  return getSetting("poll", { intervalSec: config.pollIntervalSec }).intervalSec;
}

export async function pollAll(log: Log = console) {
  if (polling) return;
  polling = true;
  try {
    const servers = listServers().filter((s) => s.enabled);
    // Bounded concurrency so large fleets don't open hundreds of sockets at once
    const queue = [...servers];
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await refreshState(s);
    }));
  } catch (e) {
    log.warn("poll failed", e);
  } finally {
    polling = false;
  }
}

async function backupDue(log: Log) {
  const b = backupSettings();
  if (!b.enabled) return;
  for (const s of listServers().filter((x) => x.enabled && !x.hub && isUnlocked(x))) {
    const lastBackup = get<{ t: number }>("SELECT MAX(created_at) AS t FROM config_backups WHERE server_id = ?", s.id)?.t ?? 0;
    const last = Math.max(lastBackup, getSetting<number>(`backupCheckedAt:${s.id}`, 0));
    if (Date.now() - last < b.intervalHours * 3600_000) continue;
    try {
      const r = await takeBackup(s, "scheduler", "Scheduled backup");
      // Unchanged configs are not stored again; remember the check so we wait a full interval.
      setSetting(`backupCheckedAt:${s.id}`, Date.now());
      log.info(`scheduled config backup of ${s.name}: ${r.changed ? "stored" : "unchanged"}`);
    } catch (e) {
      log.warn(`scheduled backup of ${s.name} failed: ${(e as Error).message}`);
    }
  }
}

/** Per-user packages contain credentials: keep them only for a limited time. */
function prunePackages() {
  const days = getSetting<{ packageRetentionDays?: number }>("deploy", {}).packageRetentionDays ?? 14;
  const old = all<{ id: number; stored_path: string | null }>(
    "SELECT id, stored_path FROM installer_builds WHERE username IS NOT NULL AND created_at < ?", Date.now() - days * 86400_000);
  for (const b of old) {
    if (b.stored_path) rmSync(b.stored_path, { force: true });
    run("DELETE FROM installer_builds WHERE id = ?", b.id);
  }
}

export function startScheduler(log: Log = console) {
  if (!stopped) return;
  stopped = false;
  const tick = async () => {
    await pollAll(log);
    later(() => void tick(), pollIntervalSec() * 1000);
  };
  later(() => void tick(), 1000);
  every(() => void backupDue(log), 10 * 60_000);
  later(() => void backupDue(log), 30_000);
  every(prunePackages, 3600_000);
  later(prunePackages, 60_000);
}

export function stopScheduler() {
  stopped = true;
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers.clear();
}
