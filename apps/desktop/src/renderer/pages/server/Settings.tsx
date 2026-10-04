// Server › Server Settings: keep-alive, syslog forwarding, the administrator message and the default
// Virtual Hub administration options. Each group applies with its own RPC, so each has its own Save.
import { useEffect, useState } from "react";
import { NumberInput, SegmentedControl, Switch, TextInput } from "@mantine/core";
import { IconMessage2, IconStack2 } from "@tabler/icons-react";
import { useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { b64ToText, num } from "../../lib/format";
import { DataTable, EmptyState, ErrorState, FormRow, FormSection, PageHeader, PropertySkeleton, Section, Tag } from "../../design";
import { HelpLabel } from "../../components/domain/ui";
import { SectionButtons, SyslogSection, Unreachable, hostValid, useReachable } from "./_server-advanced/shared";

interface Keep { UseKeepConnect_bool?: boolean; KeepConnectHost_str?: string; KeepConnectPort_u32?: number; KeepConnectProtocol_u32?: number; KeepConnectInterval_u32?: number }
interface AdminOpt { Name_str: string; Value_u32: number; Descrption_utf: string }

const KEEP_DOC = {
  use: "Sends small packets to a server at a fixed interval so NAT routers and mobile links don’t drop idle connections. The packets carry random data and nothing that identifies this computer or its users.",
  host: "Host name or IP address the keep-alive packets are sent to.",
  interval: "Time between two packets, from 5 to 600 seconds.",
};

function KeepAliveSection({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const q = useRpc<Keep>(serverId, "GetKeep", {}, { enabled });
  const [f, setF] = useState<Keep>({});
  const reset = () => { if (q.data) setF(q.data); };
  useEffect(reset, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useRpcMutation(serverId, "SetKeep", { success: "Keep-alive settings saved" });
  const d = q.data;
  const dirty = !!d && (Object.keys(f) as (keyof Keep)[]).some((k) => f[k] !== d[k]);
  const on = !!f.UseKeepConnect_bool;
  const host = (f.KeepConnectHost_str ?? "").trim();
  const hostErr = on && !host ? "Enter the destination host." : host && !hostValid(host) ? "Enter a host name or an IP address." : undefined;
  const portErr = on && (!f.KeepConnectPort_u32 || f.KeepConnectPort_u32 > 65535) ? "Enter a port from 1 to 65535." : undefined;
  const intErr = on && (!f.KeepConnectInterval_u32 || f.KeepConnectInterval_u32 < 5 || f.KeepConnectInterval_u32 > 600) ? "Enter 5 to 600 seconds." : undefined;
  return (
    <FormSection
      title="Keep-alive"
      description="Keeps the Internet connection of the VPN Server open by sending packets to a server at a fixed interval."
      testId="keep-section"
      footer={d && <SectionButtons dirty={dirty} valid={!hostErr && !portErr && !intErr} saving={save.isPending} onRevert={reset}
        onSave={() => save.mutate({ ...d, ...f, KeepConnectHost_str: host })} testId="save-keep" />}
    >
      {q.error ? <div style={{ padding: "10px 0" }}><ErrorState error={q.error} inline onRetry={() => void q.refetch()} /></div>
        : !d ? <div style={{ padding: "10px 0" }}><PropertySkeleton rows={4} /></div> : (
          <>
            <FormRow label={<HelpLabel label="Send keep-alive packets" doc={KEEP_DOC.use} />}>
              <Switch checked={on} onChange={(e) => { const v = e.currentTarget.checked; setF((s) => ({ ...s, UseKeepConnect_bool: v })); }}
                aria-label="Send keep-alive packets" data-testid="keep-enable" />
            </FormRow>
            <FormRow label={<HelpLabel label="Destination" doc={KEEP_DOC.host} />} error={hostErr}>{(id) => (
              <TextInput id={id} w={320} value={f.KeepConnectHost_str ?? ""} disabled={!on} spellCheck={false} error={!!hostErr}
                onChange={(e) => { const v = e.currentTarget.value; setF((s) => ({ ...s, KeepConnectHost_str: v })); }} data-testid="keep-host" />
            )}</FormRow>
            <FormRow label="Port" error={portErr}>{(id) => (
              <NumberInput id={id} w={120} min={1} max={65535} allowDecimal={false} allowNegative={false} value={f.KeepConnectPort_u32 ?? 80} disabled={!on} error={!!portErr}
                onChange={(v) => setF((s) => ({ ...s, KeepConnectPort_u32: Number(v) || 0 }))} data-testid="keep-port" />
            )}</FormRow>
            <FormRow label="Protocol">
              <SegmentedControl size="xs" disabled={!on} data={[{ value: "0", label: "TCP" }, { value: "1", label: "UDP" }]} value={String(f.KeepConnectProtocol_u32 ?? 1)}
                onChange={(v) => setF((s) => ({ ...s, KeepConnectProtocol_u32: Number(v) }))} data-testid="keep-protocol" aria-label="Protocol" />
            </FormRow>
            <FormRow label={<HelpLabel label="Interval" doc={KEEP_DOC.interval} />} error={intErr}>{(id) => (
              <NumberInput id={id} w={140} min={5} max={600} allowDecimal={false} allowNegative={false} value={f.KeepConnectInterval_u32 ?? 50} disabled={!on} error={!!intErr}
                rightSection={<span className="sem-input-unit">seconds</span>} rightSectionWidth={62}
                onChange={(v) => setF((s) => ({ ...s, KeepConnectInterval_u32: Number(v) || 0 }))} data-testid="keep-interval" />
            )}</FormRow>
          </>
        )}
    </FormSection>
  );
}

function AdminMessageSection({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const q = useRpc<{ Msg_bin?: string }>(serverId, "GetAdminMsg", {}, { enabled });
  const text = b64ToText(q.data?.Msg_bin).trim();
  return (
    <Section title="Message for administrators" description="Shown by the VPN Server to administrators when they connect, for example vendor notices. Read-only.">
      {q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} />
        : !q.data ? <PropertySkeleton rows={2} />
        : text ? <pre className="sa-text" style={{ margin: 0, padding: "10px 12px", whiteSpace: "pre-wrap", maxHeight: 240 }} data-testid="admin-msg">{text}</pre>
        : (
          <div className="sem-inset" data-testid="admin-msg-empty">
            <span className="sem-row-inline sem-dim" style={{ gap: 8 }}><IconMessage2 size={15} stroke={1.5} />The server has no message for administrators.</span>
          </div>
        )}
    </Section>
  );
}

function DefaultAdminOptionsSection({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  // The defaults are server-wide, but the RPC's input type carries HubName_str: pass any existing hub.
  const hubs = useRpc<{ HubList?: { HubName_str: string }[] }>(serverId, "EnumHub", {}, { enabled });
  const anyHub = hubs.data?.HubList?.map((h) => h.HubName_str).sort()[0];
  const q = useRpc<{ AdminOptionList?: AdminOpt[] }>(serverId, "GetDefaultHubAdminOptions", { HubName_str: anyHub ?? "" }, { enabled: enabled && !!anyHub });
  const noHubs = !!hubs.data && !anyHub;
  const changed = (q.data?.AdminOptionList ?? []).filter((o) => o.Value_u32 !== 0).length;
  return (
    <Section
      title="Default hub administration options"
      description="Values that new Virtual Hubs start with. Each hub’s own values are on its Admin & Extended Options page."
      actions={q.data && <Tag>{num(q.data.AdminOptionList?.length ?? 0)} options · {num(changed)} non-zero</Tag>}
    >
      {noHubs ? (
        <div className="sem-inset">
          <EmptyState compact icon={<IconStack2 size={22} stroke={1.4} />} title="No Virtual Hubs"
            description="The server reports these defaults through an existing hub. Create a hub to see them." />
        </div>
      ) : (
        <DataTable
          testId="default-admin-options-table"
          aria-label="Default hub administration options"
          data={q.data?.AdminOptionList}
          loading={hubs.isLoading || (q.isLoading && !!anyHub)}
          error={hubs.error ?? q.error}
          onRetry={() => { void hubs.refetch(); void q.refetch(); }}
          rowKey={(r) => r.Name_str}
          selectable="single"
          initialSort={{ key: "Name_str", dir: "asc" }}
          searchPlaceholder="Filter options"
          maxHeight={460}
          rowTone={(r) => (r.Value_u32 ? undefined : "dim")}
          empty={{ title: "No options", description: "The server didn’t report any default options." }}
          columns={[
            { key: "Name_str", title: "Option", width: 290, mono: true, truncate: true },
            { key: "Value_u32", title: "Default", align: "right", width: 90, render: (r) => <span className={r.Value_u32 ? "sem-strong sem-num" : "sem-num"}>{num(r.Value_u32)}</span> },
            { key: "Descrption_utf", title: "Description", wrap: true, render: (r) => <span className="sem-dim">{r.Descrption_utf}</span> },
          ]}
        />
      )}
    </Section>
  );
}

export default function ServerSettingsPage() {
  const { serverId } = useScope();
  const { s, reachable } = useReachable(serverId);
  const enabled = !!s && reachable;
  return (
    <>
      <PageHeader title="Server Settings" description="Keep-alive, syslog forwarding and the defaults that new Virtual Hubs start with." />
      {s && !reachable ? <Unreachable serverId={serverId} /> : (
        <>
          <KeepAliveSection serverId={serverId} enabled={enabled} />
          <SyslogSection serverId={serverId} enabled={enabled} />
          <AdminMessageSection serverId={serverId} enabled={enabled} />
          <DefaultAdminOptionsSection serverId={serverId} enabled={enabled} />
        </>
      )}
    </>
  );
}
