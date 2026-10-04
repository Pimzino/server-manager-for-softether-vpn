import { rmSync } from "node:fs";
import { all, get, getSetting, run, setSetting } from "./db.ts";
import { config } from "./config.ts";
import { backupSettings, takeBackup } from "./backups.ts";
import { listServers, refreshState } from "./servers.ts";

type Log = { info: (o: object | string, m?: string) => void; warn: (o: object | string, m?: string) => void };

let polling = false;

async function pollAll(log: Log) {
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
    log.warn({ err: e }, "poll failed");
  } finally {
    polling = false;
  }
}

async function backupDue(log: Log) {
  const b = backupSettings();
  if (!b.enabled) return;
  for (const s of listServers().filter((x) => x.enabled && !x.hub)) {
    const lastBackup = get<{ t: number }>("SELECT MAX(created_at) AS t FROM config_backups WHERE server_id = ?", s.id)?.t ?? 0;
    const last = Math.max(lastBackup, getSetting<number>(`backupCheckedAt:${s.id}`, 0));
    if (Date.now() - last < b.intervalHours * 3600_000) continue;
    try {
      const r = await takeBackup(s, "scheduler", "Scheduled backup");
      // Unchanged configs are not stored again; remember the check so we wait a full interval.
      setSetting(`backupCheckedAt:${s.id}`, Date.now());
      log.info({ server: s.name, changed: r.changed }, "scheduled config backup");
    } catch (e) {
      log.warn({ server: s.name, err: (e as Error).message }, "scheduled backup failed");
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

function pruneAudit() {
  run("DELETE FROM audit_log WHERE ts < ?", Date.now() - config.auditRetentionDays * 86400_000);
  run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
}

export function startScheduler(log: Log) {
  const pollSec = () => getSetting("poll", { intervalSec: config.pollIntervalSec }).intervalSec;
  const tick = async () => {
    await pollAll(log);
    setTimeout(tick, pollSec() * 1000).unref();
  };
  setTimeout(tick, 1000).unref();
  setInterval(() => void backupDue(log), 10 * 60_000).unref();
  setTimeout(() => void backupDue(log), 30_000).unref();
  setInterval(pruneAudit, 3600_000).unref();
  setInterval(prunePackages, 3600_000).unref();
  setTimeout(prunePackages, 60_000).unref();
}
