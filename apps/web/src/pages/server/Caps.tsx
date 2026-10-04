import { useMemo, useState } from "react";
import { Badge, Button, Group, SegmentedControl, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconDownload, IconRefresh, IconX } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ErrorAlert, PageHeader, QueryState } from "../../components/common";
import { useCaps, useScope, useServer } from "../../lib/hooks";
import { downloadText, num } from "../../lib/format";

interface CapRow { idx: number; name: string; value: number; desc: string; kind: "bool" | "int" | "other"; label: string }

const ACRONYMS: Record<string, string> = {
  ipsec: "IPsec", sstp: "SSTP", openvpn: "OpenVPN", ddns: "DDNS", qos: "QoS", radius: "RADIUS", crl: "CRL", ac: "AC", acl: "ACL",
  ipv6: "IPv6", vlan: "VLAN", l3: "L3", sw: "switch", if: "interface", udp: "UDP", aes: "AES", ni: "NI", vm: "VM", mac: "MAC", ip: "IP",
  tcp: "TCP", url: "URL", msg: "message", rw: "read/write", eth: "Ethernet", secnat: "SecureNAT", securenat: "SecureNAT", vpn3: "VPN 3", vpn4: "VPN 4",
  tap: "TAP", pcap: "pcap", nat: "NAT", dhcp: "DHCP", cert: "certificate", ex: "extended", max: "Max", lb: "local bridge", wg: "WireGuard",
};

function readable(name: string): string {
  const words = name.replace(/^(b|i)_/, "").replace(/suppport/, "support").split("_").filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w);
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const UNLIMITED = 0xffffffff;

export default function CapsPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const caps = useCaps(serverId);
  const [filter, setFilter] = useState("all");

  const rows = useMemo<CapRow[]>(() => {
    const seen = new Set<string>();
    const out: CapRow[] = [];
    (caps.data?.CapsList ?? []).forEach((c, idx) => {
      const x = c as { CapsName_str: string; CapsValue_u32: number; CapsDescrption_utf?: string };
      if (seen.has(x.CapsName_str)) return; // the server reports a few caps twice
      seen.add(x.CapsName_str);
      const kind = x.CapsName_str.startsWith("b_") ? "bool" : x.CapsName_str.startsWith("i_") ? "int" : "other";
      out.push({ idx, name: x.CapsName_str, value: x.CapsValue_u32, desc: x.CapsDescrption_utf ?? "", kind, label: readable(x.CapsName_str) });
    });
    return out;
  }, [caps.data]);

  const shown = rows.filter((r) =>
    filter === "all" ? true : filter === "yes" ? r.kind === "bool" && r.value !== 0 : filter === "no" ? r.kind === "bool" && r.value === 0 : r.kind !== "bool");
  const counts = { yes: rows.filter((r) => r.kind === "bool" && r.value).length, no: rows.filter((r) => r.kind === "bool" && !r.value).length, lim: rows.filter((r) => r.kind !== "bool").length };

  const exportCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = ["name,value,description", ...rows.map((r) => [r.name, String(r.value), esc(r.desc)].join(","))].join("\n");
    downloadText(`caps-${server.data?.name ?? serverId}.csv`, csv, "text/csv");
  };

  return (
    <>
      <PageHeader
        title="Capabilities"
        description="Functions and limits reported by the VPN server (GetCaps). They vary by edition, version and operating mode (standalone / cluster / bridge). Boolean capabilities start with b_, numeric limits with i_."
        actions={
          <>
            <Button variant="default" leftSection={<IconDownload size={16} />} onClick={exportCsv} disabled={!rows.length} data-testid="caps-export">Export CSV</Button>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => caps.refetch()} loading={caps.isFetching}>Refresh</Button>
          </>
        }
      />
      {caps.error ? <ErrorAlert error={caps.error} /> : (
        <QueryState query={caps}>
          <DataTable
            testId="caps-table"
            data={shown}
            rowKey={(r) => r.name}
            initialSort={{ key: "name", dir: "asc" }}
            toolbar={
              <SegmentedControl size="xs" value={filter} onChange={setFilter} aria-label="Capability filter" data={[
                { value: "all", label: `All (${rows.length})` },
                { value: "yes", label: `Supported (${counts.yes})` },
                { value: "no", label: `Not supported (${counts.no})` },
                { value: "lim", label: `Limits (${counts.lim})` },
              ]} />
            }
            columns={[
              {
                key: "label", title: "Capability",
                render: (r) => (
                  <div>
                    <Text size="sm" fw={600}>{r.label}</Text>
                    <Text size="xs" c="dimmed" ff="monospace">{r.name}</Text>
                  </div>
                ),
              },
              { key: "desc", title: "Description", render: (r) => <Text size="sm">{r.desc || "–"}</Text> },
              { key: "kind", title: "Type", value: (r) => r.kind, render: (r) => <Badge variant="outline" color="gray" size="sm">{r.kind === "bool" ? "flag" : "limit"}</Badge> },
              {
                key: "value", title: "Value", align: "right", value: (r) => r.value,
                render: (r) => r.kind === "bool"
                  ? <Group justify="flex-end"><Badge color={r.value ? "green" : "gray"} variant="light" leftSection={r.value ? <IconCheck size={12} /> : <IconX size={12} />}>{r.value ? "Yes" : "No"}</Badge></Group>
                  : r.value === UNLIMITED ? <Tooltip label={num(r.value)}><Text size="sm" fw={600}>Unlimited</Text></Tooltip>
                  : <Text size="sm" fw={600} ff="monospace">{num(r.value)}</Text>,
              },
            ]}
          />
        </QueryState>
      )}
    </>
  );
}
