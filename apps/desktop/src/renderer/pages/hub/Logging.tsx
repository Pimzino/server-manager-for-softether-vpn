// Hub › Logging. Security log and packet log settings of a Virtual Hub (GetHubLog / SetHubLog), with the
// per-packet-type save level. Ported from apps/web/src/pages/hub/Logging.tsx.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, SegmentedControl, Select, Switch } from "@mantine/core";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { serverBase } from "../../sections";
import { useEnumOptions } from "../../components/domain/hooks";
import { Callout, SaveBar } from "../../components/domain/ui";
import { DataTable, FormRow, FormSection, PageHeader, PropertySkeleton, QueryState, Section, SectionGrid } from "../../design";
import { HubUnreachable, sameJson, useHubPage } from "./_hub-core/shared";

interface HubLog {
  HubName_str?: string;
  SaveSecurityLog_bool: boolean;
  SecurityLogSwitchType_u32: number;
  SavePacketLog_bool: boolean;
  PacketLogSwitchType_u32: number;
  PacketLogConfig_u32: number[];
  [k: string]: unknown;
}

const SWITCH_FALLBACK = [
  { value: 0, label: "Never (one file)" },
  { value: 1, label: "Every second" },
  { value: 2, label: "Every minute" },
  { value: 3, label: "Every hour" },
  { value: 4, label: "Every day" },
  { value: 5, label: "Every month" },
];

/** VpnRpcPacketLogSettingIndex, with explanations. */
const PACKET_TYPES: { index: number; key: string; label: string; help: string }[] = [
  { index: 0, key: "TcpConnection", label: "TCP connections", help: "TCP SYN, FIN and RST: who connected to what." },
  { index: 1, key: "TcpAll", label: "TCP packets", help: "Every TCP packet. Very large on busy hubs." },
  { index: 2, key: "Dhcp", label: "DHCP", help: "DHCP requests and address assignments." },
  { index: 3, key: "Udp", label: "UDP", help: "UDP packets such as DNS and VoIP." },
  { index: 4, key: "Icmp", label: "ICMP", help: "Ping and other ICMP messages." },
  { index: 5, key: "Ip", label: "Other IP", help: "IP protocols other than TCP, UDP and ICMP." },
  { index: 6, key: "Arp", label: "ARP", help: "Address resolution packets." },
  { index: 7, key: "Ethernet", label: "Ethernet", help: "Ethernet frames that aren’t IP." },
];

const LEVELS = [
  { value: "0", label: "None" },
  { value: "1", label: "Header" },
  { value: "2", label: "All" },
];

/** SoftEther factory default for a new hub. */
const DEFAULT_CONFIG = [1, 0, 1, 0, 0, 0, 0, 0];

const normalize = (arr: number[] | undefined) => Array.from({ length: 16 }, (_, i) => Number(arr?.[i] ?? 0));

