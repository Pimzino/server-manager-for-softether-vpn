// Hub › RADIUS. External RADIUS server(s) for users whose authentication type is RADIUS (GetHubRadius /
// SetHubRadius). Ported from apps/web/src/pages/hub/Radius.tsx.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { NumberInput, PasswordInput, TagsInput } from "@mantine/core";
import { IconInfoCircle, IconPlugOff } from "@tabler/icons-react";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { useDocs } from "../../components/domain/hooks";
import { Callout, SaveBar } from "../../components/domain/ui";
import { ConfirmButton, FormRow, FormSection, PageHeader, PropertySkeleton, QueryState, Tag } from "../../design";
import { HubUnreachable, sameJson, useHubPage } from "./_hub-core/shared";

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
const HOST_RE = /^[A-Za-z0-9.\-:[\]_]+$/;

const toForm = (r: RadiusCfg): Form => ({
  servers: (r.RadiusServerName_str ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean),
  port: Number(r.RadiusPort_u32) || DEFAULT_PORT,
  secret: r.RadiusSecret_str ?? "",
  interval: Number(r.RadiusRetryInterval_u32) || DEFAULT_INTERVAL,
  timeout: Number(r.RadiusRetryTimeout_u32) || DEFAULT_TIMEOUT,
});

