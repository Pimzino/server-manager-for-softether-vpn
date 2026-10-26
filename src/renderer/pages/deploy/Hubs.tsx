// Client Deployment › Hub Profiles: every Virtual Hub on every saved connection, with its live client
// connection profile. Double-click opens the hub's Client Deployment page.
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@mantine/core";
import { IconCopy, IconLock, IconPackageExport, IconPalette, IconPlayerPause, IconPlayerPlay, IconServer2, IconStack2, IconTopologyStar } from "@tabler/icons-react";
import { get, put } from "../../lib/api";
import { notifyError, notifySuccess } from "../../lib/hooks";
import { num, plural } from "../../lib/format";
import { deployBase, hubBase, serverBase } from "../../sections";
import { DataTable, Mono, PageHeader, StatusBadge, Tag, useShell } from "../../design";
import type { HubProfile } from "../../components/domain/hubdeploy";
import { invalidateDeploy } from "./_deployment/shared";

const rowKey = (h: HubProfile) => `${h.serverId}/${h.hub}`;
const deployPath = (h: Pick<HubProfile, "serverId" | "hub">) => `${hubBase(h.serverId, h.hub)}/deploy`;

export default function HubProfilesPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const shell = useShell();
  const q = useQuery({ queryKey: ["deploy", "hubs"], queryFn: () => get<HubProfile[]>("/api/deploy/hubs"), refetchInterval: 30_000 });
  const ok = useMemo(() => (q.data ?? []).filter((h) => !h.error), [q.data]);
  const failed = useMemo(() => (q.data ?? []).filter((h) => h.error), [q.data]);
  const servers = new Set(ok.map((h) => h.serverId)).size;
  const enabled = ok.filter((h) => h.enabled).length;

  const setEnabled = async (h: HubProfile, on: boolean) => {
    try {
      await put(`/api/deploy/hubs/${h.serverId}/${encodeURIComponent(h.hub)}`, { ...h.overrides, enabled: on });
      notifySuccess(on ? `Client deployment enabled for ${h.hub}` : `Client deployment disabled for ${h.hub}`);
      void invalidateDeploy(qc);
    } catch (e) {
      notifyError(e, "Couldn’t change the hub profile");
    }
  };

  return (
    <>
      <PageHeader
        title="Hub Profiles"
        meta={q.data ? <>{plural(ok.length, "Virtual Hub")} on {plural(servers, "server")} · {num(enabled)} enabled for deployment</> : undefined}
        description="Every Virtual Hub has a live client profile, and every user in it gets their own. Open a hub to set its endpoint and template, or to build packages."
        actions={<Button variant="default" leftSection={<IconPalette size={14} />} onClick={() => nav(`${deployBase}/templates`)}>Templates & Branding…</Button>}
      />

      {failed.length > 0 && (
        <div className="sem-callouts" data-testid="hub-profiles-failed">
          {failed.map((f) => (
            <div key={f.serverId} className="sem-callout" data-tone={f.locked ? "yellow" : undefined}>
              {f.locked ? <IconLock size={16} stroke={1.7} /> : <IconServer2 size={16} stroke={1.7} />}
              <div className="sem-callout-text">
                <b>{f.serverName}</b> {f.locked ? "is locked, so its hubs aren’t listed." : "couldn’t be listed."}
                <div className="sem-callout-detail">{f.error}</div>
              </div>
              {f.locked
                ? <Button size="xs" variant="default" onClick={() => shell.openUnlock(f.serverId)}>Unlock…</Button>
                : <Button size="xs" variant="default" onClick={() => nav(serverBase(f.serverId))}>Show Server</Button>}
            </div>
          ))}
        </div>
      )}

      <DataTable<HubProfile>
        testId="hub-profiles-table"
        aria-label="Hub profiles"
        data={q.data ? ok : undefined}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        rowKey={rowKey}
        rowTestId={(h) => `hub-profile-${h.serverId}-${h.hub}`}
        selectable="single"
        initialSort={{ key: "serverName", dir: "asc" }}
        onRowOpen={(h) => nav(deployPath(h))}
        rowTone={(h) => (h.enabled ? undefined : "dim")}
        searchable={ok.length > 8}
        empty={{
          title: "No Virtual Hubs",
          description: "Add a connection to a VPN Server. Each of its hubs appears here with a client profile.",
          icon: <IconTopologyStar size={28} stroke={1.4} />,
          action: <Button size="xs" variant="default" onClick={() => shell.openConnection()}>Add Connection…</Button>,
        }}
        contextMenu={(h) => [
          { label: "Open Client Deployment", icon: <IconPackageExport size={14} />, onClick: () => nav(deployPath(h)), testId: "ctx-open-deploy" },
          { label: "Open Virtual Hub", icon: <IconStack2 size={14} />, onClick: () => nav(hubBase(h.serverId, h.hub)) },
          { label: "Copy Endpoint", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(`${h.host}:${h.port}`) },
          "divider",
          h.enabled
            ? { label: "Disable Deployment", icon: <IconPlayerPause size={14} />, onClick: () => void setEnabled(h, false), testId: "ctx-disable" }
            : { label: "Enable Deployment", icon: <IconPlayerPlay size={14} />, onClick: () => void setEnabled(h, true), testId: "ctx-enable" },
        ]}
        columns={[
          { key: "serverName", title: "Server", width: 150, truncate: true, render: (h) => <span className="sem-dim">{h.serverName}</span> },
          { key: "hub", title: "Virtual Hub", width: 150, truncate: true, render: (h) => <span className="sem-strong">{h.hub}</span> },
          { key: "online", title: "Status", width: 88, value: (h) => (h.online ? 1 : 0), render: (h) => <StatusBadge status={h.online ? "ok" : "off"}>{h.online ? "Online" : "Offline"}</StatusBadge> },
          { key: "accountName", title: "Connection name", truncate: true },
          { key: "endpoint", title: "Clients connect to", value: (h) => `${h.host}:${h.port}`, truncate: true, render: (h) => <Mono>{h.host}:{h.port}</Mono> },
          { key: "template", title: "Template", width: 130, value: (h) => h.template?.name, render: (h) => <Tag>{h.template?.name}</Tag> },
          { key: "numUsers", title: "Users", align: "right", width: 64, render: (h) => <span className="sem-num">{num(h.numUsers)}</span> },
          { key: "enabled", title: "Deployment", width: 100, value: (h) => (h.enabled ? 1 : 0),
            render: (h) => <StatusBadge status={h.enabled ? "ok" : "off"}>{h.enabled ? "Enabled" : "Disabled"}</StatusBadge> },
        ]}
      />
    </>
  );
}
