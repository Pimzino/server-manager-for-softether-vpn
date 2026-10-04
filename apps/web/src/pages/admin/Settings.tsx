import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Anchor, Badge, Button, Code, Group, NumberInput, Paper, SimpleGrid, Stack, Switch, Text, TextInput, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCircleCheck, IconDeviceFloppy, IconExternalLink, IconLock, IconX } from "@tabler/icons-react";
import { Copyable, PageHeader, QueryState, Section } from "../../components/common";
import { get, put } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { notifyError } from "../../lib/hooks";

interface AppSettings {
  passwordPolicy: { minLength: number; requireMixed: boolean };
  backup: { enabled: boolean; intervalHours: number; retention: number };
  poll: { intervalSec: number };
  loginBanner: string;
  alerts: { enabled: boolean; webhookUrl: string };
  deploy: { packageRetentionDays: number };
}
interface DeployStatus { msitools: { ok: boolean; version?: string; error?: string } }

const LIMITS = {
  minLength: [8, 128], intervalHours: [1, 720], retention: [1, 1000], intervalSec: [10, 3600], banner: 2000,
} as const;

const inRange = (v: number, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && v >= lo && v <= hi;

function fmtInterval(sec: number) {
  return sec < 60 ? `${sec} s` : sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<AppSettings>("/api/settings"), enabled: user?.role === "admin" });
  const deploy = useQuery({ queryKey: ["deploy-status"], queryFn: () => get<DeployStatus>("/api/deploy/status"), enabled: user?.role === "admin" });
  const [form, setForm] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (settings.data) {
      const d = structuredClone(settings.data);
      setForm({ ...d, alerts: d.alerts ?? { enabled: false, webhookUrl: "" }, deploy: d.deploy ?? { packageRetentionDays: 14 } });
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (s: AppSettings) => put("/api/settings", s),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      notifications.show({ color: "green", message: "Settings saved" });
    },
    onError: (e) => notifyError(e, "Settings not saved"),
  });

  if (user?.role !== "admin") {
    return <><PageHeader title="Settings" /><Alert color="gray" icon={<IconLock size={16} />}>Only administrators can change management server settings.</Alert></>;
  }

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = !!form && !!settings.data && JSON.stringify(form) !== JSON.stringify(settings.data);
  const valid = !!form && inRange(form.passwordPolicy.minLength, LIMITS.minLength) && inRange(form.backup.intervalHours, LIMITS.intervalHours)
    && inRange(form.backup.retention, LIMITS.retention) && inRange(form.poll.intervalSec, LIMITS.intervalSec) && form.loginBanner.length <= LIMITS.banner
    && (!form.alerts.enabled || /^https?:\/\/.+/.test(form.alerts.webhookUrl));
  const origin = window.location.origin;
  const metricsUrl = `${origin}/metrics`;
  const scrapeConfig = `scrape_configs:
  - job_name: softether
    scrape_interval: 60s
    metrics_path: /metrics
    scheme: ${window.location.protocol.replace(":", "")}
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/softether-manager.token
    static_configs:
      - targets: ["${window.location.host}"]`;

  const saveBar = (
    <Group gap="xs">
      {dirty && <Badge color="orange" variant="light">Unsaved changes</Badge>}
      <Button variant="default" disabled={!dirty} onClick={() => settings.data && setForm(structuredClone(settings.data))}>Discard</Button>
      <Button leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty || !valid} loading={save.isPending} onClick={() => form && save.mutate(form)} data-testid="settings-save">Save settings</Button>
    </Group>
  );

  return (
    <>
      <PageHeader title="Settings" description="Global settings of this management server. Changes apply immediately to all users and servers." actions={saveBar} />
      <QueryState query={settings}>
        {form && (
          <form onSubmit={(e) => { e.preventDefault(); if (dirty && valid) save.mutate(form); }} data-testid="settings-form">
            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
              <Section title="Password policy" description="Applies when users set or change their management-server password and when admins create or reset accounts. Existing passwords are not re-checked.">
                <Stack>
                  <NumberInput label="Minimum length" min={LIMITS.minLength[0]} max={LIMITS.minLength[1]} allowDecimal={false} value={form.passwordPolicy.minLength}
                    onChange={(v) => set("passwordPolicy", { ...form.passwordPolicy, minLength: Number(v) || 0 })} description="8–128 characters. 12 or more is recommended."
                    error={!inRange(form.passwordPolicy.minLength, LIMITS.minLength) ? "Must be between 8 and 128" : undefined} data-testid="settings-minlength" />
                  <Switch label="Require mixed character classes" description="At least three of: lowercase, uppercase, digits, symbols." checked={form.passwordPolicy.requireMixed}
                    onChange={(e) => set("passwordPolicy", { ...form.passwordPolicy, requireMixed: e.currentTarget.checked })} data-testid="settings-mixed" />
                  <Text size="xs" c="dimmed">Passwords must never contain the username. Accounts lock for 15 minutes after 5 failed sign-ins.</Text>
                </Stack>
              </Section>

              <Section title="Configuration backups" description="The scheduler downloads each server's configuration (server-admin connections only) and stores it when it changed since the previous backup.">
                <Stack>
                  <Switch label="Scheduled backups enabled" checked={form.backup.enabled} onChange={(e) => set("backup", { ...form.backup, enabled: e.currentTarget.checked })} data-testid="settings-backup-enabled" />
                  <NumberInput label="Interval (hours)" min={LIMITS.intervalHours[0]} max={LIMITS.intervalHours[1]} allowDecimal={false} value={form.backup.intervalHours} disabled={!form.backup.enabled}
                    onChange={(v) => set("backup", { ...form.backup, intervalHours: Number(v) || 0 })} description="How often each server is checked, 1–720 hours (30 days)."
                    error={!inRange(form.backup.intervalHours, LIMITS.intervalHours) ? "Must be between 1 and 720" : undefined} data-testid="settings-backup-interval" />
                  <NumberInput label="Retention (backups per server)" min={LIMITS.retention[0]} max={LIMITS.retention[1]} allowDecimal={false} value={form.backup.retention}
                    onChange={(v) => set("backup", { ...form.backup, retention: Number(v) || 0 })} description="Older backups beyond this count are deleted automatically (1–1000). Applies to manual backups too."
                    error={!inRange(form.backup.retention, LIMITS.retention) ? "Must be between 1 and 1000" : undefined} data-testid="settings-backup-retention" />
                </Stack>
              </Section>

              <Section title="Status polling" description="How often the management server polls every enabled VPN Server for status, hub list and reachability (used by the dashboard, alerts and /metrics).">
                <NumberInput label="Poll interval (seconds)" min={LIMITS.intervalSec[0]} max={LIMITS.intervalSec[1]} allowDecimal={false} value={form.poll.intervalSec}
                  onChange={(v) => set("poll", { intervalSec: Number(v) || 0 })}
                  description={inRange(form.poll.intervalSec, LIMITS.intervalSec) ? `Every ${fmtInterval(form.poll.intervalSec)}. 10–3600 s; shorter intervals increase load on large fleets.` : "10–3600 seconds"}
                  error={!inRange(form.poll.intervalSec, LIMITS.intervalSec) ? "Must be between 10 and 3600" : undefined} data-testid="settings-poll" />
              </Section>

              <Section title="Alerts" description="When a VPN Server becomes unreachable or recovers, the management server records server.down / server.up in the audit log and, if enabled, POSTs JSON {text, event, server, error, at} to this webhook. The text field works directly with Slack and Microsoft Teams incoming webhooks.">
                <Stack gap="sm">
                  <Switch label="Send alerts to a webhook" checked={form.alerts.enabled} onChange={(e) => set("alerts", { ...form.alerts, enabled: e.currentTarget.checked })} data-testid="settings-alerts-enabled" />
                  <TextInput label="Webhook URL" placeholder="https://hooks.slack.com/services/…" value={form.alerts.webhookUrl}
                    onChange={(e) => set("alerts", { ...form.alerts, webhookUrl: e.currentTarget.value.trim() })}
                    error={form.alerts.enabled && !/^https?:\/\/.+/.test(form.alerts.webhookUrl) ? "Enter an http(s) URL" : undefined} data-testid="settings-alerts-url" />
                </Stack>
              </Section>

              <Section title="Client packages" description="Per-user .vpn files, MSIs and setup.exe packages contain credentials. They are deleted from the management server automatically after this many days (download them before then).">
                <NumberInput label="Keep per-user packages (days)" min={1} max={365} allowDecimal={false} value={form.deploy.packageRetentionDays}
                  onChange={(v) => set("deploy", { packageRetentionDays: Number(v) || 14 })} w={260} data-testid="settings-package-retention" />
              </Section>

              <Section title="Login banner" description="Shown on the sign-in page, e.g. an acceptable-use or legal notice. Plain text; line breaks are kept.">
                <Stack>
                  <Textarea autosize minRows={3} maxRows={10} value={form.loginBanner} onChange={(e) => set("loginBanner", e.currentTarget.value)} maxLength={LIMITS.banner}
                    placeholder="Authorised use only. Activity is logged." description={`${form.loginBanner.length} / ${LIMITS.banner} characters`} data-testid="settings-banner" />
                  {form.loginBanner && (
                    <Alert color="blue" variant="light" title="Preview"><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{form.loginBanner}</Text></Alert>
                  )}
                </Stack>
              </Section>
            </SimpleGrid>
            <Group justify="flex-end" mb="md">{saveBar}</Group>
          </form>
        )}
      </QueryState>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Section title="MSI installer builder" description="Building Windows MSI installers for VPN Client deployment requires msitools (wixl) on the management server host.">
          <QueryState query={deploy}>
            {deploy.data && (deploy.data.msitools.ok ? (
              <Group gap="xs" data-testid="msitools-status"><IconCircleCheck size={20} color="var(--mantine-color-green-6)" /><Text size="sm">msitools available — wixl <Code>{deploy.data.msitools.version}</Code></Text></Group>
            ) : (
              <Alert color="orange" icon={<IconX size={16} />} title="msitools not available" data-testid="msitools-status">
                <Text size="sm">{deploy.data.msitools.error}</Text>
                <Text size="sm" mt={4}>Install it on the host (<Code>brew install msitools</Code> or <Code>apt install wixl</Code>) and reload this page. Connection profiles and client packages still work without it.</Text>
              </Alert>
            ))}
          </QueryState>
          <Text size="sm" mt="sm"><Anchor component={Link} to="/deploy/installers">Go to MSI installers</Anchor></Text>
        </Section>

        <Section title="Prometheus metrics" description="The management server exposes cached fleet state in Prometheus text format at /metrics (no extra load on the VPN Servers).">
          <Stack gap="xs" data-testid="metrics-docs">
            <Group gap="xs"><Text size="sm" fw={600}>Endpoint</Text><Copyable value={metricsUrl} />
              <Anchor href="/metrics" target="_blank" rel="noopener" size="sm"><Group gap={2}>open <IconExternalLink size={12} /></Group></Anchor></Group>
            <Text size="sm">
              Scrapers authenticate with a personal API token sent as <Code>Authorization: Bearer &lt;token&gt;</Code>. Create one under <Anchor component={Link} to="/account">My account → API tokens</Anchor> —
              preferably for a dedicated <b>viewer</b> user, since the metrics include only the servers that user can see.
            </Text>
            <Text size="sm" fw={600} mt="xs">Test with curl</Text>
            <Code block>{`curl -H "Authorization: Bearer sem_…" ${metricsUrl}`}</Code>
            <Text size="sm" fw={600} mt="xs">prometheus.yml</Text>
            <Code block>{scrapeConfig}</Code>
            <Paper withBorder p="xs" radius="sm">
              <Text size="xs" c="dimmed">
                Exported series (label <Code>server</Code>, plus <Code>hub</Code> for hub metrics): softether_up, softether_poll_latency_ms, softether_sessions, softether_tcp_connections,
                softether_hubs, softether_users, softether_groups, softether_mac_table_entries, softether_ip_table_entries, softether_recv/send_unicast/broadcast_bytes_total,
                softether_memory_used_bytes, softether_memory_total_bytes, softether_hub_sessions, softether_hub_online.
              </Text>
            </Paper>
            <Text size="xs" c="dimmed">Example alert: <Code>softether_up == 0</Code> for 5 minutes → server unreachable.</Text>
          </Stack>
        </Section>
      </SimpleGrid>
    </>
  );
}