export default function HubRadiusPage() {
  const { serverId, hub, base, ready, server } = useHubPage();
  const doc = useDocs("VpnRpcRadius");
  const q = useRpc<RadiusCfg>(serverId, "GetHubRadius", { HubName_str: hub }, { enabled: ready });
  const initial = useMemo(() => (q.data ? toForm(q.data) : null), [q.data]);
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => setForm(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHubRadius", { success: "RADIUS settings saved" });
  const disable = useRpcMutation(serverId, "SetHubRadius", { success: "RADIUS authentication turned off", confirm: false });

  if (!server.data) return null;
  const configured = !!q.data?.RadiusServerName_str;
  const dirty = !!form && !!initial && !sameJson(form, initial);
  const badHost = form?.servers.find((s) => !HOST_RE.test(s));
  const errors = form ? {
    servers: badHost ? `“${badHost}” isn’t a host name or IP address.` : undefined,
    port: form.port < 1 || form.port > 65535 ? "Use a port from 1 to 65535." : undefined,
    secret: form.servers.length > 0 && !form.secret ? "Enter the shared secret the RADIUS server expects." : undefined,
    interval: form.interval < 500 ? "Use at least 500 ms." : form.interval > form.timeout ? "Must not be longer than the timeout." : undefined,
    timeout: form.timeout < 1000 ? "Use at least 1,000 ms." : undefined,
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
        title="RADIUS"
        badge={q.data && <Tag color={configured ? "green" : "gray"} testId="radius-state">{configured ? "Configured" : "Not configured"}</Tag>}
        description="Checks the passwords of this hub’s users whose authentication type is RADIUS against an external RADIUS server."
        actions={ready && configured && (
          <ConfirmButton
            title={<>Turn off RADIUS authentication for “{hub}”?</>}
            message="The RADIUS server setting is cleared. Users with RADIUS authentication can’t log in to this hub until you set it again."
            confirmLabel="Turn Off RADIUS" leftSection={<IconPlugOff size={14} />}
            onConfirm={() => disable.mutateAsync({
              HubName_str: hub, RadiusServerName_str: "", RadiusPort_u32: DEFAULT_PORT, RadiusSecret_str: "",
              RadiusRetryInterval_u32: DEFAULT_INTERVAL, RadiusRetryTimeout_u32: DEFAULT_TIMEOUT,
            })}
            testId="radius-disable"
          >Turn Off RADIUS…</ConfirmButton>
        )}
      />
      {!ready ? <HubUnreachable serverId={serverId} /> : (
        <>
          <div className="sem-callouts" style={{ marginTop: 0 }}>
            <Callout tone="accent" icon={<IconInfoCircle size={16} stroke={1.7} />} title="How RADIUS authentication works" testId="radius-help">
              <ul style={{ margin: "var(--sem-space-2) 0 0", paddingLeft: 18 }}>
                <li>Only users whose authentication type is RADIUS are checked. Set it on the <Link to={`${base}/users`}>Users</Link> page. A user named <span className="sem-mono">*</span> with RADIUS authentication accepts any user name the RADIUS server knows.</li>
                <li>The RADIUS server must accept requests from this VPN Server’s IP address and allow PAP.</li>
                <li>List several servers to fail over: they’re tried in order when one doesn’t answer.</li>
              </ul>
            </Callout>
          </div>
          <QueryState query={q} skeleton={<PropertySkeleton rows={5} />}>
            {form && (
              <>
                <FormSection title="RADIUS server" testId="radius-form">
                  <FormRow label="Servers" align="start" error={errors.servers}
                    description={<>{doc("RadiusServerName_str", "RADIUS server name")}. Host names or IP addresses in fail-over order; press Return after each. Leave empty to turn RADIUS off.</>}>
                    {(id) => (
                      <TagsInput
                        id={id} value={form.servers} splitChars={[",", ";", " "]} clearable
                        placeholder={form.servers.length ? "" : "radius1.example.com, 10.0.0.5"}
                        onChange={(v) => setForm({ ...form, servers: v.map((s) => s.trim()).filter(Boolean) })}
                        error={!!errors.servers} data-testid="radius-servers"
                      />
                    )}
                  </FormRow>
                  <FormRow label="Port" description={<>{doc("RadiusPort_u32", "RADIUS port number")} (UDP). The standard port is 1812.</>} error={errors.port}>
                    {(id) => <NumberInput id={id} w={120} min={1} max={65535} allowDecimal={false} allowNegative={false} value={form.port}
                      error={!!errors.port} onChange={(v) => setForm({ ...form, port: Number(v) || 0 })} data-testid="radius-port" />}
                  </FormRow>
                  <FormRow label="Shared secret" description="The secret this VPN Server and the RADIUS server share." error={errors.secret}>
                    {(id) => <PasswordInput id={id} w={280} value={form.secret} error={!!errors.secret} autoComplete="new-password"
                      onChange={(e) => setForm({ ...form, secret: e.currentTarget.value })} data-testid="radius-secret" />}
                  </FormRow>
                </FormSection>

                <FormSection title="Retries" description="Raise the timeout for RADIUS servers that wait for a push or two-factor approval.">
                  <FormRow label="Retry interval" description="How long to wait for an answer before sending the request again. Default 1,000 ms." error={errors.interval}>
                    {(id) => (
                      <div className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                        <NumberInput id={id} w={120} min={500} step={100} allowDecimal={false} allowNegative={false} thousandSeparator=","
                          value={form.interval} error={!!errors.interval} onChange={(v) => setForm({ ...form, interval: Number(v) || 0 })} data-testid="radius-interval" />
                        <span className="sem-dim">ms</span>
                      </div>
                    )}
                  </FormRow>
                  <FormRow label="Timeout" description="Authentication fails after this long without an answer. Default 15,000 ms." error={errors.timeout}>
                    {(id) => (
                      <div className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                        <NumberInput id={id} w={120} min={1000} step={1000} allowDecimal={false} allowNegative={false} thousandSeparator=","
                          value={form.timeout} error={!!errors.timeout} onChange={(v) => setForm({ ...form, timeout: Number(v) || 0 })} data-testid="radius-timeout" />
                        <span className="sem-dim">ms</span>
                      </div>
                    )}
                  </FormRow>
                </FormSection>
                <SaveBar
                  dirty={dirty} disabled={invalid} saving={save.isPending} onReset={() => setForm(initial)}
                  onSave={() => save.mutate(payload(form))} testId="radius-save"
                  note={!form.servers.length && configured ? "No server is listed: saving turns RADIUS authentication off." : undefined}
                />
              </>
            )}
          </QueryState>
        </>
      )}
    </>
  );
}
