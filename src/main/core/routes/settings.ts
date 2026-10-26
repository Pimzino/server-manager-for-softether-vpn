import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSetting, setSetting } from "../db.ts";
import { config } from "../config.ts";
import { backupSettings } from "../backups.ts";

type SettingsListener = (keys: string[]) => void;
const listeners = new Set<SettingsListener>();
/** main.ts reschedules polling when the interval changes. */
export function onSettingsChange(fn: SettingsListener) { listeners.add(fn); return () => listeners.delete(fn); }

export function currentSettings() {
  return {
    backup: backupSettings(),
    poll: getSetting("poll", { intervalSec: config.pollIntervalSec }),
    alerts: getSetting("alerts", { enabled: false, webhookUrl: "" }),
    deploy: { packageRetentionDays: 14, ...getSetting<{ packageRetentionDays?: number }>("deploy", {}) },
    keystore: config.keystoreMode,
  };
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => currentSettings());

  app.put("/api/settings", async (req) => {
    const b = z.object({
      backup: z.object({ enabled: z.boolean(), intervalHours: z.number().int().min(1).max(24 * 30), retention: z.number().int().min(1).max(1000) }).optional(),
      poll: z.object({ intervalSec: z.number().int().min(5).max(3600) }).optional(),
      alerts: z.object({ enabled: z.boolean(), webhookUrl: z.string().url().refine((u) => /^https?:/i.test(u), "Must be an http(s) URL").or(z.literal("")) }).optional(),
      deploy: z.object({ packageRetentionDays: z.number().int().min(1).max(365) }).optional(),
    }).parse(req.body);
    const changed: string[] = [];
    for (const [k, v] of Object.entries(b)) if (v !== undefined) { setSetting(k, v); changed.push(k); }
    for (const l of listeners) { try { l(changed); } catch { /* ignore */ } }
    return { ok: true, settings: currentSettings() };
  });
}
