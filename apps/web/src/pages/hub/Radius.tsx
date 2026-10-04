import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Alert, Anchor, Badge, List, NumberInput, PasswordInput, SimpleGrid, Stack, TagsInput, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { ConfirmButton, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { SaveBar, useDocs, useHubAccess } from "../../components/hub-a/shared";
import { useRpc, useRpcMutation } from "../../lib/hooks";

interface RadiusCfg {
  HubName_str?: string;
  RadiusServerName_str: string;
  RadiusPort_u32: number;
  RadiusSecret_str: string;
  RadiusRetryInterval_u32: number;
  /** Not in the published stubs but returned and honoured by SoftEther 4.x/5.x. */
  RadiusRetryTimeout_u32?: number;
  [k: string]: unknown;
}

interface Form { servers: string[]; port: number; secret: string; interval: number; timeout: number }

const DEFAULT_PORT = 1812;
const DEFAULT_INTERVAL = 1000; // RADIUS_RETRY_INTERVAL
const DEFAULT_TIMEOUT = 15000; // RADIUS_RETRY_TIMEOUT

const toForm = (r: RadiusCfg): Form => ({
  servers: (r.RadiusServerName_str ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean),
  port: Number(r.RadiusPort_u32) || DEFAULT_PORT,
  secret: r.RadiusSecret_str ?? "",
  interval: Number(r.RadiusRetryInterval_u32) || DEFAULT_INTERVAL,
  timeout: Number(r.RadiusRetryTimeout_u32) || DEFAULT_TIMEOUT,
});

const HOST_RE = /^[A-Za-z0-9.\-:[\]_]+$/;

export default function HubRadiusPage() {
  const { serverId, hub, role, canWrite, base } = useHubAccess();
  const doc = useDocs("VpnRpcRadius");
  const q = useRpc<RadiusCfg>(serverId, "GetHubRadius", { HubName_str: hub }, { enabled: !!hub });
  const initial = useMemo(() => (q.data ? toForm(q.data) : null), [q.data]);
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => setForm(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHubRadius", { success: "RADIUS settings saved" });
  const disable = useRpcMutation(serverId, "SetHubRadius", { success: "RADIUS authentication disabled" });

  const configured = !!q.data?.RadiusServerName_str;
  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);
  const badHost = form?.servers.find((s) => !HOST_RE.test(s));
  const errors = form ? {
    servers: badHost ? `Invalid host name: ${badHost}` : undefined,
    port: form.port < 1 || form.port > 65535 ? "Port must be 1–65535" : undefined,
    secret: form.servers.length > 0 && !form.secret ? "A shared secret is required" : undefined,
    interval: form.interval < 500 ? "Minimum 500 ms" : form.interval > form.timeout ? "Must not exceed the timeout" : undefined,
    timeout: form.timeout < 1000 ? "Minimum 1000 ms" : undefined,
  } : {};
  const invalid = Object.values(errors).some(Boolean);

  const payload = (f: Form): RadiusCfg => ({
    ...(q.data ?? {}),
    HubName_str: hub,
    RadiusServerName_str: f.servers.join(","),
    RadiusPort_u32: f.port,
    RadiusSecret_str: f.secret,
    RadiusRetryInterval_u32: f.interval,
    RadiusRetryTimeout_u32: f.timeout,
  });

  return (
    <>
      <PageHeader
        title="RADIUS authentication"
        badge={q.data && <Badge variant="light" color={configured ? "green" : "gray"}>{configured ? "Configured" : "Not configured"}</Badge>}
        description="External RADIUS server that verifies user names and passwords for users of this Virtual Hub whose authentication type is “RADIUS authentication”."
      />
      {!canWrite && <ReadOnlyNotice role={role} />}
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />} mb="md" title="How RADIUS authentication works">
        <List size="sm" spacing={2}>
          <List.Item>Only users whose <b>authentication type</b> is set to <i>RADIUS</i> are checked against this server — configure them on the{" "}
            <Anchor component={Link} to={`${base}/users`} size="sm">Users</Anchor> page. A user named <code>*</code> with RADIUS auth accepts any user name known to the RADIUS server.</List.Item>
          <List.Item>The RADIUS server must accept requests from this VPN Server's IP address and must allow PAP (Password Authentication Protocol).</List.Item>
          <List.Item>Several servers may be listed; they are tried in order when one does not answer.</List.Item>
        </List>
      </Alert>
      <QueryState query={q}>
        {form && (
          <Section
            title="RADIUS server"
            actions={canWrite && configured && (
              <ConfirmButton
                title="Disable RADIUS authentication?"
                message="The RADIUS server setting is cleared. Users with RADIUS authentication will no longer be able to log in to this hub."
                confirmLabel="Disable"
                onConfirm={() => disable.mutateAsync({ HubName_str: hub, RadiusServerName_str: "", RadiusPort_u32: DEFAULT_PORT, RadiusSecret_str: "", RadiusRetryInterval_u32: DEFAULT_INTERVAL, RadiusRetryTimeout_u32: DEFAULT_TIMEOUT })}
              >
                <span data-testid="radius-disable">Disable RADIUS</span>
              </ConfirmButton>
            )}
          >
            <Stack gap="md" data-testid="radius-form">
              <TagsInput
                label="RADIUS server host name(s) or IP address(es)"
                description={`${doc("RadiusServerName_str", "RADIUS server name")}. Press Enter or type a comma after each server; order defines the fail-over order. Leave empty to disable.`}
                placeholder={form.servers.length ? "" : "radius1.example.com, 10.0.0.5"}
                value={form.servers}
                onChange={(v) => setForm({ ...form, servers: v.map((s) => s.trim()).filter(Boolean) })}
                splitChars={[",", ";", " "]}
                clearable
                readOnly={!canWrite}
                error={errors.servers}
                data-testid="radius-servers"
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <NumberInput
                  label="Port"
                  description={`${doc("RadiusPort_u32", "RADIUS port number")} (UDP). Standard: 1812.`}
                  min={1} max={65535} allowDecimal={false} allowNegative={false}
                  value={form.port} readOnly={!canWrite} error={errors.port}
                  onChange={(v) => setForm({ ...form, port: Number(v) || 0 })}
                  data-testid="radius-port"
                />
                <PasswordInput
                  label="Shared secret"
                  description={`${doc("RadiusSecret_str", "Secret key")} shared between this VPN Server and the RADIUS server.`}
                  value={form.secret} readOnly={!canWrite} error={errors.secret}
                  onChange={(e) => setForm({ ...form, secret: e.currentTarget.value })}
                  autoComplete="new-password"
                  data-testid="radius-secret"
                />
                <NumberInput
                  label="Retry interval (ms)"
                  description={`${doc("RadiusRetryInterval_u32", "Radius retry interval")}: how long to wait for an answer before re-sending the request. Default 1000 ms.`}
                  min={500} step={100} allowDecimal={false} allowNegative={false} thousandSeparator=","
                  value={form.interval} readOnly={!canWrite} error={errors.interval}
                  onChange={(v) => setForm({ ...form, interval: Number(v) || 0 })}
                  data-testid="radius-interval"
                />
                <NumberInput
                  label="Timeout (ms)"
                  description="Total time after which authentication gives up and fails. Default 15000 ms; raise it for RADIUS servers that perform push / 2FA approvals."
                  min={1000} step={1000} allowDecimal={false} allowNegative={false} thousandSeparator=","
                  value={form.timeout} readOnly={!canWrite} error={errors.timeout}
                  onChange={(v) => setForm({ ...form, timeout: Number(v) || 0 })}
                  data-testid="radius-timeout"
                />
              </SimpleGrid>
              {!form.servers.length && dirty && (
                <Text size="sm" c="orange">No server is listed: saving disables RADIUS authentication for this hub.</Text>
              )}
            </Stack>
            {canWrite && (
              <SaveBar dirty={dirty} disabled={invalid} saving={save.isPending} onReset={() => setForm(initial)}
                onSave={() => save.mutate(payload(form))} testId="radius-save" />
            )}
          </Section>
        )}
      </QueryState>
    </>
  );
}
