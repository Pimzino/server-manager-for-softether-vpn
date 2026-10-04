import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, Badge, Code, Text } from "@mantine/core";
import { DataTable } from "../../components/DataTable";
import { OnlineBadge, PageHeader, QueryState } from "../../components/common";
import { get } from "../../lib/api";
import type { HubProfile } from "../../components/deploy/hubdeploy";

/** Every hub on every managed server, with its live client connection profile. */
export default function HubProfilesPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["deploy", "hubs"], queryFn: () => get<HubProfile[]>("/api/deploy/hubs"), refetchInterval: 30_000 });
  const ok = (q.data ?? []).filter((h) => !h.error);
  const failed = (q.data ?? []).filter((h) => h.error);
  return (
    <>
      <PageHeader title="Hub profiles"
        description="Every Virtual Hub automatically has a client connection profile, and every user in it has their own. Open a hub to set its template and public address, preview profiles and build .vpn files, MSIs or setup.exe packages for users." />
      {failed.map((f) => <Alert key={f.serverId} color="red" mb="sm" title={f.serverName}>{f.error}</Alert>)}
      <QueryState query={q}>
        <DataTable<HubProfile>
          testId="hub-profiles-table"
          data={ok}
          rowKey={(h) => `${h.serverId}/${h.hub}`}
          onRowClick={(h) => nav(`/servers/${h.serverId}/hubs/${encodeURIComponent(h.hub)}/deploy`)}
          initialSort={{ key: "serverName", dir: "asc" }}
          columns={[
            { key: "serverName", title: "Server" },
            { key: "hub", title: "Hub", render: (h) => <Text fw={600} size="sm">{h.hub}</Text> },
            { key: "online", title: "Status", render: (h) => <OnlineBadge online={h.online} /> },
            { key: "accountName", title: "Connection name" },
            { key: "endpoint", title: "Clients connect to", value: (h) => `${h.host}:${h.port}`, render: (h) => <Code>{h.host}:{h.port}</Code> },
            { key: "template", title: "Template", value: (h) => h.template.name, render: (h) => <Badge variant="light">{h.template.name}</Badge> },
            { key: "numUsers", title: "Users", align: "right" },
            { key: "enabled", title: "Deployment", render: (h) => h.enabled ? <Badge color="green" variant="light">enabled</Badge> : <Badge color="gray" variant="light">disabled</Badge> },
          ]}
        />
      </QueryState>
    </>
  );
}
