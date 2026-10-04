// Preferences: appearance (this window), monitoring and backups (/api/settings), about.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, NumberInput, SegmentedControl, Select, Switch, useMantineColorScheme, type MantineColorScheme } from "@mantine/core";
import { IconFolder } from "@tabler/icons-react";
import { get, put, revealPath } from "../lib/api";
import { notifyError } from "../lib/hooks";
import { isMac } from "../lib/platform";
import type { AppSettings } from "../lib/types";
import type { AppInfo } from "../../shared/ipc";
import { CopyField, ErrorState, FormRow, FormSection, PageHeader, PropertySkeleton, PropertyList } from "../design";
import appIcon from "../assets/app-icon.png";

const POLL_OPTIONS = [15, 30, 60, 120, 300, 600].map((s) => ({ value: String(s), label: s < 60 ? `Every ${s} seconds` : s === 60 ? "Every minute" : `Every ${s / 60} minutes` }));

export default function Preferences() {
  const qc = useQueryClient();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<AppSettings>("/api/settings") });
  const info = useQuery({ queryKey: ["app-info"], queryFn: () => window.sem.info(), staleTime: Infinity });
  const [form, setForm] = useState<AppSettings | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { if (settings.data && !form) setForm(structuredClone(settings.data)); }, [settings.data, form]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Same bounds as the settings route (routes/settings.ts); SEM_POLL_INTERVAL_SEC may set 5 s.
  const isValid = (f: AppSettings) => f.backup.intervalHours >= 1 && f.backup.intervalHours <= 720 && f.backup.retention >= 1 && f.backup.retention <= 1000
    && f.poll.intervalSec >= 5 && f.poll.intervalSec <= 3600 && (!f.deploy || (f.deploy.packageRetentionDays >= 1 && f.deploy.packageRetentionDays <= 365));
  const pollOptions = useMemo(() => {
    const cur = form ? String(form.poll.intervalSec) : null;
    return cur && !POLL_OPTIONS.some((o) => o.value === cur) ? [...POLL_OPTIONS, { value: cur, label: `Every ${cur} seconds` }] : POLL_OPTIONS;
  }, [form]);

  // Preferences apply as you change them, like the system's own settings windows.
  const schedule = (next: AppSettings) => {
    clearTimeout(timer.current);
    if (!isValid(next)) return;
    timer.current = setTimeout(async () => {
      setSaveState("saving");
      try {
        await put("/api/settings", next);
        qc.setQueryData(["settings"], next);
        setSaveState("saved");
      } catch (e) {
        notifyError(e, "Preferences weren’t saved");
        setSaveState("idle");
      }
    }, 500);
  };
  const patch = (fn: (f: AppSettings) => void) => setForm((f) => {
    if (!f) return f;
    const n = structuredClone(f);
    fn(n);
    schedule(n);
    return n;
  });

  return (
    <div className="sem-prefs">
      <PageHeader title="Preferences" meta={<span data-testid="prefs-save-state">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved" : "Changes apply immediately"}</span>} />

      <FormSection title="General">
        <FormRow label="Appearance" description="Follows your system setting unless you choose otherwise.">
          <SegmentedControl
            value={colorScheme}
            onChange={(v) => setColorScheme(v as MantineColorScheme)}
            data={[{ value: "auto", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
            data-testid="pref-theme"
          />
        </FormRow>
      </FormSection>

      {settings.error ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : !form ? <PropertySkeleton rows={4} /> : (
        <>
          <FormSection title="Monitoring" description="How often the app checks each server’s status, sessions and hubs in the background.">
            <FormRow label="Check servers">{(id) => (
              <Select id={id} data={pollOptions} value={String(form.poll.intervalSec)} onChange={(v) => v && patch((f) => { f.poll.intervalSec = Number(v); })} w={220} data-testid="pref-poll" />
            )}</FormRow>
          </FormSection>

          <FormSection title="Configuration backups" description="Snapshots of each server’s configuration, for comparing and restoring. Stored on this computer.">
            <FormRow label="Automatic backups" description="Take a snapshot of every reachable server on a schedule.">
              <Switch checked={form.backup.enabled} onChange={(e) => { const v = e.currentTarget.checked; patch((f) => { f.backup.enabled = v; }); }} data-testid="pref-backup-enabled" aria-label="Automatic backups" />
            </FormRow>
            <FormRow label="Back up every">{(id) => (
              <NumberInput id={id} value={form.backup.intervalHours} onChange={(v) => patch((f) => { f.backup.intervalHours = Number(v) || 0; })} min={1} max={720} w={140}
                rightSection={<span className="sem-input-unit">hours</span>} rightSectionWidth={52} disabled={!form.backup.enabled} allowDecimal={false} data-testid="pref-backup-interval" />
            )}</FormRow>
            <FormRow label="Keep" description="Older automatic backups are deleted. Manual backups are kept until you delete them.">{(id) => (
              <NumberInput id={id} value={form.backup.retention} onChange={(v) => patch((f) => { f.backup.retention = Number(v) || 0; })} min={1} max={1000} w={140}
                rightSection={<span className="sem-input-unit">per server</span>} rightSectionWidth={72} allowDecimal={false} data-testid="pref-backup-retention" />
            )}</FormRow>
          </FormSection>

          {form.deploy && (
            <FormSection title="Client Deployment">
              <FormRow label="Keep built packages" description="Built installers and profile bundles older than this are removed.">{(id) => (
                <NumberInput id={id} value={form.deploy!.packageRetentionDays} onChange={(v) => patch((f) => { f.deploy!.packageRetentionDays = Number(v) || 0; })} min={1} max={365} w={140}
                  rightSection={<span className="sem-input-unit">days</span>} rightSectionWidth={44} allowDecimal={false} />
              )}</FormRow>
            </FormSection>
          )}
        </>
      )}

      <FormSection title="About">
        <div className="sem-about">
          <img src={appIcon} alt="" width={56} height={56} />
          <div>
            <div className="sem-about-name">SoftEther Manager</div>
            <div className="sem-dim">{info.data ? `Version ${info.data.version}` : "…"}</div>
          </div>
        </div>
        {info.data && <AboutDetails info={info.data} />}
      </FormSection>
    </div>
  );
}

function AboutDetails({ info }: { info: AppInfo }) {
  const os = info.platform === "darwin" ? "macOS" : info.platform === "win32" ? "Windows" : info.platform;
  return (
    <div className="sem-about-details">
      <PropertyList labelWidth={120} dense items={[
        { label: "Platform", value: `${os} (${info.arch})` },
        { label: "Electron", value: info.electron },
        { label: "Node.js", value: info.node },
        { label: "Data folder", value: (
          <span className="sem-row-inline">
            <CopyField value={info.dataDir} size="sm" />
            <Button size="xs" variant="default" leftSection={<IconFolder size={13} />} onClick={() => void revealPath(info.dataDir)}>
              {isMac() ? "Show in Finder" : "Show in Explorer"}
            </Button>
          </span>
        ) },
      ]} />
    </div>
  );
}