export default function HubLoggingPage() {
  const { serverId, hub, hubAdminMode, ready, server } = useHubPage();
  const switchOptions = useEnumOptions("VpnRpcLogSwitchType", SWITCH_FALLBACK);

  const q = useRpc<HubLog>(serverId, "GetHubLog", { HubName_str: hub }, { enabled: ready });
  const initial = useMemo<HubLog | null>(() => q.data ? { ...q.data, PacketLogConfig_u32: normalize(q.data.PacketLogConfig_u32) } : null, [q.data]);
  const [form, setForm] = useState<HubLog | null>(null);
  useEffect(() => setForm(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHubLog", { success: "Logging settings saved" });

  if (!server.data) return null;
  const dirty = !!form && !!initial && !sameJson(form, initial);
  const setLevel = (i: number, v: number) => form && setForm({ ...form, PacketLogConfig_u32: form.PacketLogConfig_u32.map((x, j) => (j === i ? v : x)) });
  const setAll = (vals: number[]) => form && setForm({ ...form, PacketLogConfig_u32: form.PacketLogConfig_u32.map((x, j) => (j < vals.length ? vals[j] : x)) });
  const heavy = !!form?.SavePacketLog_bool && form.PacketLogConfig_u32.slice(0, 8).some((v, i) => v === 2 || (i === 1 && v > 0));

  return (
    <>
      <PageHeader
        title="Logging"
        description={<>
          Security and packet logs the VPN Server writes for this hub, in <span className="sem-mono">security_log/{hub}</span> and{" "}
          <span className="sem-mono">packet_log/{hub}</span>.{!hubAdminMode && <> Browse the files on the server’s <Link to={`${serverBase(serverId)}/logs`}>Logs & Syslog</Link> page.</>}
        </>}
      />
      {!ready ? <HubUnreachable serverId={serverId} /> : (
        <QueryState query={q} skeleton={<PropertySkeleton rows={8} />}>
          {form && (
            <>
              <SectionGrid>
                <FormSection title="Security log" description="Logins, sessions starting and ending, policy violations and other security events.">
                  <FormRow label="Save security log">
                    <Switch checked={form.SaveSecurityLog_bool} aria-label="Save security log" data-testid="log-security-save"
                      onChange={(e) => setForm({ ...form, SaveSecurityLog_bool: e.currentTarget.checked })} />
                  </FormRow>
                  <FormRow label="New file">
                    {(id) => (
                      <Select id={id} w={190} data={switchOptions} value={String(form.SecurityLogSwitchType_u32)} allowDeselect={false}
                        disabled={!form.SaveSecurityLog_bool} data-testid="log-security-switch"
                        onChange={(v) => setForm({ ...form, SecurityLogSwitchType_u32: Number(v ?? 4) })} />
                    )}
                  </FormRow>
                </FormSection>
                <FormSection title="Packet log" description="Headers or full contents of the packets passing through the hub, per packet type.">
                  <FormRow label="Save packet log">
                    <Switch checked={form.SavePacketLog_bool} aria-label="Save packet log" data-testid="log-packet-save"
                      onChange={(e) => setForm({ ...form, SavePacketLog_bool: e.currentTarget.checked })} />
                  </FormRow>
                  <FormRow label="New file">
                    {(id) => (
                      <Select id={id} w={190} data={switchOptions} value={String(form.PacketLogSwitchType_u32)} allowDeselect={false}
                        disabled={!form.SavePacketLog_bool} data-testid="log-packet-switch"
                        onChange={(v) => setForm({ ...form, PacketLogSwitchType_u32: Number(v ?? 4) })} />
                    )}
                  </FormRow>
                </FormSection>
              </SectionGrid>

              <Section
                title="Packet types"
                description="What to save for each type: None saves nothing, Header saves only the packet headers, All saves whole packets."
                actions={<>
                  <Button size="xs" variant="default" onClick={() => setAll(DEFAULT_CONFIG)} data-testid="log-preset-default">Factory Default</Button>
                  <Button size="xs" variant="default" onClick={() => setAll([1, 1, 1, 1, 1, 1, 1, 1])} data-testid="log-preset-headers">All Headers</Button>
                  <Button size="xs" variant="default" onClick={() => setAll([0, 0, 0, 0, 0, 0, 0, 0])} data-testid="log-preset-none">None</Button>
                </>}
              >
                {(!form.SavePacketLog_bool || heavy) && (
                  <div className="sem-callouts" style={{ marginTop: 0, marginBottom: "var(--sem-space-4)" }}>
                    {!form.SavePacketLog_bool && (
                      <Callout tone="gray" testId="packet-log-off">Packet logging is off. These settings apply once you turn it on.</Callout>
                    )}
                    {heavy && (
                      <Callout tone="orange" title="Large logs ahead" testId="packet-log-heavy">
                        Logging every TCP packet or whole packets makes very large files, can slow the hub down and may capture users’ data.
                        Check disk space and your privacy obligations.
                      </Callout>
                    )}
                  </div>
                )}
                <div data-testid="packet-log-table">
                  <DataTable
                    aria-label="Packet types" searchable={false} footer={false} rowKey={(t) => t.key}
                    data={PACKET_TYPES}
                    rowTone={(t) => (!form.SavePacketLog_bool || (form.PacketLogConfig_u32[t.index] ?? 0) === 0 ? "dim" : undefined)}
                    columns={[
                      {
                        key: "label", title: "Type", width: 170, sortable: false,
                        render: (t) => {
                          const changed = (form.PacketLogConfig_u32[t.index] ?? 0) !== (initial?.PacketLogConfig_u32[t.index] ?? 0);
                          return <span className={changed ? "sem-strong" : undefined}>{t.label}{changed && <span className="sem-dim"> · edited</span>}</span>;
                        },
                      },
                      { key: "help", title: "Description", sortable: false, render: (t) => <span className="sem-dim">{t.help}</span> },
                      {
                        key: "level", title: "Save", align: "right", width: 220, sortable: false,
                        render: (t) => {
                          const v = form.PacketLogConfig_u32[t.index] ?? 0;
                          return (
                            <SegmentedControl data={LEVELS} value={String(v)}
                              onChange={(x) => setLevel(t.index, Number(x))} data-testid={`packet-log-${t.key}`} aria-label={`${t.label}: what to save`} />
                          );
                        },
                      },
                    ]}
                  />
                </div>
              </Section>
              <SaveBar dirty={dirty} saving={save.isPending} onReset={() => setForm(initial)}
                onSave={() => save.mutate({ ...form, HubName_str: hub })} testId="log-save" />
            </>
          )}
        </QueryState>
      )}
    </>
  );
}
