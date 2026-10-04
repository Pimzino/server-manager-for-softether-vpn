// Hub › Status. Live counters of one Virtual Hub (GetHubStatus), with an update-frequency menu, live
// throughput computed between polls, and Take Offline / Bring Online (SetHubOnline).
// Ported from apps/web/src/pages/hub/Status.tsx.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Menu } from "@mantine/core";
import { IconCheck, IconClockHour4, IconPlayerPlay, IconPlayerStop, IconRefresh } from "@tabler/icons-react";
import { notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import { ago, agoShort, bytes, dateShort, dt, isNever, num } from "../../lib/format";
import { HUB_TYPE_LABELS } from "../../components/domain/util";
import {
  ConfirmButton, DataTable, Metric, MetricGrid, MetricSkeleton, PageHeader, PropertyList, PropertySkeleton, QueryState, Section, SectionGrid,
  StatusBadge, Tag,
} from "../../design";
import { HubUnreachable, useHubPage } from "./_hub-core/shared";

interface HubStatus {
  HubName_str: string;
  Online_bool: boolean;
  HubType_u32: number;
  NumSessions_u32: number;
  NumSessionsClient_u32: number;
  NumSessionsBridge_u32: number;
  NumAccessLists_u32: number;
  NumUsers_u32: number;
  NumGroups_u32: number;
  NumMacTables_u32: number;
  NumIpTables_u32: number;
  SecureNATEnabled_bool: boolean;
  LastCommTime_dt: string;
  LastLoginTime_dt: string;
  CreatedTime_dt: string;
  NumLogin_u32: number;
  [k: string]: unknown;
}

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Bytes/second computed from the delta between two consecutive polls. */
function useRates(s: HubStatus | undefined, updatedAt: number) {
  const prev = useRef<{ t: number; rx: number; tx: number } | null>(null);
  const [rate, setRate] = useState<{ rx: number; tx: number } | null>(null);
  useEffect(() => {
    if (!s) return;
    const now = Date.now();
    const rx = n(s["Recv.UnicastBytes_u64"]) + n(s["Recv.BroadcastBytes_u64"]);
    const tx = n(s["Send.UnicastBytes_u64"]) + n(s["Send.BroadcastBytes_u64"]);
    const p = prev.current;
    if (p && now - p.t > 500 && rx >= p.rx && tx >= p.tx) {
      const sec = (now - p.t) / 1000;
      setRate({ rx: (rx - p.rx) / sec, tx: (tx - p.tx) / sec });
    }
    prev.current = { t: now, rx, tx };
  }, [s, updatedAt]);
  return rate;
}

const INTERVALS = [
  { value: 0, label: "Manually", short: "Paused" },
  { value: 5000, label: "Every 5 Seconds", short: "Every 5 s" },
  { value: 15000, label: "Every 15 Seconds", short: "Every 15 s" },
  { value: 60000, label: "Every Minute", short: "Every 60 s" },
];

/** A SoftEther date, or "Never" for its zero date. */
function When({ v }: { v: string | undefined }) {
  if (!v || isNever(v)) return <span className="sem-dim">Never</span>;
  return <span title={dt(v)}>{dateShort(v)} <span className="sem-dim">· {agoShort(v)}</span></span>;
}

export default function HubStatusPage() {
  const { serverId, hub, base, ready, server } = useHubPage();
  const nav = useNavigate();
  const [interval, setIntervalMs] = useState(5000);
  const q = useRpc<HubStatus>(serverId, "GetHubStatus", { HubName_str: hub }, { refetchInterval: interval || false, enabled: ready });
  const s = q.data;
  const rate = useRates(s, q.dataUpdatedAt);
  const setOnline = useRpcMutation<{ HubName_str: string; Online_bool: boolean }>(serverId, "SetHubOnline", {
    success: false, confirm: false,
    onSuccess: (_r, p) => notifySuccess(p.Online_bool ? `“${hub}” is online` : `“${hub}” is offline`),
  });

  if (!server.data) return null;
  const rx = (d: "Recv" | "Send") => ({
    ub: n(s?.[`${d}.UnicastBytes_u64`]), up: n(s?.[`${d}.UnicastCount_u64`]),
    bb: n(s?.[`${d}.BroadcastBytes_u64`]), bp: n(s?.[`${d}.BroadcastCount_u64`]),
  });
  const recv = rx("Recv");
  const send = rx("Send");
  const totalBytes = recv.ub + recv.bb + send.ub + send.bb;
  const totalPk = recv.up + recv.bp + send.up + send.bp;
  // SoftEther sets LastLoginTime to the creation time for a new hub, so it only means something after a login.
  const neverLoggedIn = !s || n(s.NumLogin_u32) === 0 || isNever(s.LastLoginTime_dt);
  const current = INTERVALS.find((i) => i.value === interval) ?? INTERVALS[1];

  const toggle = s && (s.Online_bool ? (
    <ConfirmButton
      title={<>Take “{hub}” offline?</>}
      message="While the Virtual Hub is offline it refuses every VPN connection. All connected sessions (clients, bridges and cascades) are disconnected now."
      confirmLabel="Take Offline"
      tone="warning"
      color="orange"
      leftSection={<IconPlayerStop size={14} />}
      loading={setOnline.isPending}
      onConfirm={() => setOnline.mutateAsync({ HubName_str: hub, Online_bool: false })}
      testId="hub-offline"
    >Take Offline…</ConfirmButton>
  ) : (
    <Button leftSection={<IconPlayerPlay size={14} />} loading={setOnline.isPending} data-testid="hub-online"
      onClick={() => setOnline.mutate({ HubName_str: hub, Online_bool: true })}>Bring Online</Button>
  ));

  return (
    <>
      <PageHeader
        title="Status"
        testId="hub-status-header"
        meta={s ? <>
          <StatusBadge status={s.Online_bool ? "ok" : "off"} testId="hub-status-online">{s.Online_bool ? "Online" : "Offline"}</StatusBadge>
          <span className="sem-dim">·</span><span>{HUB_TYPE_LABELS[s.HubType_u32] ?? `Type ${s.HubType_u32}`} hub</span>
          <span className="sem-dim">·</span>
          {s.SecureNATEnabled_bool ? <Tag color="green">SecureNAT on</Tag> : <span className="sem-dim">SecureNAT off</span>}
        </> : undefined}
        actions={ready && <>
          <Menu position="bottom-end" width={200}>
            <Menu.Target>
              <Button variant="default" leftSection={<IconClockHour4 size={14} />} data-testid="status-refresh-interval" aria-label="Update frequency">
                {current.short}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Update Frequency</Menu.Label>
              {INTERVALS.map((i) => (
                <Menu.Item key={i.value} onClick={() => setIntervalMs(i.value)} data-testid={`status-interval-${i.value}`}
                  leftSection={<IconCheck size={14} style={{ visibility: i.value === interval ? "visible" : "hidden" }} />}>
                  {i.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Button variant="default" leftSection={<IconRefresh size={14} className={q.isFetching ? "sem-spin" : undefined} />}
            onClick={() => void q.refetch()} data-testid="status-refresh">Refresh</Button>
          {toggle}
        </>}
      />

      {!ready ? <HubUnreachable serverId={serverId} /> : (
        <QueryState query={q} skeleton={<><MetricSkeleton count={5} /><PropertySkeleton rows={8} /></>}>
          {s && (
            <>
              <MetricGrid testId="hub-status-stats" min={128}>
                <Metric testId="stat-sessions" label="Sessions" value={num(s.NumSessions_u32)}
                  hint={`${num(s.NumSessionsClient_u32)} client · ${num(s.NumSessionsBridge_u32)} bridge`} onClick={() => nav(`${base}/sessions`)} />
                <Metric testId="stat-users" label="Users" value={num(s.NumUsers_u32)} hint={`${num(s.NumGroups_u32)} ${s.NumGroups_u32 === 1 ? "group" : "groups"}`}
                  onClick={() => nav(`${base}/users`)} />
                <Metric testId="stat-tables" label="MAC / IP entries" value={`${num(s.NumMacTables_u32)} / ${num(s.NumIpTables_u32)}`} hint="Learned addresses"
                  onClick={() => nav(`${base}/tables`)} />
                <Metric testId="stat-logins" label="Logins" value={num(s.NumLogin_u32)}
                  hint={neverLoggedIn ? "None yet" : `Last ${ago(s.LastLoginTime_dt)}`} />
                <Metric testId="stat-throughput" label="Throughput ↓ / ↑"
                  value={rate ? <span className="sem-num">{bytes(rate.rx)}/s</span> : "–"}
                  hint={rate ? `${bytes(rate.tx)}/s sent` : interval ? "Measuring…" : "Paused"} />
              </MetricGrid>

              <SectionGrid>
                <Section title="Virtual Hub" variant="inset" testId="hub-status-summary">
                  <PropertyList labelWidth={150} items={[
                    { label: "Status", value: <StatusBadge status={s.Online_bool ? "ok" : "off"}>{s.Online_bool ? "Online" : "Offline"}</StatusBadge> },
                    { label: "Type", value: HUB_TYPE_LABELS[s.HubType_u32] ?? String(s.HubType_u32) },
                    { label: "SecureNAT", value: <Link to={`${base}/securenat`} data-testid="status-link-securenat">{s.SecureNATEnabled_bool ? "Enabled" : "Disabled"}</Link> },
                    { label: "Created", value: <When v={s.CreatedTime_dt} /> },
                    { label: "Last login", value: <When v={neverLoggedIn ? undefined : s.LastLoginTime_dt} /> },
                    { label: "Last communication", value: <When v={s.LastCommTime_dt} /> },
                  ]} />
                </Section>
                <Section title="Objects" variant="inset" testId="hub-status-objects">
                  <PropertyList labelWidth={150} items={[
                    { label: "Sessions", value: <span className="sem-num">{num(s.NumSessions_u32)} <span className="sem-dim">({num(s.NumSessionsClient_u32)} client, {num(s.NumSessionsBridge_u32)} bridge)</span></span> },
                    { label: "Users", value: <span className="sem-num">{num(s.NumUsers_u32)}</span> },
                    { label: "Groups", value: <Link to={`${base}/groups`} className="sem-num" data-testid="status-link-groups">{num(s.NumGroups_u32)}</Link> },
                    { label: "Access list entries", value: <Link to={`${base}/access`} className="sem-num" data-testid="status-link-access">{num(s.NumAccessLists_u32)}</Link> },
                    { label: "MAC table entries", value: <span className="sem-num">{num(s.NumMacTables_u32)}</span> },
                    { label: "IP table entries", value: <span className="sem-num">{num(s.NumIpTables_u32)}</span> },
                  ]} />
                </Section>
              </SectionGrid>

              <Section
                title="Traffic"
                description={<>Since the hub started: received means from VPN sessions into the hub, sent means from the hub to sessions. Total {bytes(totalBytes)} in {num(totalPk)} packets.</>}
              >
                <DataTable
                  testId="hub-traffic-table" aria-label="Traffic" searchable={false} footer={false} rowKey={(r) => r.dir}
                  data={[{ dir: "Received", ...recv }, { dir: "Sent", ...send }]}
                  columns={[
                    { key: "dir", title: "Direction", sortable: false, render: (r) => <span className="sem-strong">{r.dir}</span> },
                    { key: "ub", title: "Unicast", align: "right", sortable: false, render: (r) => <span className="sem-num">{bytes(r.ub)} <span className="sem-dim">· {num(r.up)} pkts</span></span> },
                    { key: "bb", title: "Broadcast", align: "right", sortable: false, render: (r) => <span className="sem-num">{bytes(r.bb)} <span className="sem-dim">· {num(r.bp)} pkts</span></span> },
                    { key: "total", title: "Total", align: "right", sortable: false, render: (r) => <span className="sem-num"><span className="sem-strong">{bytes(r.ub + r.bb)}</span> <span className="sem-dim">· {num(r.up + r.bp)} pkts</span></span> },
                  ]}
                />
              </Section>
            </>
          )}
        </QueryState>
      )}
    </>
  );
}
