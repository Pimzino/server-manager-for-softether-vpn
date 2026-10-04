import { all, get, getSetting, run } from "./db.ts";
import { config } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { callRpc } from "./softether/client.ts";
import { endpointOf, type ServerRow } from "./servers.ts";

export interface BackupRow {
  id: number; server_id: number; created_at: number; created_by: string; sha256: string; size: number; note: string; content: string;
}

/** Backup schedule/retention: saved settings, falling back to the environment configuration. */
export function backupSettings() {
  return getSetting("backup", { enabled: true, intervalHours: config.backupIntervalHours, retention: config.backupRetention });
}

/** Fetch the server's full configuration (vpn_server.config) and store it if it changed. */
export async function takeBackup(server: ServerRow, by: string, note = "", force = false, protectId?: number): Promise<{ id: number; changed: boolean }> {
  const r = await callRpc<{ FileName_str: string; FileData_bin: string }>(endpointOf(server), "GetConfig", {});
  const content = Buffer.from(r.FileData_bin ?? "", "base64").toString("utf8");
  const hash = sha256Hex(content);
  const last = get<{ id: number; sha256: string }>("SELECT id, sha256 FROM config_backups WHERE server_id = ? ORDER BY created_at DESC LIMIT 1", server.id);
  if (!force && last?.sha256 === hash) return { id: last.id, changed: false };
  const res = run(
    "INSERT INTO config_backups (server_id, created_at, created_by, sha256, size, note, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
    server.id, Date.now(), by, hash, Buffer.byteLength(content), note, content,
  );
  prune(server.id, protectId);
  return { id: Number(res.lastInsertRowid), changed: true };
}

function prune(serverId: number, protectId?: number) {
  const retention = backupSettings().retention;
  const old = all<{ id: number }>("SELECT id FROM config_backups WHERE server_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?", serverId, retention);
  for (const o of old) if (o.id !== protectId) run("DELETE FROM config_backups WHERE id = ?", o.id);
}

/**
 * The SoftEther config contains volatile counters and timestamps; strip them so diffs show
 * meaningful changes only.
 */
export function normalizeConfigForDiff(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(uint64|uint)\s+(LastCommTime|LastLoginTime|UpdatedTime|NumLogin|CreatedTime|Recv\.|Send\.|BroadcastBytes|BroadcastCount|UnicastBytes|UnicastCount)/.test(l))
    .filter((l) => !/^\s*uint64\s+(\w+\.)?(BroadcastBytes|BroadcastCount|UnicastBytes|UnicastCount)\b/.test(l))
    .join("\n");
}

export interface DiffLine { type: "same" | "add" | "del"; text: string; a?: number; b?: number }

/** Line diff (Myers-style LCS via DP on changed middle section; fine for config-sized files). */
export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split("\n"), B = b.split("\n");
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const midA = A.slice(start, endA), midB = B.slice(start, endB);
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: "same", text: A[i], a: i + 1, b: i + 1 });
  if (midA.length * midB.length > 25_000_000) {
    midA.forEach((t, i) => out.push({ type: "del", text: t, a: start + i + 1 }));
    midB.forEach((t, i) => out.push({ type: "add", text: t, b: start + i + 1 }));
  } else {
    const n = midA.length, m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { out.push({ type: "same", text: midA[i], a: start + i + 1, b: start + j + 1 }); i++; j++; }
      else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ type: "add", text: midB[j], b: start + j + 1 }); j++; }
      else { out.push({ type: "del", text: midA[i], a: start + i + 1 }); i++; }
    }
  }
  for (let i = endA, j = endB; i < A.length; i++, j++) out.push({ type: "same", text: A[i], a: i + 1, b: j + 1 });
  return out;
}
